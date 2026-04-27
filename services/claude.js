// services/claude.js
const Anthropic = require('@anthropic-ai/sdk');
const { spawn } = require('child_process');
const fs = require('fs');

// Map to track active requests per session
const activeRequests = new Map();

// Configuration: use SDK (default) or CLI
const USE_SDK = process.env.USE_SDK !== 'false'; // Default to SDK, set USE_SDK=false to use CLI

// Initialize Anthropic SDK client (singleton, reused across requests)
let anthropicClient = null;

function getAnthropicClient() {
    if (!anthropicClient) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error('ANTHROPIC_API_KEY environment variable is required for SDK mode');
        }
        anthropicClient = new Anthropic({ apiKey });
    }
    return anthropicClient;
}

/**
 * Execute Claude using SDK with streaming output
 */
async function executeClaudeSDK(sessionId, prompt, onStream, onComplete, onError) {
    if (activeRequests.has(sessionId)) {
        onError('A request is already processing for this session');
        return null;
    }

    const client = getAnthropicClient();
    const abortController = new AbortController();
    activeRequests.set(sessionId, abortController);

    let fullContent = '';

    try {
        const stream = client.messages.stream({
            model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            messages: [
                { role: 'user', content: prompt }
            ],
        }, {
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
 */
function executeClaudeCLI(sessionId, prompt, onStream, onComplete, onError) {
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
 */
function executeClaude(sessionId, prompt, onStream, onComplete, onError) {
    if (USE_SDK) {
        return executeClaudeSDK(sessionId, prompt, onStream, onComplete, onError);
    } else {
        return executeClaudeCLI(sessionId, prompt, onStream, onComplete, onError);
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
    executeClaude,
    stopClaude,
    isActive,
    setWorkDir,
    getWorkDir,
    getMode
};