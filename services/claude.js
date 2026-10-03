// services/claude.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Map to track active requests per session
const activeRequests = new Map();

// System prompt cache (loaded once at startup, shared across all users)
let systemPrompt = null;
let systemPromptFilePath = null;  // Store the file path for CLI mode

// Max history messages to include in context
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY_MESSAGES) || 5;

// Disable history context - default true (set ENABLE_HISTORY=true to enable)
const DISABLE_HISTORY = process.env.ENABLE_HISTORY !== 'true';

// Skip hooks and permissions - default true (set ENABLE_HOOKS=true to enable)
const SKIP_HOOKS = process.env.ENABLE_HOOKS !== 'true';

// Skip permission checks - default true (set ENABLE_PERMISSIONS=true to enable)
const SKIP_PERMISSIONS = process.env.ENABLE_PERMISSIONS !== 'true';

// Disable tools - default true (set ENABLE_TOOLS=true to enable)
const DISABLE_TOOLS = process.env.ENABLE_TOOLS !== 'true';

// Helper function to filter content blocks (skip thinking blocks)
function filterContentBlocks(blocks) {
    return blocks.filter(block => block.type !== 'thinking');
}

/**
 * Create a stateful thinking filter that handles <thinking> blocks
 * spanning multiple streaming chunks. Returns a filter function
 * that processes each chunk and returns { output, thinking }.
 */
function createThinkingFilter() {
    let inThinking = false;

    return function filterChunk(text) {
        if (!text) return { output: '', thinking: '' };

        let output = '';
        let thinkingLog = '';
        let remaining = text;

        while (remaining.length > 0) {
            if (inThinking) {
                // Looking for closing tag
                const endMatch = remaining.match(/<\/think(?:ing)?>/i);
                if (endMatch) {
                    thinkingLog += remaining.substring(0, endMatch.index);
                    remaining = remaining.substring(endMatch.index + endMatch[0].length);
                    inThinking = false;
                } else {
                    thinkingLog += remaining;
                    remaining = '';
                }
            } else {
                // Looking for opening tag
                const startMatch = remaining.match(/<think(?:ing)?>/i);
                if (startMatch) {
                    output += remaining.substring(0, startMatch.index);
                    remaining = remaining.substring(startMatch.index + startMatch[0].length);
                    inThinking = true;
                } else {
                    output += remaining;
                    remaining = '';
                }
            }
        }

        return { output: output.trimStart(), thinking: thinkingLog };
    };
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
 * Execute Claude using CLI with streaming output
 * Uses --append-system-prompt to pass CLAUDE.md content as system prompt
 * Uses --add-dir to allow file access in knowledge base directory
 * Uses --tools to enable Read tool for document access
 *
 * Note: If Claude CLI settings file already has API config (baseURL, apiKey, model),
 * no need to set environment variables. CLI will use settings defaults.
 * Environment variables can override settings if needed.
 */
function executeClaudeCLI(sessionId, prompt, history, userConfig, onStream, onComplete, onError) {
    if (activeRequests.has(sessionId)) {
        onError('A request is already processing for this session');
        return null;
    }

    const workDir = process.env.CLAUDE_WORK_DIR || process.cwd();

    // Build CLI arguments
    // Use '-p -' to read prompt from stdin (avoids shell interpreting prompt as commands)
    const args = [
        '-p', '-',
        '--output-format', 'stream-json',
        '--verbose'
    ];

    // Add --bare to skip hooks and extra processing (default: true)
    if (SKIP_HOOKS) {
        args.push('--bare');
    }

    // Determine if root, and if we'll switch user for Claude CLI
    const isRoot = process.getuid && process.getuid() === 0;
    const runAsUser = isRoot ? (process.env.CLAUDE_RUN_USER || '') : '';

    // Add --dangerously-skip-permissions to bypass permission checks (default: true)
    // Claude CLI forbids this flag when running as root, but if we use runuser
    // to switch to a non-root user, we can safely add it.
    if (SKIP_PERMISSIONS && (!isRoot || runAsUser)) {
        args.push('--dangerously-skip-permissions');
    }
    if (isRoot && !runAsUser) {
        console.log('Running as root, --dangerously-skip-permissions skipped. Set CLAUDE_RUN_USER to run Claude CLI as non-root user.');
    }

    // Allow CLI to access files in the knowledge base directory
    args.push('--add-dir', workDir);

    // Enable tools so CLI can read documents (unless disabled)
    if (!DISABLE_TOOLS) {
        args.push('--tools', 'Read,Bash');
    }

    // Use model from userConfig or environment
    const modelToUse = userConfig?.model || process.env.CLAUDE_MODEL;
    if (modelToUse) {
        args.push('--model', modelToUse);
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

    console.log('Executing Claude CLI:');
    console.log('  Working directory:', workDir);
    console.log('  System prompt file:', systemPromptFilePath || 'none');
    console.log('  History messages:', history ? history.length : 0, '(disabled:', DISABLE_HISTORY, ')');
    console.log('  Prompt length:', fullPrompt.length, 'chars');
    console.log('  System prompt:', systemPrompt ? `${systemPrompt.length} chars` : 'none');
    console.log('  User config:');
    console.log('    API Key:', userConfig?.apiKey ? `${userConfig.apiKey.substring(0, 8)}...` : 'not provided');
    console.log('    Base URL:', userConfig?.baseUrl || 'default');
    console.log('    Model:', modelToUse || 'default');

    // Build environment with user-specific API config
    const env = { ...process.env };
    if (userConfig?.apiKey) {
        env.ANTHROPIC_API_KEY = userConfig.apiKey;
    }
    if (userConfig?.baseUrl) {
        env.ANTHROPIC_BASE_URL = userConfig.baseUrl;
    }

    // If running as root with CLAUDE_RUN_USER set, spawn claude under that user.
    // This allows --dangerously-skip-permissions and Bash tool access.
    let child;
    if (runAsUser) {
        console.log(`  Running Claude CLI as user: ${runAsUser}`);
        const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
        child = spawn('runuser', ['-u', runAsUser, '--', 'bash', '-c', `cd '${workDir}' && claude ${escapedArgs}`], {
            cwd: workDir,
            env: env
        });
    } else {
        child = spawn('claude', args, {
            cwd: workDir,
            env: env,
            shell: true
        });
    }

    // Write prompt via stdin (avoids shell interpreting prompt content as commands)
    child.stdin.write(fullPrompt);
    child.stdin.end();

    activeRequests.set(sessionId, child);

    let fullContent = '';
    let buffer = '';
    const thinkFilter = createThinkingFilter();

    child.stdout.on('data', (data) => {
        const rawStr = data.toString();

        buffer += rawStr;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                try {
                    const parsed = JSON.parse(line);
                    console.log('Parsed JSON type:', parsed.type);

                    if (parsed.type === 'assistant' && parsed.message?.content) {
                        // Check if THIS message contains tool use blocks
                        const hasToolUse = parsed.message.content.some(
                            b => b.type === 'tool_use'
                        );

                        for (const block of filterContentBlocks(parsed.message.content)) {
                            if (block.type === 'text' && block.text) {
                                const { output, thinking } = thinkFilter(block.text);
                                if (thinking) {
                                    console.log('[Thinking]', thinking.substring(0, 300));
                                }
                                if (!output) continue;

                                if (hasToolUse) {
                                    // Text alongside tool_use → planning, log only
                                    console.log('[Planning]', output.substring(0, 200));
                                } else {
                                    // Text without tool_use → answer, stream to frontend
                                    fullContent += output;
                                    onStream(output);
                                }
                            }
                        }
                    }
                    if (parsed.type === 'result' && parsed.result) {
                        if (!fullContent) {
                            const { output, thinking } = thinkFilter(parsed.result);
                            if (thinking) {
                                console.log('[Thinking]', thinking.substring(0, 300));
                            }
                            if (output) {
                                fullContent = output;
                                onStream(output);
                            }
                        }
                    }
                } catch (e) {
                    const { output, thinking } = thinkFilter(line);
                    if (thinking) {
                        console.log('[Thinking in raw]', thinking.substring(0, 200));
                    }
                    if (output) {
                        console.log('Non-JSON line:', output.substring(0, 100));
                    }
                }
            }
        }
    });

    child.stderr.on('data', (data) => {
        const stderrStr = data.toString();
        // Also check if stderr contains useful JSON output (sometimes mixed)
        if (stderrStr.includes('type:') && stderrStr.trim().startsWith('{')) {
            const lines = stderrStr.split('\n');
            for (const line of lines) {
                if (line.trim().startsWith('{')) {
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.type === 'assistant' && parsed.message?.content) {
                            const hasToolUse = parsed.message.content.some(
                                b => b.type === 'tool_use'
                            );
                            for (const block of filterContentBlocks(parsed.message.content)) {
                                if (block.type === 'text' && block.text) {
                                    const { output, thinking } = thinkFilter(block.text);
                                    if (thinking) {
                                        console.log('[Thinking]', thinking.substring(0, 300));
                                    }
                                    if (output) {
                                        if (hasToolUse) {
                                            console.log('[Planning]', output.substring(0, 200));
                                        } else {
                                            fullContent += output;
                                            onStream(output);
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                }
            }
        } else {
            const { output, thinking } = thinkFilter(stderrStr);
            if (thinking) {
                console.log('[Thinking]', thinking.substring(0, 200));
            }
            if (output) {
                console.error('Claude CLI stderr:', output.substring(0, 200));
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
 * @param {Object} userConfig - User-specific API config { apiKey, baseUrl, model }
 * @param {function} onStream - Callback for each streaming chunk
 * @param {function} onComplete - Callback when complete
 * @param {function} onError - Callback for errors
 */
function executeClaude(sessionId, prompt, history, userConfig, onStream, onComplete, onError) {
    return executeClaudeCLI(sessionId, prompt, history, userConfig, onStream, onComplete, onError);
}

/**
 * Stop an active Claude request
 */
function stopClaude(sessionId) {
    const request = activeRequests.get(sessionId);
    if (request) {
        request.kill('SIGTERM');
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

module.exports = {
    loadSystemPrompt,
    getSystemPrompt,
    getSystemPromptFilePath,
    executeClaude,
    stopClaude,
    isActive,
    setWorkDir,
    getWorkDir
};