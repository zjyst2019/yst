// server.js — Load .env before everything
require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const db = require('./db/database');
const claudeService = require('./services/claude');
const qaCache = require('./services/qaCache');
const knowledgeIngest = require('./services/knowledgeIngest');
const apiRoutes = require('./routes/api');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Track WebSocket connections per sessionId (multiple tabs can share a sessionId via localStorage)
const sessionConnections = new Map(); // sessionId → Set<WebSocket>
// Track which WebSocket connection initiated the current chat request per sessionId
const requestInitiators = new Map(); // sessionId → WebSocket

// Initialize QA cache (async)
(async () => {
    await qaCache.init(claudeService.getWorkDir());
})();

// Ensure upload directories exist with consistent ownership
const workDir = claudeService.getWorkDir();
const uploadDir = process.env.KNOWLEDGE_UPLOAD_DIR || path.join(workDir, 'upload');
[uploadDir, path.join(uploadDir, 'processed'), path.join(uploadDir, 'failed')].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});
// If running as root with CLAUDE_RUN_USER, chown for consistency
const runAsUser = process.env.CLAUDE_RUN_USER;
if (runAsUser && process.getuid && process.getuid() === 0) {
    try {
        const uid = require('child_process').execSync(`id -u ${runAsUser}`).toString().trim();
        const gid = require('child_process').execSync(`id -g ${runAsUser}`).toString().trim();
        [uploadDir, path.join(uploadDir, 'processed'), path.join(uploadDir, 'failed')].forEach(dir => {
            if (fs.existsSync(dir)) fs.chownSync(dir, parseInt(uid), parseInt(gid));
        });
    } catch (e) {
        console.log('Could not set upload directory ownership:', e.message);
    }
}

// Periodically check knowledge base updates (every 5 minutes)
setInterval(() => {
    const { hasUpdate, updatedFiles } = qaCache.checkKnowledgeBaseUpdate();
    if (hasUpdate) {
        console.log('Knowledge base updated, clearing related cache:', updatedFiles);
        qaCache.clearCacheByFiles(updatedFiles);
    }
}, 5 * 60 * 1000);

// Load system prompt at startup (CLAUDE.md for knowledge base context)
const systemPromptPath = process.env.SYSTEM_PROMPT_FILE;
if (systemPromptPath) {
    claudeService.loadSystemPrompt(systemPromptPath);
} else {
    // Try default path
    claudeService.loadSystemPrompt('./CLAUDE.md');
}

// Configure working directory
console.log('Claude mode: CLI');
if (claudeService.getSystemPrompt()) {
    console.log(`System prompt: loaded (${claudeService.getSystemPrompt().length} characters)`);
} else {
    console.log(`System prompt: not loaded (no CLAUDE.md found)`);
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// REST API
app.use('/api', apiRoutes);

// WebSocket handling
wss.on('connection', (ws) => {
    let currentSessionId = null;
    let userConfig = null;  // User-specific API config

    // Per-connection supplement context (question being supplemented)
    let supplementQuestion = null;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            console.log(`[${currentSessionId || 'new'}] Received message type: ${msg.type}`);

            switch (msg.type) {
                case 'join':
                    // Remove from previous session's connection set if re-joining with different ID
                    if (currentSessionId && currentSessionId !== msg.session_id) {
                        const prev = sessionConnections.get(currentSessionId);
                        if (prev) {
                            prev.delete(ws);
                            if (prev.size === 0) {
                                sessionConnections.delete(currentSessionId);
                            }
                        }
                    }

                    // Join or create session
                    currentSessionId = msg.session_id;

                    // Track this connection in the session's connection set
                    if (!sessionConnections.has(currentSessionId)) {
                        sessionConnections.set(currentSessionId, new Set());
                    }
                    sessionConnections.get(currentSessionId).add(ws);

                    if (!db.getSession(currentSessionId)) {
                        db.createSession(currentSessionId);
                    }
                    db.updateLastActive(currentSessionId);

                    // Store user config if provided
                    if (msg.config) {
                        userConfig = msg.config;
                        console.log(`User config received for session ${currentSessionId}:`);
                        console.log(`  API Key: ${userConfig.apiKey ? 'provided' : 'missing'}`);
                        console.log(`  Base URL: ${userConfig.baseUrl}`);
                        console.log(`  Model: ${userConfig.model}`);
                    }

                    ws.send(JSON.stringify({ type: 'joined', session_id: currentSessionId }));
                    break;

                case 'supplement_start':
                    // User clicked "补充知识": save the question being supplemented
                    supplementQuestion = msg.question || '';
                    console.log(`[Supplement] Started for: "${supplementQuestion.substring(0, 50)}..."`);
                    break;

                case 'supplement_knowledge':
                    // User provided correct knowledge: save to improve/ then ingest per CLAUDE.md
                    if (msg.question && msg.correctContent) {
                        (async () => {
                            try {
                                const workDir = claudeService.getWorkDir();
                                const improveDir = path.join(workDir, 'improve');

                                // Parse structured content: extract knowledge and requirements
                                const content = msg.correctContent;
                                let knowledgeContent, requirement;

                                const knowledgeMatch = content.match(/需要补充的知识：([\s\S]*?)(?:摄入知识的要求：|$)/);
                                const requirementMatch = content.match(/摄入知识的要求：([\s\S]*)/);

                                if (knowledgeMatch || requirementMatch) {
                                    // Template was (partially) followed — parse directly
                                    knowledgeContent = knowledgeMatch ? knowledgeMatch[1].trim() : content.trim();
                                    requirement = requirementMatch ? requirementMatch[1].trim() : '';
                                    console.log(`[Supplement] Template detected, parsed directly`);
                                } else {
                                    // No template markers — use AI to separate knowledge from instructions
                                    console.log('[Supplement] No template markers found, using AI to analyze...');
                                    const analyzed = await knowledgeIngest.analyzeContent(content, userConfig);
                                    knowledgeContent = analyzed.knowledgeContent;
                                    requirement = analyzed.requirement;
                                    console.log(`[Supplement] AI analysis done: knowledge=${knowledgeContent.substring(0, 60)}... req=${requirement.substring(0, 60)}...`);
                                }

                                console.log(`[Supplement] Knowledge: ${knowledgeContent.substring(0, 100)}...`);
                                if (requirement) {
                                    console.log(`[Supplement] Requirement: ${requirement.substring(0, 100)}...`);
                                }

                                // Step 1: Save raw content to improve/ folder
                                if (!fs.existsSync(improveDir)) {
                                    fs.mkdirSync(improveDir, { recursive: true });
                                }
                                const slug = msg.question.substring(0, 50).replace(/[^a-zA-Z0-9一-鿿_-]/g, '_');
                                const mdPath = path.join(improveDir, `${slug}.md`);
                                fs.writeFileSync(mdPath, content, 'utf-8');
                                console.log(`[Supplement] Raw saved to: ${mdPath}`);

                                // Step 2: Ingest to knowledge base with separate knowledge + requirement
                                console.log('[Supplement] Ingesting per CLAUDE.md rules...');
                                await knowledgeIngest.ingest(msg.question, knowledgeContent, userConfig, requirement);

                                supplementQuestion = null;
                                ws.send(JSON.stringify({ type: 'supplement_done' }));
                                console.log(`[Supplement] Complete: saved to improve/ + ingested`);
                            } catch (err) {
                                console.error('[Supplement] Error:', err);
                                try { ws.send(JSON.stringify({ type: 'error', message: '补充知识失败' })); } catch (_) {}
                            }
                        })();
                    }
                    break;

                case 'chat':
                    if (!currentSessionId) {
                        ws.send(JSON.stringify({ type: 'error', message: 'No session joined' }));
                        return;
                    }

                    // Check if user config is provided
                    if (!userConfig || !userConfig.apiKey) {
                        ws.send(JSON.stringify({ type: 'error', message: '请先配置 API Key' }));
                        return;
                    }

                    // Update config if provided in message
                    if (msg.config) {
                        userConfig = msg.config;
                    }

                    // Check cache first (async for embedding)
                    (async () => {
                        try {
                            const cachedAnswer = await qaCache.findSimilarCache(msg.content);
                            if (cachedAnswer) {
                                console.log(`Cache hit! Similarity: ${cachedAnswer.score.toFixed(2)}`);
                                db.addMessage(currentSessionId, 'user', msg.content);
                                db.addMessage(currentSessionId, 'assistant', cachedAnswer.answer);
                                ws.send(JSON.stringify({ type: 'stream', content: cachedAnswer.answer }));
                                ws.send(JSON.stringify({ type: 'complete', content: cachedAnswer.answer, cached: true }));
                                return;
                            }

                            // Store user message
                            db.addMessage(currentSessionId, 'user', msg.content);
                            db.updateLastActive(currentSessionId);

                            // Get history messages for context
                            const historyMessages = db.getRecentMessages(currentSessionId, 5);
                            const currentQuestion = msg.content; // Save question for later

                            // Record this connection as the initiator of this session's request
                            requestInitiators.set(currentSessionId, ws);

                            // Execute Claude with user's config
                            claudeService.executeClaude(
                                currentSessionId,
                                msg.content,
                                historyMessages,
                                userConfig,
                                // onStream
                                (chunk) => {
                                    ws.send(JSON.stringify({ type: 'stream', content: chunk }));
                                },
                                // onComplete - check answer similarity
                                (fullContent) => {
                                    requestInitiators.delete(currentSessionId);
                                    db.addMessage(currentSessionId, 'assistant', fullContent);

                                    // Always send complete first, then check similarity in background
                                    ws.send(JSON.stringify({
                                        type: 'complete',
                                        content: fullContent,
                                        cached: false,
                                        needCache: true
                                    }));

                                    // Check answer similarity (async, non-blocking)
                                    (async () => {
                                    try {
                                        const answerEmbedding = await qaCache.getAnswerEmbedding(fullContent);
                                        const similarAnswer = await qaCache.findSimilarAnswer(answerEmbedding);

                                        if (similarAnswer && similarAnswer.answerScore >= 0.95) {
                                            // Auto-link: answer >= 95% similarity
                                            const questionEmbedding = await qaCache.getEmbedding(currentQuestion);
                                            await qaCache.linkQuestion(similarAnswer.key, currentQuestion, questionEmbedding);
                                            ws.send(JSON.stringify({
                                                type: 'cache_status',
                                                autoLinked: true,
                                                answerSimilarity: similarAnswer.answerScore.toFixed(4)
                                            }));
                                            console.log(`[Auto Link] Answer similarity: ${similarAnswer.answerScore.toFixed(4)}`);
                                        } else if (similarAnswer && similarAnswer.answerScore >= 0.90) {
                                            // Need merge: answer 90%-95% similarity
                                            ws.send(JSON.stringify({
                                                type: 'cache_status',
                                                needMerge: true,
                                                mergeKey: similarAnswer.key,
                                                mergeAnswer: similarAnswer.answer,
                                                answerSimilarity: similarAnswer.answerScore.toFixed(4)
                                            }));
                                            console.log(`[Need Merge] Answer similarity: ${similarAnswer.answerScore.toFixed(4)}, waiting for user confirmation`);
                                        }
                                    } catch (e) {
                                        console.error('[Embedding Check] Error:', e.message);
                                    }
                                })();
                            },
                            // onError
                            (error) => {
                                requestInitiators.delete(currentSessionId);
                                ws.send(JSON.stringify({ type: 'error', message: error }));
                            }
                        );
                        } catch (err) {
                            console.error('[Chat] Error:', err);
                            try { ws.send(JSON.stringify({ type: 'error', message: '处理请求时发生错误' })); } catch (_) {}
                        }
                    })().catch(err => {
                        console.error('[Chat] Async error:', err);
                        try { ws.send(JSON.stringify({ type: 'error', message: '处理请求时发生错误' })); } catch (_) {}
                    });
                    break;

                case 'save_cache':
                    // User confirmed satisfied, save new cache entry
                    if (msg.question && msg.answer) {
                        (async () => {
                            try {
                                await qaCache.setCache(msg.question, msg.answer);
                                ws.send(JSON.stringify({ type: 'cache_saved' }));
                                console.log(`QA saved to cache: ${msg.question.substring(0, 50)}...`);
                            } catch (err) {
                                console.error('[SaveCache] Error:', err);
                                try { ws.send(JSON.stringify({ type: 'error', message: '保存缓存失败' })); } catch (_) {}
                            }
                        })();
                    }
                    break;

                case 'merge_cache':
                    // User confirmed satisfied, merge with existing cache
                    if (msg.key && msg.question && msg.newAnswer) {
                        (async () => {
                            try {
                                const entry = qaCache.getEntry(msg.key);
                                if (entry) {
                                    // Merge answers using LLM
                                    console.log(`[Merge] Calling LLM to merge answers...`);
                                    const mergedAnswer = await qaCache.mergeAnswers(entry.answer, msg.newAnswer, userConfig);

                                    // Update cache
                                    const questionEmbedding = await qaCache.getEmbedding(msg.question);
                                    const answerEmbedding = await qaCache.getAnswerEmbedding(mergedAnswer);
                                    await qaCache.updateMergedAnswer(msg.key, msg.question, mergedAnswer, questionEmbedding, answerEmbedding);

                                    ws.send(JSON.stringify({
                                        type: 'cache_merged',
                                        mergedAnswer: mergedAnswer.substring(0, 100) + '...'
                                    }));
                                    console.log(`[Merge Complete] Answer merged for "${msg.question.substring(0, 30)}..."`);
                                } else {
                                    ws.send(JSON.stringify({ type: 'error', message: 'Cache entry not found' }));
                                }
                            } catch (err) {
                                console.error('[MergeCache] Error:', err);
                                try { ws.send(JSON.stringify({ type: 'error', message: '合并缓存失败' })); } catch (_) {}
                            }
                        })();
                    }
                    break;

                case 'clear':
                    if (currentSessionId) {
                        db.clearSessionMessages(currentSessionId);
                        ws.send(JSON.stringify({ type: 'cleared' }));
                    }
                    break;

                case 'stop':
                    if (currentSessionId && claudeService.stopClaude(currentSessionId)) {
                        ws.send(JSON.stringify({ type: 'stopped' }));
                    }
                    break;
            }
        } catch (e) {
            console.error('WebSocket message error:', e);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
    });

    ws.on('close', () => {
        if (currentSessionId) {
            // If this connection initiated the active chat, kill it immediately
            // (streaming output only goes to the initiator — no point continuing)
            if (requestInitiators.get(currentSessionId) === ws) {
                requestInitiators.delete(currentSessionId);
                claudeService.stopClaude(currentSessionId);
            }

            // Clean up session connection tracking
            const connections = sessionConnections.get(currentSessionId);
            if (connections) {
                connections.delete(ws);
                if (connections.size === 0) {
                    sessionConnections.delete(currentSessionId);
                }
            }
        }
    });

    // Send welcome message
    ws.send(JSON.stringify({ type: 'connected' }));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
});

// Flush QA cache to disk on graceful shutdown
const shutdown = () => {
    console.log('Shutting down, flushing cache...');
    qaCache.flushSave();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);