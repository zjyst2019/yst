// services/claude.js
const Anthropic = require('@anthropic-ai/sdk');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Map to track active requests per session
const activeRequests = new Map();

// System prompt cache (loaded once at startup, shared across all users)
let systemPrompt = null;

// Configuration: use SDK (default) or CLI
const USE_SDK = process.env.USE_SDK !== 'false'; // Default to SDK, set USE_SDK=false to use CLI

// Max history messages to include in context
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY_MESSAGES) || 5;

// Initialize Anthropic SDK client (singleton, reused across requests)
let anthropicClient = null;

function getAnthropicClient() {
    if (!anthropicClient) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error('ANTHROPIC_API_KEY environment variable is required for SDK mode');
        }

        // Support custom baseURL for private/self-hosted models
        const baseURL = process.env.ANTHROPIC_BASE_URL;

        anthropicClient = new Anthropic({
            apiKey,
            baseURL: baseURL || undefined  // undefined uses default Anthropic API
        });

        if (baseURL) {
            console.log(`Using custom API endpoint: ${baseURL}`);
        }
    }
    return anthropicClient;
}

/**
 * Load system prompt from file (CLAUDE.md or custom path)
 * Called once at startup, cached for all subsequent requests
 */
function loadSystemPrompt(filePath) {
    const promptPath = filePath || process.env.SYSTEM_PROMPT_FILE || './CLAUDE.md';
    const absolutePath = path.resolve(promptPath);

    if (fs.existsSync(absolutePath)) {
        systemPrompt = fs.readFileSync(absolutePath, 'utf-8');
        console.log(`System prompt loaded: ${systemPrompt.length} characters from ${absolutePath}`);
        return true;
    }
    console.log(`System prompt file not found: ${absolutePath}`);
    return false;
}

/**
 * Get the cached system prompt
 */
function getSystemPrompt() {
    return systemPrompt;
}

/**
 * Build messages array for API request
 * Includes history messages + new user message
 */
function buildMessages(history, userMessage) {
    const messages = [];

    // Add history messages (if any)
    if (history && history.length > 0) {
        for (const msg of history) {
            messages.push({
                role: msg.role,
                content: msg.content
            });
        }
    }

    // Add new user message
    messages.push({ role: 'user', content: userMessage });

    return messages;
}

/**
 * Execute Claude using SDK with streaming output
 * @param {string} sessionId - Session identifier
 * @param {string} prompt - User's current question
 * @param {Array} history - History messages (from database)
 * @param {function} onStream - Callback for each streaming chunk
 * @param {function} onComplete - Callback when complete
 * @param {function} onError - Callback for errors
 */
async function executeClaudeSDK(sessionId, prompt, history, onStream, onComplete, onError) {
    if (activeRequests.has(sessionId)) {
        onError('A request is already processing for this session');
        return null;
    }

    const client = getAnthropicClient();
    const abortController = new AbortController();
    activeRequests.set(sessionId, abortController);

    let fullContent = '';

    try {
        // Build request with system prompt and history
        const requestOptions = {
            model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            messages: buildMessages(history, prompt),
        };

        // Add system prompt if loaded
        if (systemPrompt) {
            requestOptions.system = systemPrompt;
        }

        const stream = client.messages.stream(requestOptions, {
            signal: abortController.signal
        });

        stream.on('text', (text) => {
            fullContent += text;
            onStream(text);
        });

        await stream.finalMessage();

        activeRequests.delete(sessionId);
        onComplete(fullContent);
        return abortController;

    } catch (err) {
        activeRequests.delete(sessionId);
        if (err.name === 'AbortError') {
            // Request was cancelled
        } else {
            onError(`SDK error: ${err.message}`);
        }
        return null;
    }
}

/**
 * Execute Claude using CLI with streaming output (fallback method)
 * Note: CLI mode doesn't support system prompt, but can read CLAUDE.md from work directory
 */
function executeClaudeCLI(sessionId, prompt, history, onStream, onComplete, onError) {
    if (activeRequests.has(sessionId)) {
        onError('A request is already processing for this session');
        return null;
    }

    const child = spawn('claude', [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--model', process.env.CLAUDE_MODEL || 'sonnet',
        prompt
    ], {
        cwd: process.env.CLAUDE_WORK_DIR || process.cwd(),
        env: { ...process.env },
        shell: true
    });

    activeRequests.set(sessionId, child);

    let fullContent = '';
    let buffer = '';

    child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.type === 'assistant' && parsed.message?.content) {
                        for (const block of parsed.message.content) {
                            if (block.type === 'text' && block.text) {
                                fullContent += block.text;
                                onStream(block.text);
                            }
                        }
                    }
                    if (parsed.type === 'result' && parsed.result) {
                        if (!fullContent) {
                            fullContent = parsed.result;
                        }
                    }
                } catch (e) {
                    // Skip non-JSON lines
                }
            }
        }
    });

    child.stderr.on('data', (data) => {
        console.error(`Claude CLI stderr: ${data}`);
    });

    child.on('close', (code) => {
        activeRequests.delete(sessionId);
        if (code === 0) {
            onComplete(fullContent);
        } else {
            onError(`Process exited with code ${code}`);
        }
    });

    child.on('error', (err) => {
        activeRequests.delete(sessionId);
        onError(`Failed to start Claude CLI: ${err.message}`);
    });

    return child;
}

/**
 * Execute Claude with streaming output
 * Uses SDK by default, CLI as fallback
 * @param {string} sessionId - Session identifier
 * @param {string} prompt - User's current question
 * @param {Array} history - History messages (from database, optional)
 * @param {function} onStream - Callback for each streaming chunk
 * @param {function} onComplete - Callback when complete
 * @param {function} onError - Callback for errors
 */
function executeClaude(sessionId, prompt, history, onStream, onComplete, onError) {
    if (USE_SDK) {
        return executeClaudeSDK(sessionId, prompt, history, onStream, onComplete, onError);
    } else {
        return executeClaudeCLI(sessionId, prompt, history, onStream, onComplete, onError);
    }
}

/**
 * Stop an active Claude request
 */
function stopClaude(sessionId) {
    const request = activeRequests.get(sessionId);
    if (request) {
        if (request instanceof AbortController) {
            request.abort();
        } else {
            request.kill('SIGTERM');
        }
        activeRequests.delete(sessionId);
        return true;
    }
    return false;
}

/**
 * Check if a session has an active request
 */
function isActive(sessionId) {
    return activeRequests.has(sessionId);
}

/**
 * Set Claude CLI working directory
 */
function setWorkDir(dirPath) {
    if (fs.existsSync(dirPath)) {
        process.env.CLAUDE_WORK_DIR = dirPath;
        return true;
    }
    return false;
}

/**
 * Get current Claude CLI working directory
 */
function getWorkDir() {
    return process.env.CLAUDE_WORK_DIR || process.cwd();
}

/**
 * Get current mode (SDK or CLI)
 */
function getMode() {
    return USE_SDK ? 'SDK' : 'CLI';
}

module.exports = {
    loadSystemPrompt,
    getSystemPrompt,
    buildMessages,
    executeClaude,
    stopClaude,
    isActive,
    setWorkDir,
    getWorkDir,
    getMode
};