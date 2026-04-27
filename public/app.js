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

function formatTime(date) {
    const d = date || new Date();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function addMessage(role, content, timestamp) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    const time = timestamp ? new Date(timestamp) : new Date();
    const timeStr = formatTime(time);
    div.innerHTML = `
        <div class="message-time">${timeStr}</div>
        <div class="message-content">${marked.parse(content)}</div>
    `;
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
                addMessage(m.role, m.content, m.created_at);
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