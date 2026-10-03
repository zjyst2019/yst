# Claude CLI Chat Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a chat web application that uses Claude CLI via spawn to answer user questions with streaming output.

**Architecture:** Node.js + Express server with WebSocket for real-time streaming, SQLite for persistence, pure HTML/CSS/JS frontend. Each user session spawns an independent Claude CLI process.

**Tech Stack:** Node.js, Express, ws (WebSocket), better-sqlite3, marked (Markdown), Claude CLI

---

## File Structure

| File | Purpose |
|------|---------|
| `package.json` | Dependencies: express, ws, better-sqlite3, uuid, marked |
| `server.js` | Express + WebSocket server entry point |
| `db/schema.sql` | SQLite table definitions |
| `db/database.js` | SQLite connection and query helpers |
| `services/claude.js` | Claude CLI spawn wrapper |
| `routes/api.js` | REST API endpoints |
| `public/index.html` | Chat UI HTML |
| `public/style.css` | Chat UI styles |
| `public/app.js` | Frontend WebSocket logic |

---

### Task 1: Initialize Project and Dependencies

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "claude-web-server",
  "version": "1.0.0",
  "description": "Chat server using Claude CLI with WebSocket streaming",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.16.0",
    "better-sqlite3": "^9.4.3",
    "uuid": "^9.0.1",
    "marked": "^12.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: Dependencies installed successfully, `node_modules/` created

- [ ] **Step 3: Create directory structure**

Run: `mkdir -p db routes services public`
Expected: Directories created

- [ ] **Step 4: Commit**

```bash
git init
git add package.json package-lock.json
git commit -m "feat: initialize project with dependencies"
```

---

### Task 2: Database Schema and Connection

**Files:**
- Create: `db/schema.sql`
- Create: `db/database.js`

- [ ] **Step 1: Create schema.sql**

```sql
-- db/schema.sql
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
```

- [ ] **Step 2: Create database.js**

```javascript
// db/database.js
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'chat.db');
const db = new Database(dbPath);

// Initialize schema
const schema = require('fs').readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Session operations
function createSession(id) {
    db.prepare('INSERT INTO sessions (id) VALUES (?)').run(id);
    return { id, created_at: new Date().toISOString() };
}

function getSession(id) {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function updateLastActive(id) {
    db.prepare('UPDATE sessions SET last_active = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

function deleteSession(id) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// Message operations
function addMessage(sessionId, role, content) {
    const result = db.prepare(
        'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)'
    ).run(sessionId, role, content);
    return { id: result.lastInsertRowid, session_id: sessionId, role, content };
}

function getMessages(sessionId) {
    return db.prepare(
        'SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId);
}

module.exports = {
    createSession,
    getSession,
    updateLastActive,
    deleteSession,
    addMessage,
    getMessages
};
```

- [ ] **Step 3: Create data directory**

Run: `mkdir -p data`
Expected: `data/` directory created

- [ ] **Step 4: Test database connection**

Run: `node -e "const db = require('./db/database'); console.log(db.createSession('test-id'));"`
Expected: Session object printed, `data/chat.db` created

- [ ] **Step 5: Commit**

```bash
git add db/schema.sql db/database.js data/
git commit -m "feat: add SQLite database schema and connection"
```

---

### Task 3: Claude CLI Service

**Files:**
- Create: `services/claude.js`

- [ ] **Step 1: Create claude.js service**

```javascript
// services/claude.js
const { spawn } = require('child_process');

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
        '--model', 'sonnet',
        prompt
    ], {
        cwd: process.cwd(),
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
                    if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                        fullContent += parsed.delta.text;
                        onStream(parsed.delta.text);
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

module.exports = {
    executeClaude,
    stopClaude,
    isActive
};
```

- [ ] **Step 2: Test Claude CLI availability**

Run: `claude --version`
Expected: Version number printed (e.g., "1.x.x")

- [ ] **Step 3: Test service module**

Run: `node -e "const svc = require('./services/claude'); svc.executeClaude('test', 'hello', console.log, console.log, console.error);"`
Expected: Streaming output appears after a few seconds

- [ ] **Step 4: Commit**

```bash
git add services/claude.js
git commit -m "feat: add Claude CLI spawn service with streaming support"
```

---

### Task 4: REST API Routes

**Files:**
- Create: `routes/api.js`

- [ ] **Step 1: Create api.js routes**

```javascript
// routes/api.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

// Create new session
router.post('/sessions', (req, res) => {
    const sessionId = uuidv4();
    const session = db.createSession(sessionId);
    res.json({ session_id: session.id });
});

// Get session messages
router.get('/sessions/:id/messages', (req, res) => {
    const session = db.getSession(req.params.id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    const messages = db.getMessages(req.params.id);
    res.json({ messages });
});

// Delete session
router.delete('/sessions/:id', (req, res) => {
    const session = db.getSession(req.params.id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    db.deleteSession(req.params.id);
    res.json({ success: true });
});

module.exports = router;
```

- [ ] **Step 2: Commit**

```bash
git add routes/api.js
git commit -m "feat: add REST API routes for sessions and messages"
```

---

### Task 5: Main Server with WebSocket

**Files:**
- Create: `server.js`

- [ ] **Step 1: Create server.js**

```javascript
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

                    // Execute Claude CLI
                    claudeService.executeClaude(
                        currentSessionId,
                        msg.content,
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
```

- [ ] **Step 2: Start server and test**

Run: `npm start`
Expected: "Server running at http://localhost:3000"

- [ ] **Step 3: Test REST API**

Run: `curl -X POST http://localhost:3000/api/sessions`
Expected: JSON with session_id

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add main server with WebSocket support"
```

---

### Task 6: Frontend HTML

**Files:**
- Create: `public/index.html`

- [ ] **Step 1: Create index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Chat</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div class="chat-container">
        <header class="chat-header">
            <h1>Claude Chat</h1>
            <div class="status" id="status">Connecting...</div>
        </header>

        <main class="chat-messages" id="messages">
            <!-- Messages will be inserted here -->
        </main>

        <footer class="chat-input">
            <textarea id="input" placeholder="Type your message..." rows="3"></textarea>
            <div class="buttons">
                <button id="send-btn" disabled>Send</button>
                <button id="stop-btn" disabled>Stop</button>
            </div>
        </footer>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: add chat UI HTML structure"
```

---

### Task 7: Frontend CSS

**Files:**
- Create: `public/style.css`

- [ ] **Step 1: Create style.css**

```css
/* public/style.css */
* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e;
    color: #eee;
    height: 100vh;
    display: flex;
}

.chat-container {
    max-width: 800px;
    width: 100%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    height: 100vh;
}

.chat-header {
    padding: 16px 20px;
    background: #16213e;
    border-bottom: 1px solid #0f3460;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.chat-header h1 {
    font-size: 20px;
    color: #e94560;
}

.status {
    font-size: 14px;
    color: #888;
}

.status.connected {
    color: #4ade80;
}

.status.error {
    color: #f87171;
}

.chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    background: #0f0f23;
}

.message {
    margin-bottom: 16px;
    padding: 12px 16px;
    border-radius: 8px;
    max-width: 80%;
}

.message.user {
    background: #0f3460;
    margin-left: auto;
    text-align: right;
}

.message.assistant {
    background: #1a1a2e;
    border: 1px solid #0f3460;
}

.message-content {
    line-height: 1.5;
}

.message-content p {
    margin-bottom: 8px;
}

.message-content code {
    background: #16213e;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: monospace;
}

.message-content pre {
    background: #16213e;
    padding: 12px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 12px 0;
}

.message-content pre code {
    background: none;
    padding: 0;
}

.chat-input {
    padding: 16px 20px;
    background: #16213e;
    border-top: 1px solid #0f3460;
    display: flex;
    gap: 12px;
}

.chat-input textarea {
    flex: 1;
    padding: 12px;
    border: 1px solid #0f3460;
    border-radius: 8px;
    background: #0f0f23;
    color: #eee;
    font-size: 14px;
    resize: none;
}

.chat-input textarea:focus {
    outline: none;
    border-color: #e94560;
}

.buttons {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.buttons button {
    padding: 12px 20px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.2s;
}

#send-btn {
    background: #e94560;
    color: white;
}

#send-btn:hover:not(:disabled) {
    background: #ff6b6b;
}

#send-btn:disabled {
    background: #555;
    cursor: not-allowed;
}

#stop-btn {
    background: #f87171;
    color: white;
}

#stop-btn:hover:not(:disabled) {
    background: #ef4444;
}

#stop-btn:disabled {
    background: #555;
    cursor: not-allowed;
}

/* Scrollbar styling */
.chat-messages::-webkit-scrollbar {
    width: 8px;
}

.chat-messages::-webkit-scrollbar-track {
    background: #0f0f23;
}

.chat-messages::-webkit-scrollbar-thumb {
    background: #0f3460;
    border-radius: 4px;
}
```

- [ ] **Step 2: Commit**

```bash
git add public/style.css
git commit -m "feat: add dark theme CSS styles for chat UI"
```

---

### Task 8: Frontend JavaScript

**Files:**
- Create: `public/app.js`

- [ ] **Step 1: Create app.js**

```javascript
// public/app.js
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const statusEl = document.getElementById('status');

let ws = null;
let sessionId = null;
let isProcessing = false;
let currentAssistantMessage = null;

// Generate session ID
sessionId = localStorage.getItem('sessionId') || generateUUID();
localStorage.setItem('sessionId', sessionId);

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        statusEl.textContent = 'Connected';
        statusEl.classList.add('connected');
        statusEl.classList.remove('error');
        sendBtn.disabled = false;

        // Join session
        ws.send(JSON.stringify({ type: 'join', session_id: sessionId }));

        // Load history
        loadHistory();
    };

    ws.onclose = () => {
        statusEl.textContent = 'Disconnected';
        statusEl.classList.remove('connected');
        sendBtn.disabled = true;
        isProcessing = false;
        stopBtn.disabled = true;

        // Reconnect after 3 seconds
        setTimeout(connect, 3000);
    };

    ws.onerror = () => {
        statusEl.textContent = 'Connection error';
        statusEl.classList.add('error');
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
    };
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'connected':
            break;

        case 'joined':
            console.log('Joined session:', msg.session_id);
            break;

        case 'stream':
            if (!currentAssistantMessage) {
                currentAssistantMessage = addMessage('assistant', '');
            }
            currentAssistantMessage.querySelector('.message-content').textContent += msg.content;
            scrollToBottom();
            break;

        case 'complete':
            if (currentAssistantMessage) {
                const contentEl = currentAssistantMessage.querySelector('.message-content');
                contentEl.innerHTML = marked.parse(msg.content);
                currentAssistantMessage = null;
            }
            isProcessing = false;
            stopBtn.disabled = true;
            sendBtn.disabled = false;
            break;

        case 'error':
            addMessage('assistant', `Error: ${msg.message}`);
            currentAssistantMessage = null;
            isProcessing = false;
            stopBtn.disabled = true;
            sendBtn.disabled = false;
            break;

        case 'stopped':
            if (currentAssistantMessage) {
                const contentEl = currentAssistantMessage.querySelector('.message-content');
                const partial = contentEl.textContent;
                contentEl.innerHTML = marked.parse(partial + ' [stopped]');
                currentAssistantMessage = null;
            }
            isProcessing = false;
            stopBtn.disabled = true;
            sendBtn.disabled = false;
            break;
    }
}

function addMessage(role, content) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.innerHTML = `<div class="message-content">${marked.parse(content)}</div>`;
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
}

function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadHistory() {
    try {
        const res = await fetch(`/api/sessions/${sessionId}/messages`);
        const data = await res.json();
        if (data.messages) {
            messagesEl.innerHTML = '';
            data.messages.forEach(m => {
                addMessage(m.role, m.content);
            });
        }
    } catch (e) {
        console.error('Failed to load history:', e);
    }
}

function sendMessage() {
    const content = inputEl.value.trim();
    if (!content || isProcessing) return;

    addMessage('user', content);
    ws.send(JSON.stringify({ type: 'chat', content }));
    inputEl.value = '';

    isProcessing = true;
    sendBtn.disabled = true;
    stopBtn.disabled = false;
}

function stopGeneration() {
    ws.send(JSON.stringify({ type: 'stop' }));
}

// Event listeners
sendBtn.addEventListener('click', sendMessage);
stopBtn.addEventListener('click', stopGeneration);

inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Start connection
connect();
```

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat: add frontend WebSocket and UI logic"
```

---

### Task 9: Integration Testing

**Files:**
- Modify: `server.js` (if needed)

- [ ] **Step 1: Start the server**

Run: `npm start`
Expected: Server running at http://localhost:3000

- [ ] **Step 2: Open browser and test**

Open: `http://localhost:3000`
Expected: Chat interface appears, status shows "Connected"

- [ ] **Step 3: Send a test message**

Input: "Hello, what is 2+2?"
Expected: Streaming response appears in assistant message bubble

- [ ] **Step 4: Test multi-user concurrency**

Open a second browser tab, send different messages in each
Expected: Both receive independent responses

- [ ] **Step 5: Test history persistence**

Refresh the page
Expected: Previous messages are loaded from database

- [ ] **Step 6: Test stop functionality**

Send a long question, click "Stop" button
Expected: Generation stops, [stopped] appears at end

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete Claude CLI chat server implementation"
```

---

## Summary

This plan creates a fully functional chat server that:
1. Uses Node.js + Express for HTTP and static file serving
2. WebSocket for real-time streaming communication
3. SQLite for chat history persistence
4. Spawns Claude CLI processes for each user request
5. Supports multiple concurrent users with independent sessions
6. Provides a dark-themed chat UI with Markdown rendering

Total: 9 tasks, ~20 steps