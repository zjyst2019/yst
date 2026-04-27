// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const db = require('./db/database');
const claudeService = require('./services/claude');
const apiRoutes = require('./routes/api');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Load system prompt at startup (CLAUDE.md for knowledge base context)
const systemPromptPath = process.env.SYSTEM_PROMPT_FILE;
if (systemPromptPath) {
    claudeService.loadSystemPrompt(systemPromptPath);
} else {
    // Try default path
    claudeService.loadSystemPrompt('./CLAUDE.md');
}

// Configure Claude mode and working directory
console.log(`Claude mode: ${claudeService.getMode()}`);
if (claudeService.getSystemPrompt()) {
    console.log(`System prompt: loaded (${claudeService.getSystemPrompt().length} characters)`);
} else {
    console.log(`System prompt: not loaded (no CLAUDE.md found)`);
}
if (process.env.ANTHROPIC_BASE_URL) {
    console.log(`Claude API endpoint: ${process.env.ANTHROPIC_BASE_URL} (private gateway)`);
} else {
    console.log(`Claude API endpoint: https://api.anthropic.com (official)`);
}
if (process.env.CLAUDE_MODEL) {
    console.log(`Claude model: ${process.env.CLAUDE_MODEL}`);
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// REST API
app.use('/api', apiRoutes);

// WebSocket handling
wss.on('connection', (ws) => {
    let currentSessionId = null;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            switch (msg.type) {
                case 'join':
                    // Join or create session
                    currentSessionId = msg.session_id;
                    if (!db.getSession(currentSessionId)) {
                        db.createSession(currentSessionId);
                    }
                    db.updateLastActive(currentSessionId);
                    ws.send(JSON.stringify({ type: 'joined', session_id: currentSessionId }));
                    break;

                case 'chat':
                    if (!currentSessionId) {
                        ws.send(JSON.stringify({ type: 'error', message: 'No session joined' }));
                        return;
                    }

                    // Store user message
                    db.addMessage(currentSessionId, 'user', msg.content);
                    db.updateLastActive(currentSessionId);

                    // Get history messages for context
                    const historyMessages = db.getRecentMessages(currentSessionId, 5);

                    // Execute Claude with history context
                    claudeService.executeClaude(
                        currentSessionId,
                        msg.content,
                        historyMessages,  // Pass history for context
                        // onStream
                        (chunk) => {
                            ws.send(JSON.stringify({ type: 'stream', content: chunk }));
                        },
                        // onComplete
                        (fullContent) => {
                            db.addMessage(currentSessionId, 'assistant', fullContent);
                            ws.send(JSON.stringify({ type: 'complete', content: fullContent }));
                        },
                        // onError
                        (error) => {
                            ws.send(JSON.stringify({ type: 'error', message: error }));
                        }
                    );
                    break;

                case 'clear':
                    // Clear conversation history
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
        // Stop any active process when connection closes
        if (currentSessionId) {
            claudeService.stopClaude(currentSessionId);
        }
    });

    // Send welcome message
    ws.send(JSON.stringify({ type: 'connected' }));
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});