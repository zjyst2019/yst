// services/claude.js
const Anthropic = require('@anthropic-ai/sdk');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Map to track active requests per session
const activeRequests = new Map();

// System prompt cache (loaded once at startup, shared across all users)
let systemPrompt = null;
let systemPromptFilePath = null;  // Store the file path for CLI mode

// Configuration: use SDK or CLI (CLI is default for knowledge base support)
const USE_SDK = process.env.USE_SDK === 'true'; // Default to CLI, set USE_SDK=true to use SDK

// Max history messages to include in context
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY_MESSAGES) || 5;

// Disable history context (set DISABLE_HISTORY=true to skip history)
const DISABLE_HISTORY = process.env.DISABLE_HISTORY === 'true';

// Skip hooks and permissions (set SKIP_HOOKS=true for bare mode)
const SKIP_HOOKS = process.env.SKIP_HOOKS === 'true';

// Disable tools (set DISABLE_TOOLS=true to not allow tool calls)
const DISABLE_TOOLS = process.env.DISABLE_TOOLS === 'true';

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
    systemPromptFilePath = path.resolve(promptPath);

    if (fs.existsSync(systemPromptFilePath)) {
        systemPrompt = fs.readFileSync(systemPromptFilePath, 'utf-8');
        console.log(`System prompt loaded: ${systemPrompt.length} characters from ${systemPromptFilePath}`);
        console.log(`System prompt preview (first 200 chars): ${systemPrompt.substring(0, 200)}`);
        return true;
    }
    console.log(`System prompt file not found: ${systemPromptFilePath}`);
    systemPromptFilePath = null;
    return false;
}

/**
 * Get the cached system prompt
 */
function getSystemPrompt() {
    return systemPrompt;
}

/**
 * Get the system prompt file path (for CLI mode)
 */
function getSystemPromptFilePath() {
    return systemPromptFilePath;
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
 * Execute Claude using CLI with streaming output
 * Uses --append-system-prompt to pass CLAUDE.md content as system prompt
 * Uses --add-dir to allow file access in knowledge base directory
 * Uses --tools to enable Read tool for document access
 *
 * Note: If Claude CLI settings file already has API config (baseURL, apiKey, model),
 * no need to set environment variables. CLI will use settings defaults.
 * Environment variables can override settings if needed.
 */
function executeClaudeCLI(sessionId, prompt, history, onStream, onComplete, onError) {
    if (activeRequests.has(sessionId)) {
        onError('A request is already processing for this session');
        return null;
    }

    const workDir = process.env.CLAUDE_WORK_DIR || process.cwd();

    // Build CLI arguments
    const args = [
        '-p',
        '--output-format', 'stream-json',
        '--verbose'
    ];

    // Add --bare to skip hooks and extra processing (optional)
    if (SKIP_HOOKS) {
        args.push('--bare');
    }

    // Add --dangerously-skip-permissions to bypass permission checks (optional)
    if (process.env.SKIP_PERMISSIONS === 'true') {
        args.push('--dangerously-skip-permissions');
    }

    // Allow CLI to access files in the knowledge base directory
    args.push('--add-dir', workDir);

    // Enable tools so CLI can read documents (unless disabled)
    if (!DISABLE_TOOLS) {
        args.push('--tools', 'Read,Bash');
    }

    // Only add --model if explicitly set (otherwise use CLI settings default)
    if (process.env.CLAUDE_MODEL) {
        args.push('--model', process.env.CLAUDE_MODEL);
    }

    // Add system prompt using file path (better for multi-line content)
    // Use --append-system-prompt-file to avoid shell truncation issues
    if (systemPromptFilePath) {
        args.push('--append-system-prompt-file', systemPromptFilePath);
    }

    // Format history messages into prompt context (unless disabled)
    let fullPrompt = '';
    if (!DISABLE_HISTORY && history && history.length > 0) {
        fullPrompt = '以下是之前的对话历史：\n\n';
        for (const msg of history) {
            if (msg.role === 'user') {
                fullPrompt += `用户: ${msg.content}\n`;
            } else if (msg.role === 'assistant') {
                fullPrompt += `助手: ${msg.content}\n`;
            }
        }
        fullPrompt += '\n---\n\n';
    }
    fullPrompt += prompt;

    // Add prompt
    args.push(fullPrompt);

    console.log('Executing Claude CLI:');
    console.log('  Working directory:', workDir);
    console.log('  System prompt file:', systemPromptFilePath || 'none');
    console.log('  History messages:', history ? history.length : 0, '(disabled:', DISABLE_HISTORY, ')');
    console.log('  Prompt length:', fullPrompt.length, 'chars');
    console.log('System prompt:', systemPrompt ? `${systemPrompt.length} chars` : 'none');

    const child = spawn('claude', args, {
        cwd: workDir,
        env: { ...process.env },
        shell: true
    });

    activeRequests.set(sessionId, child);

    let fullContent = '';
    let buffer = '';

    child.stdout.on('data', (data) => {
        const rawStr = data.toString();
        console.log('Claude CLI stdout chunk:', rawStr.substring(0, 200));

        buffer += rawStr;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                try {
                    const parsed = JSON.parse(line);
                    console.log('Parsed JSON type:', parsed.type);

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
                            onStream(parsed.result);
                        }
                    }
                } catch (e) {
                    console.log('Non-JSON line:', line.substring(0, 100));
                }
            }
        }
    });

    child.stderr.on('data', (data) => {
        console.error(`Claude CLI stderr: ${data}`);
        // Also check if stderr contains useful JSON output (sometimes mixed)
        const stderrStr = data.toString();
        if (stderrStr.includes('type:') && stderrStr.trim().startsWith('{')) {
            // Try parsing stderr as JSON output
            const lines = stderrStr.split('\n');
            for (const line of lines) {
                if (line.trim().startsWith('{')) {
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
                    } catch (e) {}
                }
            }
        }
    });

    child.on('close', (code) => {
        console.log(`Claude CLI exited with code: ${code}`);
        activeRequests.delete(sessionId);
        if (code === 0) {
            onComplete(fullContent);
        } else {
            onError(`Process exited with code ${code}`);
        }
    });

    child.on('error', (err) => {
        console.error(`Claude CLI error: ${err.message}`);
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
    getSystemPromptFilePath,
    buildMessages,
    executeClaude,
    stopClaude,
    isActive,
    setWorkDir,
    getWorkDir,
    getMode
};