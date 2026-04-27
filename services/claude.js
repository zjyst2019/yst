// services/claude.js
const { spawn } = require('child_process');
const fs = require('fs');

// Map to track active processes per session
const activeProcesses = new Map();

/**
 * Execute Claude CLI with streaming output
 * @param {string} sessionId - Session identifier
 * @param {string} prompt - User's question
 * @param {function} onStream - Callback for each streaming chunk
 * @param {function} onComplete - Callback when complete
 * @param {function} onError - Callback for errors
 */
function executeClaude(sessionId, prompt, onStream, onComplete, onError) {
    // Check if there's already an active process for this session
    if (activeProcesses.has(sessionId)) {
        onError('A request is already processing for this session');
        return null;
    }

    const child = spawn('claude', [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--model', 'sonnet',
        prompt
    ], {
        cwd: process.env.CLAUDE_WORK_DIR || process.cwd(),
        env: { ...process.env },
        shell: true
    });

    activeProcesses.set(sessionId, child);

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
                    // Handle assistant messages with text content
                    if (parsed.type === 'assistant' && parsed.message?.content) {
                        for (const block of parsed.message.content) {
                            if (block.type === 'text' && block.text) {
                                fullContent += block.text;
                                onStream(block.text);
                            }
                        }
                    }
                    // Also capture final result
                    if (parsed.type === 'result' && parsed.result) {
                        // Result already captured via assistant messages, but ensure we have it
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
        activeProcesses.delete(sessionId);
        if (code === 0) {
            onComplete(fullContent);
        } else {
            onError(`Process exited with code ${code}`);
        }
    });

    child.on('error', (err) => {
        activeProcesses.delete(sessionId);
        onError(`Failed to start Claude CLI: ${err.message}`);
    });

    return child;
}

/**
 * Stop an active Claude process
 * @param {string} sessionId - Session identifier
 */
function stopClaude(sessionId) {
    const child = activeProcesses.get(sessionId);
    if (child) {
        child.kill('SIGTERM');
        activeProcesses.delete(sessionId);
        return true;
    }
    return false;
}

/**
 * Check if a session has an active process
 * @param {string} sessionId - Session identifier
 */
function isActive(sessionId) {
    return activeProcesses.has(sessionId);
}

/**
 * Set Claude CLI working directory
 * @param {string} dirPath - Directory path for knowledge base context
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
    executeClaude,
    stopClaude,
    isActive,
    setWorkDir,
    getWorkDir
};