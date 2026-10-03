// services/qaCache.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Ollama embedding configuration
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'qwen3-embedding:0.6b';
const USE_EMBEDDING = process.env.USE_EMBEDDING === 'true';

// Answer similarity thresholds (configurable via env)
const ANSWER_SIMILARITY_HIGH = parseFloat(process.env.CACHE_ANSWER_HIGH) || 0.95;
const ANSWER_SIMILARITY_MERGE = parseFloat(process.env.CACHE_ANSWER_MERGE) || 0.90;
const ANSWER_HEAD_LEN = parseInt(process.env.CACHE_ANSWER_HEAD_LEN) || 250;
const ANSWER_TAIL_LEN = parseInt(process.env.CACHE_ANSWER_TAIL_LEN) || 250;

// Embedding LRU cache to avoid duplicate Ollama HTTP calls
const EMBEDDING_CACHE_MAX = parseInt(process.env.CACHE_EMBEDDING_LRU_SIZE) || 200;
// Disk write debounce delay (ms)
const SAVE_DEBOUNCE_MS = parseInt(process.env.CACHE_SAVE_DEBOUNCE_MS) || 500;

class QACache {
    constructor() {
        this.cache = new Map();
        this.fileHashes = new Map();
        this.SIMILARITY_THRESHOLD = parseFloat(process.env.CACHE_QUESTION_SIMILARITY) || 0.88;
        this.MAX_CACHE_SIZE = parseInt(process.env.CACHE_MAX_SIZE) || 500;
        this.cachePath = null;
        this.ollamaAvailable = false;

        // Embedding LRU cache: textHash → { embedding, timestamp }
        // Avoids duplicate Ollama HTTP calls within a session
        this.embeddingCache = new Map();

        // Debounced disk write state
        this._saveTimer = null;
        this._savePending = false;
    }

    async init(workDir) {
        this.workDir = workDir || process.env.CLAUDE_WORK_DIR || process.cwd();
        this.cachePath = path.join(this.workDir, '.qa_cache.json');
        this.scanKnowledgeBase();
        this.loadCacheFromDisk();

        if (USE_EMBEDDING) {
            await this.checkOllama();
        }

        console.log(`QA Cache initialized: ${this.cache.size} cached entries`);
        console.log(`Embedding mode: ${USE_EMBEDDING ? (this.ollamaAvailable ? 'enabled (Ollama)' : 'fallback to keywords') : 'disabled (keywords only)'}`);
    }

    async checkOllama() {
        return new Promise((resolve) => {
            try {
                const http = require('http');

                const req = http.request({
                    hostname: 'localhost',
                    port: 11434,
                    path: '/api/tags',
                    method: 'GET',
                    timeout: 10000
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            this.ollamaAvailable = true;
                            console.log(`Ollama available, using model: ${EMBEDDING_MODEL}`);
                        } else {
                            this.ollamaAvailable = false;
                            console.log(`Ollama returned status ${res.statusCode}, fallback to keywords`);
                        }
                        resolve();
                    });
                });

                req.on('error', (err) => {
                    this.ollamaAvailable = false;
                    console.log(`Ollama error: ${err.message}, fallback to keywords`);
                    resolve();
                });

                req.on('timeout', () => {
                    req.destroy();
                    this.ollamaAvailable = false;
                    console.log('Ollama check timeout, fallback to keywords');
                    resolve();
                });

                req.end();
            } catch (e) {
                this.ollamaAvailable = false;
                console.log('Ollama check failed:', e.message);
                resolve();
            }
        });
    }

    _hashText(text) {
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    async getEmbedding(text) {
        if (!this.ollamaAvailable) return null;

        // Check embedding LRU cache first
        const textHash = this._hashText(text);
        const cached = this.embeddingCache.get(textHash);
        if (cached) {
            cached.timestamp = Date.now();
            return cached.embedding;
        }

        try {
            const http = require('http');
            const postData = JSON.stringify({
                model: EMBEDDING_MODEL,
                prompt: text
            });

            return new Promise((resolve) => {
                const req = http.request({
                    hostname: 'localhost',
                    port: 11434,
                    path: '/api/embeddings',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    },
                    timeout: 10000
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const result = JSON.parse(data);
                            const embedding = result.embedding || null;
                            if (embedding) {
                                // Store in LRU cache
                                this.embeddingCache.set(textHash, {
                                    embedding,
                                    timestamp: Date.now()
                                });
                                // Evict oldest if over limit
                                if (this.embeddingCache.size > EMBEDDING_CACHE_MAX) {
                                    let oldestKey = null;
                                    let oldestTime = Infinity;
                                    for (const [k, v] of this.embeddingCache) {
                                        if (v.timestamp < oldestTime) {
                                            oldestTime = v.timestamp;
                                            oldestKey = k;
                                        }
                                    }
                                    if (oldestKey) this.embeddingCache.delete(oldestKey);
                                }
                            }
                            resolve(embedding);
                        } catch (e) {
                            resolve(null);
                        }
                    });
                });

                req.on('error', () => resolve(null));
                req.on('timeout', () => {
                    req.destroy();
                    resolve(null);
                });
                req.write(postData);
                req.end();
            });
        } catch (e) {
            return null;
        }
    }

    // Get answer embedding (head+tail truncation for better semantic capture)
    async getAnswerEmbedding(answer) {
        // Strip thinking content before computing embedding
        const stripped = answer.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();

        let truncated;
        if (stripped.length <= ANSWER_HEAD_LEN + ANSWER_TAIL_LEN) {
            truncated = stripped;
        } else {
            truncated = stripped.substring(0, ANSWER_HEAD_LEN)
                + '\n...\n'
                + stripped.substring(stripped.length - ANSWER_TAIL_LEN);
        }

        return await this.getEmbedding(truncated);
    }

    cosineSimilarity(vec1, vec2) {
        if (!vec1 || !vec2 || vec1.length !== vec2.length) return 0;

        let dotProduct = 0;
        let norm1 = 0;
        let norm2 = 0;

        for (let i = 0; i < vec1.length; i++) {
            dotProduct += vec1[i] * vec2[i];
            norm1 += vec1[i] * vec1[i];
            norm2 += vec2[i] * vec2[i];
        }

        if (norm1 === 0 || norm2 === 0) return 0;
        return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
    }

    // Find similar answer in cache
    async findSimilarAnswer(answerEmbedding) {
        console.log(`\n[Answer Similarity Check] Thresholds: High=${ANSWER_SIMILARITY_HIGH}, Merge=${ANSWER_SIMILARITY_MERGE}`);

        if (!answerEmbedding) {
            console.log('  Answer embedding not available (Ollama not connected)');
            return null;
        }

        if (this.cache.size === 0) {
            console.log('  Cache is empty, no answers to compare');
            return null;
        }

        let bestMatch = null;
        let bestScore = 0;
        let bestKey = null;
        const similarities = [];
        let entriesWithEmbedding = 0;

        for (const [key, entry] of this.cache) {
            if (entry.answerEmbedding) {
                entriesWithEmbedding++;
                const score = this.cosineSimilarity(answerEmbedding, entry.answerEmbedding);

                // Get question summary for logging
                const questionSummary = entry.questions ?
                    entry.questions[0].substring(0, 30) + '...' :
                    (entry.question ? entry.question.substring(0, 30) + '...' : 'unknown');

                similarities.push({
                    cachedQuestion: questionSummary,
                    score: score.toFixed(4),
                    match: score >= ANSWER_SIMILARITY_HIGH ? '✓✓' :
                           (score >= ANSWER_SIMILARITY_MERGE ? '✓' : '✗')
                });

                if (score >= ANSWER_SIMILARITY_MERGE && score > bestScore) {
                    bestScore = score;
                    bestMatch = entry;
                    bestKey = key;
                }
            }
        }

        console.log(`  Cache entries: ${this.cache.size}, with answerEmbedding: ${entriesWithEmbedding}`);

        // Print answer similarity comparison table
        if (similarities.length > 0) {
            console.log('Cached answers comparison:');
            console.log('  Score    Match  Cached Question');
            console.log('  ------   -----  ---------------');
            for (const s of similarities) {
                console.log(`  ${s.score}   ${s.match}    ${s.cachedQuestion}`);
            }

            if (bestMatch) {
                if (bestScore >= ANSWER_SIMILARITY_HIGH) {
                    console.log(`\n✓✓ Answer HIGH similarity: score=${bestScore.toFixed(4)} -> Auto-link question`);
                } else {
                    console.log(`\n✓ Answer MERGE similarity: score=${bestScore.toFixed(4)} -> Need user confirmation to merge`);
                }
            } else {
                console.log(`\n✗ No similar answer found (best score below ${ANSWER_SIMILARITY_MERGE})`);
            }
        } else if (entriesWithEmbedding === 0) {
            console.log('  No cached entries have answerEmbedding (need to rebuild cache)');
        }

        if (bestMatch) {
            return { ...bestMatch, key: bestKey, answerScore: bestScore };
        }

        return null;
    }

    // Link new question to existing cache entry (high similarity, no merge)
    async linkQuestion(key, question, questionEmbedding) {
        const entry = this.cache.get(key);
        if (!entry) return false;

        // Convert old structure to new structure if needed
        if (!entry.questions) {
            entry.questions = [entry.question];
            entry.questionEmbeddings = entry.embedding ? [entry.embedding] : [];
            delete entry.question;
            delete entry.embedding;
        }

        // Add new question
        entry.questions.push(question);
        if (questionEmbedding) {
            entry.questionEmbeddings.push(questionEmbedding);
        }
        entry.timestamp = Date.now();

        this.scheduleSave();
        console.log(`[Cache Link] Linked question "${question.substring(0, 30)}..." to existing cache`);
        return true;
    }

    // Merge answers using LLM
    async mergeAnswers(oldAnswer, newAnswer, userConfig) {
        const claudeService = require('./claude');

        const mergePrompt = `现有回答：
${oldAnswer}

新回答：
${newAnswer}

请将这两个回答智能合并成一个更完整的回答。保留两边的有价值信息，去除重复内容，确保回答连贯完整。
只输出合并后的回答，不要任何解释。`;

        // Use Claude CLI for merging (non-streaming)
        return new Promise((resolve, reject) => {
            let mergedContent = '';
            let hasError = false;

            claudeService.executeClaude(
                'merge-' + Date.now(),
                mergePrompt,
                [],  // No history
                userConfig,
                (chunk) => {
                    mergedContent += chunk;
                },
                (fullContent) => {
                    resolve(fullContent);
                },
                (error) => {
                    console.log(`[Merge Error] ${error}`);
                    // Fallback: concatenate answers
                    resolve(oldAnswer + '\n\n补充：\n' + newAnswer);
                }
            );
        });
    }

    // Update cache entry with merged answer
    async updateMergedAnswer(key, newQuestion, mergedAnswer, questionEmbedding, answerEmbedding) {
        const entry = this.cache.get(key);
        if (!entry) return false;

        entry.answer = mergedAnswer;
        entry.answerEmbedding = answerEmbedding;
        entry.questions.push(newQuestion);
        if (questionEmbedding) {
            entry.questionEmbeddings.push(questionEmbedding);
        }
        entry.mergedCount = (entry.mergedCount || 0) + 1;
        entry.timestamp = Date.now();

        this.scheduleSave();
        console.log(`[Cache Merge] Merged answer for "${newQuestion.substring(0, 30)}..."`);
        return true;
    }

    scanKnowledgeBase() {
        try {
            const files = fs.readdirSync(this.workDir)
                .filter(f => f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.json'));

            for (const file of files) {
                const filePath = path.join(this.workDir, file);
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const hash = crypto.createHash('md5').update(content).digest('hex');
                    this.fileHashes.set(file, hash);
                } catch (e) {}
            }
        } catch (e) {
            console.log('Knowledge base scan failed:', e.message);
        }
    }

    checkKnowledgeBaseUpdate() {
        try {
            const currentFiles = fs.readdirSync(this.workDir)
                .filter(f => f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.json'));

            let hasUpdate = false;
            const updatedFiles = [];

            for (const file of currentFiles) {
                const filePath = path.join(this.workDir, file);
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const hash = crypto.createHash('md5').update(content).digest('hex');

                    if (this.fileHashes.get(file) !== hash) {
                        hasUpdate = true;
                        updatedFiles.push(file);
                        this.fileHashes.set(file, hash);
                    }
                } catch (e) {}
            }

            for (const [file] of this.fileHashes) {
                if (!fs.existsSync(path.join(this.workDir, file))) {
                    hasUpdate = true;
                    updatedFiles.push(file);
                    this.fileHashes.delete(file);
                }
            }

            return { hasUpdate, updatedFiles };
        } catch (e) {
            return { hasUpdate: false, updatedFiles: [] };
        }
    }

    extractKeywords(text) {
        const words = text.toLowerCase()
            .replace(/[^一-龥a-zA-Z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2);
        return [...new Set(words)];
    }

    keywordSimilarity(text1, text2) {
        const keywords1 = this.extractKeywords(text1);
        const keywords2 = this.extractKeywords(text2);

        if (keywords1.length === 0 || keywords2.length === 0) return 0;

        const intersection = keywords1.filter(k => keywords2.includes(k));
        const union = [...new Set([...keywords1, ...keywords2])];

        if (union.length === 0) return 0;

        const jaccard = intersection.length / union.length;
        const lenRatio = Math.min(text1.length, text2.length) / Math.max(text1.length, text2.length);

        return jaccard * 0.7 + lenRatio * 0.3;
    }

    // Find similar cache entry (supports multi-question structure)
    async findSimilarCache(question) {
        let bestMatch = null;
        let bestScore = 0;
        const similarities = [];

        const newEmbedding = this.ollamaAvailable ? await this.getEmbedding(question) : null;
        const method = newEmbedding ? 'embedding' : 'keyword';

        for (const [key, entry] of this.cache) {
            let entryBestScore = 0;

            // Handle new structure (multiple questions)
            if (entry.questions && entry.questionEmbeddings) {
                for (let i = 0; i < entry.questions.length; i++) {
                    const cachedQ = entry.questions[i];
                    let score = 0;

                    if (newEmbedding && entry.questionEmbeddings[i]) {
                        score = this.cosineSimilarity(newEmbedding, entry.questionEmbeddings[i]);
                    } else {
                        score = this.keywordSimilarity(question, cachedQ);
                    }

                    similarities.push({
                        cachedQuestion: cachedQ.substring(0, 50) + (cachedQ.length > 50 ? '...' : ''),
                        score: score.toFixed(4),
                        match: score >= this.SIMILARITY_THRESHOLD ? '✓' : '✗'
                    });

                    if (score > entryBestScore) entryBestScore = score;
                }
            } else {
                // Handle old structure (single question)
                let score = 0;
                if (newEmbedding && entry.embedding) {
                    score = this.cosineSimilarity(newEmbedding, entry.embedding);
                } else {
                    score = this.keywordSimilarity(question, entry.question);
                }

                similarities.push({
                    cachedQuestion: entry.question.substring(0, 50) + (entry.question.length > 50 ? '...' : ''),
                    score: score.toFixed(4),
                    match: score >= this.SIMILARITY_THRESHOLD ? '✓' : '✗'
                });

                entryBestScore = score;
            }

            if (entryBestScore >= this.SIMILARITY_THRESHOLD && entryBestScore > bestScore) {
                bestScore = entryBestScore;
                bestMatch = { ...entry, key, score: entryBestScore };
            }
        }

        // Print similarity comparison
        if (similarities.length > 0) {
            console.log(`\n[Similarity Check] Method: ${method}, Threshold: ${this.SIMILARITY_THRESHOLD}`);
            console.log(`Current question: "${question.substring(0, 60)}..."`);
            console.log('Cached questions comparison:');
            console.log('  Score    Match  Cached Question');
            console.log('  ------   -----  ---------------');
            for (const s of similarities) {
                console.log(`  ${s.score}   ${s.match}    ${s.cachedQuestion}`);
            }
            if (bestMatch) {
                console.log(`\n✓ Best match: score=${bestMatch.score.toFixed(4)}, returning cached answer`);
            } else {
                console.log(`\n✗ No match found (threshold=${this.SIMILARITY_THRESHOLD}), will call API`);
            }
        }

        return bestMatch;
    }

    async setCache(question, answer, filesUsed = []) {
        const key = crypto.createHash('sha256').update(question).digest('hex');

        const questionEmbedding = this.ollamaAvailable ? await this.getEmbedding(question) : null;
        const answerEmbedding = this.ollamaAvailable ? await this.getAnswerEmbedding(answer) : null;

        // New structure with multiple questions support
        this.cache.set(key, {
            questions: [question],
            answer: answer,
            answerEmbedding: answerEmbedding,
            questionEmbeddings: questionEmbedding ? [questionEmbedding] : [],
            keywords: [this.extractKeywords(question)],
            filesUsed,
            mergedCount: 0,
            timestamp: Date.now()
        });

        if (this.cache.size > this.MAX_CACHE_SIZE) {
            this.evictOldest();
        }

        this.scheduleSave();
        console.log(`[Cache Save] Saved new entry for "${question.substring(0, 30)}..."`);
    }

    getEntry(key) {
        return this.cache.get(key);
    }

    evictOldest() {
        let oldestKey = null;
        let oldestTime = Infinity;

        for (const [key, entry] of this.cache) {
            if (entry.timestamp < oldestTime) {
                oldestTime = entry.timestamp;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.cache.delete(oldestKey);
        }
    }

    clearCacheByFiles(updatedFiles) {
        for (const [key, entry] of this.cache) {
            if (entry.filesUsed && entry.filesUsed.some(f => updatedFiles.includes(f))) {
                this.cache.delete(key);
            }
        }
        this.scheduleSave();
    }

    saveCacheToDisk() {
        if (!this.cachePath) return;
        try {
            const data = {
                cache: Array.from(this.cache.entries()),
                fileHashes: Array.from(this.fileHashes.entries()),
                timestamp: Date.now(),
                model: EMBEDDING_MODEL
            };
            fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.log('Cache save failed:', e.message);
        }
    }

    // Debounced disk write — coalesces rapid mutations into a single write
    scheduleSave() {
        this._savePending = true;
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._savePending = false;
            this.saveCacheToDisk();
        }, SAVE_DEBOUNCE_MS);
    }

    // Force immediate flush (called on process exit)
    flushSave() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        if (this._savePending) {
            this._savePending = false;
            this.saveCacheToDisk();
            console.log('[Cache] Flushed pending writes to disk');
        }
    }

    loadCacheFromDisk() {
        if (!this.cachePath || !fs.existsSync(this.cachePath)) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
            this.cache = new Map(data.cache || []);
            if (data.fileHashes) {
                this.fileHashes = new Map(data.fileHashes);
            }
        } catch (e) {
            console.log('Cache load failed:', e.message);
        }
    }

    clearAll() {
        this.cache.clear();
        this.saveCacheToDisk();
    }

    getStats() {
        const entries = Array.from(this.cache.values());
        const withAnswerEmbedding = entries.filter(e => e.answerEmbedding).length;
        const totalQuestions = entries.reduce((sum, e) => sum + (e.questions?.length || 1), 0);
        const mergedCount = entries.reduce((sum, e) => sum + (e.mergedCount || 0), 0);

        return {
            totalCached: this.cache.size,
            totalQuestions: totalQuestions,
            withAnswerEmbedding: withAnswerEmbedding,
            mergedCount: mergedCount,
            ollamaAvailable: this.ollamaAvailable,
            embeddingModel: EMBEDDING_MODEL,
            thresholds: {
                question: this.SIMILARITY_THRESHOLD,
                answerHigh: ANSWER_SIMILARITY_HIGH,
                answerMerge: ANSWER_SIMILARITY_MERGE
            },
            oldestTimestamp: entries.length > 0 ? Math.min(...entries.map(e => e.timestamp)) : 0,
            newestTimestamp: entries.length > 0 ? Math.max(...entries.map(e => e.timestamp)) : 0
        };
    }
}

module.exports = new QACache();