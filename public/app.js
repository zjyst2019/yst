// public/app.js
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const clearBtn = document.getElementById('clear-btn');
const configBtn = document.getElementById('config-btn');
const saveConfigBtn = document.getElementById('save-config-btn');
const statusEl = document.getElementById('status');
const configModal = document.getElementById('config-modal');
const apiKeyInput = document.getElementById('api-key');
const baseUrlInput = document.getElementById('base-url');
const modelInput = document.getElementById('model');
const configStatusEl = document.getElementById('config-status');
const cacheStatusEl = document.getElementById('cache-status');

// File browser elements
const fileListEl = document.getElementById('file-list');
const refreshFilesBtn = document.getElementById('refresh-files-btn');
const uploadBtn = document.getElementById('upload-btn');
const fileUploadInput = document.getElementById('file-upload-input');
const fileModal = document.getElementById('file-modal');
const fileModalTitle = document.getElementById('file-modal-title');
const fileContentEl = document.getElementById('file-content');
const closeFileBtn = document.getElementById('close-file-btn');
const currentPathEl = document.getElementById('current-path');
const supplementBar = document.getElementById('supplement-bar');
const ingestKnowledgeBtn = document.getElementById('ingest-knowledge-btn');
const ingestStatusEl = document.getElementById('ingest-status');
const createDirBtn = document.getElementById('create-dir-btn');
const ingestModal = document.getElementById('ingest-modal');
const ingestFileList = document.getElementById('ingest-file-list');
const ingestExtraPrompt = document.getElementById('ingest-extra-prompt');
const confirmIngestBtn = document.getElementById('confirm-ingest-btn');
const cancelIngestBtn = document.getElementById('cancel-ingest-btn');
const ingestModalStatus = document.getElementById('ingest-modal-status');
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const closeHelpBtn = document.getElementById('close-help-btn');
const loginBtn = document.getElementById('login-btn');
const loginModal = document.getElementById('login-modal');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const doLoginBtn = document.getElementById('do-login-btn');
const loginStatus = document.getElementById('login-status');

let ws = null;
let sessionId = null;
let isProcessing = false;
let currentAssistantMessage = null;
let currentPath = ''; // Current directory path in file browser
let lastUserQuestion = ''; // Track last user question for cache saving
let lastAnswer = ''; // Track last answer for cache saving
let isSupplementing = false; // Whether in supplement knowledge mode
let supplementQuestion = ''; // Question being supplemented

// API config (user-specific)
let apiConfig = {
    apiKey: localStorage.getItem('user_apiKey') || '',
    baseUrl: localStorage.getItem('user_baseUrl') || 'http://7.242.99.159:8888/',
    model: localStorage.getItem('user_model') || 'MiniMax-M2.7'
};

// Admin auth state
let adminToken = localStorage.getItem('admin_token') || '';
let isAdmin = false;

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

// Check if API key is configured
function isConfigured() {
    return apiConfig.apiKey && apiConfig.apiKey.trim() !== '';
}

// Show/hide config modal
function showConfigModal() {
    apiKeyInput.value = apiConfig.apiKey;
    baseUrlInput.value = apiConfig.baseUrl;
    modelInput.value = apiConfig.model;
    configStatusEl.textContent = '';
    configStatusEl.classList.remove('success');
    configModal.classList.remove('hidden');
}

function hideConfigModal() {
    configModal.classList.add('hidden');
}

// Save config
function saveConfig() {
    const apiKey = apiKeyInput.value.trim();
    const baseUrl = baseUrlInput.value.trim() || 'http://7.242.99.159:8888/';
    const model = modelInput.value.trim() || 'MiniMax-M2.7';

    if (!apiKey) {
        configStatusEl.textContent = 'API Key 为必填项';
        configStatusEl.classList.remove('success');
        return;
    }

    apiConfig = { apiKey, baseUrl, model };

    // Save to localStorage
    localStorage.setItem('user_apiKey', apiKey);
    localStorage.setItem('user_baseUrl', baseUrl);
    localStorage.setItem('user_model', model);

    configStatusEl.textContent = '配置已保存';
    configStatusEl.classList.add('success');

    updateStatus();

    // Send updated config to server
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'join',
            session_id: sessionId,
            config: apiConfig
        }));
    }

    // Close modal after delay
    setTimeout(() => {
        hideConfigModal();
    }, 1000);
}

// Admin auth functions
async function checkAuthStatus() {
    if (!adminToken) return;
    try {
        const res = await fetch('/api/auth/status', {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        const data = await res.json();
        if (data.loggedIn) {
            isAdmin = true;
            updateLoginButton();
            loadFiles();
        } else {
            doLogout();
        }
    } catch (e) {
        // Server might not be started yet, ignore
    }
}

function showLoginModal() {
    loginUsername.value = '';
    loginPassword.value = '';
    loginStatus.textContent = '';
    loginStatus.classList.remove('success');
    loginModal.classList.remove('hidden');
}

function hideLoginModal() {
    loginModal.classList.add('hidden');
}

async function doLogin() {
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();

    if (!username || !password) {
        loginStatus.textContent = '请输入用户名和密码';
        loginStatus.classList.remove('success');
        return;
    }

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            adminToken = data.token;
            isAdmin = true;
            localStorage.setItem('admin_token', adminToken);
            updateLoginButton();
            loadFiles();
            loginStatus.textContent = '登录成功';
            loginStatus.classList.add('success');
            setTimeout(() => hideLoginModal(), 800);
        } else {
            loginStatus.textContent = data.error || '登录失败';
            loginStatus.classList.remove('success');
        }
    } catch (e) {
        loginStatus.textContent = '登录失败: ' + e.message;
        loginStatus.classList.remove('success');
    }
}

function doLogout() {
    if (adminToken) {
        fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        }).catch(() => {});
    }
    adminToken = '';
    isAdmin = false;
    localStorage.removeItem('admin_token');
    updateLoginButton();
    loadFiles();
}

function updateLoginButton() {
    if (isAdmin) {
        loginBtn.textContent = '🔓 注销';
        loginBtn.classList.add('logged-in');
    } else {
        loginBtn.textContent = '🔒 登录';
        loginBtn.classList.remove('logged-in');
    }
}

// Update status display
function updateStatus() {
    if (isConfigured()) {
        statusEl.textContent = '已配置';
        statusEl.classList.add('configured');
        statusEl.classList.remove('error');
        inputEl.placeholder = '输入您的问题...';
    } else {
        statusEl.textContent = '未配置';
        statusEl.classList.remove('configured');
        inputEl.placeholder = '请先配置 API Key 后再进行问答...';
    }
}

// Load cache stats
async function loadCacheStats() {
    try {
        const res = await fetch('/api/cache/stats');
        const stats = await res.json();
        cacheStatusEl.textContent = `缓存: ${stats.totalCached}`;
    } catch (e) {
        console.error('Failed to load cache stats:', e);
    }
}

// File browser functions
async function loadFiles(path = currentPath) {
    try {
        const url = `/api/files?path=${encodeURIComponent(path)}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.files) {
            currentPath = data.currentPath || '';
            updatePathDisplay();
            renderFileList(data.files, data.parentPath);
        }
    } catch (e) {
        console.error('Failed to load files:', e);
        fileListEl.innerHTML = '<div class="file-item"><span class="file-name">加载失败</span></div>';
    }
}

function updatePathDisplay() {
    if (currentPathEl) {
        currentPathEl.textContent = currentPath || '根目录';
    }
}

function renderFileList(files, parentPath) {
    fileListEl.innerHTML = '';

    // Add parent directory link if not at root
    if (parentPath !== null) {
        const parentDiv = document.createElement('div');
        parentDiv.className = 'file-item directory-item parent-dir';
        parentDiv.innerHTML = `
            <span class="file-icon">📁</span>
            <span class="file-name">.. (返回上级)</span>
        `;
        parentDiv.addEventListener('click', () => {
            currentPath = parentPath || '';
            loadFiles();
        });
        fileListEl.appendChild(parentDiv);
    }

    files.forEach(item => {
        const div = document.createElement('div');
        div.className = `file-item ${item.type === 'directory' ? 'directory-item' : ''}`;
        const icon = item.type === 'directory' ? '📁' : '📄';
        div.innerHTML = `
            <span class="file-icon">${icon}</span>
            <span class="file-name">${item.name}</span>
            <span class="file-size">${item.type === 'file' ? formatFileSize(item.size) : ''}</span>
            ${isAdmin ? '<button class="file-delete-btn" title="删除">×</button>' : ''}
        `;

        if (isAdmin) {
            div.querySelector('.file-delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                deleteFile(item.path, item.name);
            });
        }

        div.addEventListener('click', () => {
            if (item.type === 'directory') {
                currentPath = item.path;
                loadFiles();
            } else {
                viewFile(item.path, item.name);
            }
        });

        fileListEl.appendChild(div);
    });
}

async function deleteFile(filePath, fileName) {
    if (!isAdmin) {
        alert('请先登录管理员账号后再进行删除操作');
        showLoginModal();
        return;
    }

    if (!confirm(`确定要删除 "${fileName}" 吗？`)) return;

    try {
        const res = await fetch(`/api/files?path=${encodeURIComponent(filePath)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        if (res.status === 401) {
            alert('登录已过期，请重新登录');
            doLogout();
            showLoginModal();
            return;
        }
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || '删除失败');
        }
        loadFiles();
    } catch (e) {
        alert('删除失败: ' + e.message);
    }
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function viewFile(filePath, filename) {
    try {
        const res = await fetch(`/api/files/content?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'File not found');
        }
        const data = await res.json();
        fileModalTitle.textContent = data.filename;
        fileContentEl.textContent = data.content;
        fileModal.classList.remove('hidden');
    } catch (e) {
        alert('无法读取文件: ' + e.message);
    }
}

// Open local file links from rendered markdown content via the file viewer modal
function openLocalFileLink(href) {
    fetch(`/api/files/content?path=${encodeURIComponent(href)}`)
        .then(res => {
            if (!res.ok) throw new Error('not found');
            return res.json();
        })
        .then(data => {
            fileModalTitle.textContent = data.filename;
            fileContentEl.textContent = data.content;
            fileModal.classList.remove('hidden');
        })
        .catch(() => {
            // Silent fail — the link might reference a file outside the workDir
        });
}

function hideFileModal() {
    fileModal.classList.add('hidden');
}

async function uploadFiles() {
    const files = fileUploadInput.files;
    if (!files || files.length === 0) {
        alert('请选择要上传的文件');
        return;
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = '上传中...';

    try {
        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);

            const url = `/api/files/upload?path=${encodeURIComponent(currentPath)}`;
            const res = await fetch(url, {
                method: 'POST',
                body: formData
            });

            if (!res.ok) {
                throw new Error(`上传 ${file.name} 失败`);
            }
        }

        // Clear input and reload file list
        fileUploadInput.value = '';
        loadFiles();
        alert('上传成功');
    } catch (e) {
        alert('上传失败: ' + e.message);
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = '上传文件';
    }
}

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        statusEl.textContent = isConfigured() ? '已配置' : '未配置';
        if (isConfigured()) {
            statusEl.classList.add('configured');
        }
        statusEl.classList.remove('error');
        sendBtn.disabled = !isConfigured();

        // Join session with config
        ws.send(JSON.stringify({
            type: 'join',
            session_id: sessionId,
            config: apiConfig
        }));

        // Load history
        loadHistory();

        // Load files
        loadFiles();

        // Load cache stats
        loadCacheStats();
    };

    ws.onclose = () => {
        statusEl.textContent = 'Disconnected';
        statusEl.classList.remove('connected', 'configured');
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
            if (currentAssistantMessage) {
                const contentEl = currentAssistantMessage.querySelector('.message-content');
                // Replace "searching" placeholder with real content on first chunk
                if (contentEl.classList.contains('searching')) {
                    contentEl.classList.remove('searching');
                    contentEl.textContent = '';
                }
                contentEl.textContent += msg.content;
                scrollToBottom();
                lastAnswer += msg.content; // Track answer for cache
            }
            break;

        case 'complete':
            if (currentAssistantMessage) {
                const contentEl = currentAssistantMessage.querySelector('.message-content');
                contentEl.classList.remove('searching');
                contentEl.innerHTML = marked.parse(msg.content);

                const actionsEl = currentAssistantMessage.querySelector('.message-actions');
                const showActions = () => {
                    if (!actionsEl) return;
                    actionsEl.style.display = 'block';
                };

                // Handle different cache scenarios
                if (msg.cached) {
                    // From cache - show cached badge
                    const cachedBadge = document.createElement('span');
                    cachedBadge.className = 'cached-badge';
                    cachedBadge.textContent = '(缓存)';
                    cachedBadge.style.cssText = 'font-size:12px;color:#4ade80;margin-left:8px;';
                    contentEl.parentElement.querySelector('.message-time').appendChild(cachedBadge);
                } else if (msg.autoLinked) {
                    // Auto linked by answer similarity >= 95%
                    const autoBadge = document.createElement('span');
                    autoBadge.className = 'auto-badge';
                    autoBadge.textContent = `(自动关联 ${msg.answerSimilarity})`;
                    autoBadge.style.cssText = 'font-size:12px;color:#60a5fa;margin-left:8px;';
                    contentEl.parentElement.querySelector('.message-time').appendChild(autoBadge);
                } else if (msg.needMerge) {
                    // Need merge: answer similarity 90%-95%
                    const mergeBadge = document.createElement('span');
                    mergeBadge.className = 'merge-badge';
                    mergeBadge.textContent = `(相似回答 ${msg.answerSimilarity})`;
                    mergeBadge.style.cssText = 'font-size:12px;color:#fbbf24;margin-left:8px;';
                    contentEl.parentElement.querySelector('.message-time').appendChild(mergeBadge);

                    // Show satisfied button with merge info
                    showActions();
                    const btn = actionsEl.querySelector('.satisfied-btn');
                    btn.dataset.question = lastUserQuestion;
                    btn.dataset.answer = msg.content;
                    btn.dataset.mergeKey = msg.mergeKey;
                    btn.dataset.mergeAnswer = msg.mergeAnswer;
                    btn.dataset.needMerge = 'true';
                    btn.classList.remove('saved', 'hidden');
                    btn.textContent = '满意 ✓ (合并)';
                } else if (msg.needCache) {
                    // Normal: need user confirmation to save new cache
                    showActions();
                    const btn = actionsEl.querySelector('.satisfied-btn');
                    btn.dataset.question = lastUserQuestion;
                    btn.dataset.answer = msg.content;
                    btn.dataset.needCache = 'true';
                    btn.classList.remove('saved', 'hidden');
                    btn.textContent = '满意 ✓';
                }

                currentAssistantMessage = null;
            }
            lastAnswer = msg.content;
            isProcessing = false;
            stopBtn.disabled = true;
            sendBtn.disabled = !isConfigured();
            break;

        case 'cache_status':
            // Late-arriving embedding check result — update existing message
            {
                const assistantMessages = messagesEl.querySelectorAll('.message.assistant');
                const lastMsg = assistantMessages[assistantMessages.length - 1];
                if (!lastMsg) break;
                const timeEl = lastMsg.querySelector('.message-time');
                const actionsEl = lastMsg.querySelector('.message-actions');

                if (msg.autoLinked) {
                    const autoBadge = document.createElement('span');
                    autoBadge.className = 'auto-badge';
                    autoBadge.textContent = `(自动关联 ${msg.answerSimilarity})`;
                    autoBadge.style.cssText = 'font-size:12px;color:#60a5fa;margin-left:8px;';
                    timeEl.appendChild(autoBadge);
                } else if (msg.needMerge && actionsEl) {
                    const mergeBadge = document.createElement('span');
                    mergeBadge.className = 'merge-badge';
                    mergeBadge.textContent = `(相似回答 ${msg.answerSimilarity})`;
                    mergeBadge.style.cssText = 'font-size:12px;color:#fbbf24;margin-left:8px;';
                    timeEl.appendChild(mergeBadge);

                    actionsEl.style.display = 'block';
                    const btn = actionsEl.querySelector('.satisfied-btn');
                    btn.dataset.question = lastUserQuestion;
                    btn.dataset.answer = lastAnswer;
                    btn.dataset.mergeKey = msg.mergeKey;
                    btn.dataset.mergeAnswer = msg.mergeAnswer;
                    btn.dataset.needMerge = 'true';
                    btn.classList.remove('saved', 'hidden');
                    btn.textContent = '满意 ✓ (合并)';
                }
            }
            break;

        case 'supplement_done':
            // Knowledge supplement completed
            hideSupplementBar();
            loadCacheStats();
            addMessage('assistant', '知识库已更新，感谢您的补充！');
            isProcessing = false;
            sendBtn.disabled = false;
            stopBtn.disabled = true;
            break;

        case 'cache_saved':
            // Cache saved confirmation
            loadCacheStats();
            break;

        case 'cache_merged':
            // Cache merged confirmation
            loadCacheStats();
            // Show merged badge
            if (currentAssistantMessage) {
                const actionsEl = currentAssistantMessage.querySelector('.message-actions');
                if (actionsEl) {
                    actionsEl.querySelector('.satisfied-btn').classList.add('saved');
                    actionsEl.querySelector('.satisfied-btn').textContent = '已合并 ✓';
                }
            }
            break;

        case 'error':
            if (currentAssistantMessage) {
                const contentEl = currentAssistantMessage.querySelector('.message-content');
                contentEl.classList.remove('searching');
                contentEl.textContent = '';
                contentEl.innerHTML = marked.parse(`Error: ${msg.message}`);
                currentAssistantMessage = null;
            } else {
                addMessage('assistant', `Error: ${msg.message}`);
            }
            isProcessing = false;
            stopBtn.disabled = true;
            sendBtn.disabled = !isConfigured();
            break;

        case 'stopped':
            if (currentAssistantMessage) {
                const contentEl = currentAssistantMessage.querySelector('.message-content');
                contentEl.classList.remove('searching');
                const partial = contentEl.textContent.replace('🔍 正在检索中...', '');
                contentEl.innerHTML = marked.parse(partial ? partial + ' [已停止]' : '[已停止]');
                currentAssistantMessage = null;
            }
            isProcessing = false;
            stopBtn.disabled = true;
            sendBtn.disabled = !isConfigured();
            break;

        case 'cleared':
            // Conversation cleared, reset UI
            messagesEl.innerHTML = '';
            currentAssistantMessage = null;
            lastAnswer = '';
            lastUserQuestion = '';
            isProcessing = false;
            stopBtn.disabled = true;
            sendBtn.disabled = !isConfigured();
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

    // Add satisfied + supplement buttons for assistant messages
    let actionsHtml = '';
    if (role === 'assistant') {
        actionsHtml = `<div class="message-actions" style="display: none;">
            <div class="action-buttons">
                <button class="satisfied-btn">满意 ✓</button>
                <button class="supplement-btn">补充知识</button>
            </div>
        </div>`;
    }

    div.innerHTML = `
        <div class="message-time">${timeStr}</div>
        <div class="message-content">${marked.parse(content)}</div>
        ${actionsHtml}
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
    if (!isConfigured()) {
        showConfigModal();
        return;
    }

    const content = inputEl.value.trim();
    if (!content || isProcessing) return;

    if (isSupplementing) {
        // Supplement mode: send correct knowledge to ingest
        ws.send(JSON.stringify({
            type: 'supplement_knowledge',
            question: supplementQuestion,
            correctContent: content
        }));

        inputEl.value = '';
        hideSupplementBar();
        addMessage('user', content);
        addMessage('assistant', '⏳ 正在将正确内容写入知识库...');

        isProcessing = true;
        sendBtn.disabled = true;
        stopBtn.disabled = true;
        return;
    }

    lastUserQuestion = content; // Track question for cache saving
    lastAnswer = ''; // Reset answer tracker

    addMessage('user', content);

    // Show "searching" placeholder before response arrives
    currentAssistantMessage = addMessage('assistant', '🔍 正在检索中...');
    currentAssistantMessage.querySelector('.message-content').classList.add('searching');

    // Always send as normal chat
    ws.send(JSON.stringify({
        type: 'chat',
        content,
        config: apiConfig
    }));

    inputEl.value = '';

    isProcessing = true;
    sendBtn.disabled = true;
    stopBtn.disabled = false;
}

function stopGeneration() {
    ws.send(JSON.stringify({ type: 'stop' }));
}

function clearConversation() {
    // Clear messages in UI
    messagesEl.innerHTML = '';

    // Generate new session ID
    sessionId = generateUUID();
    localStorage.setItem('sessionId', sessionId);

    // Notify server to clear history and join new session
    ws.send(JSON.stringify({ type: 'clear' }));
    ws.send(JSON.stringify({
        type: 'join',
        session_id: sessionId,
        config: apiConfig
    }));
}

// Supplement knowledge bar control
function showSupplementBar(question) {
    isSupplementing = true;
    supplementQuestion = question;
    supplementBar.classList.remove('hidden');
    inputEl.placeholder = '需要补充的知识：\n摄入知识的要求：';
    inputEl.value = '需要补充的知识：\n\n摄入知识的要求：';
    inputEl.focus();
}

function hideSupplementBar() {
    isSupplementing = false;
    supplementQuestion = '';
    supplementBar.classList.add('hidden');
    inputEl.placeholder = isConfigured() ? '输入您的问题...' : '请先配置 API Key 后再进行问答...';
}

// Cancel supplement button
document.getElementById('cancel-supplement-btn').addEventListener('click', () => {
    hideSupplementBar();
});

// Supplement button click handler
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('supplement-btn')) {
        const btn = e.target;
        const question = btn.closest('.message.assistant')?.querySelector('.satisfied-btn')?.dataset.question;
        if (question) {
            ws.send(JSON.stringify({
                type: 'supplement_start',
                question: question
            }));
            showSupplementBar(question);
        }
    }
});

// Event listeners
sendBtn.addEventListener('click', sendMessage);
stopBtn.addEventListener('click', stopGeneration);
clearBtn.addEventListener('click', clearConversation);
configBtn.addEventListener('click', showConfigModal);
saveConfigBtn.addEventListener('click', saveConfig);

// Login/logout
loginBtn.addEventListener('click', () => {
    if (isAdmin) {
        doLogout();
    } else {
        showLoginModal();
    }
});
doLoginBtn.addEventListener('click', doLogin);
loginModal.addEventListener('click', (e) => {
    if (e.target === loginModal) hideLoginModal();
});
loginPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
});

// Satisfied button click handler
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('satisfied-btn')) {
        const btn = e.target;
        if (btn.classList.contains('saved')) return;

        const question = btn.dataset.question;
        const answer = btn.dataset.answer;
        const needMerge = btn.dataset.needMerge;
        const mergeKey = btn.dataset.mergeKey;
        const mergeAnswer = btn.dataset.mergeAnswer;

        if (question && answer) {
            if (needMerge === 'true' && mergeKey) {
                // Merge with existing cache
                ws.send(JSON.stringify({
                    type: 'merge_cache',
                    key: mergeKey,
                    question: question,
                    newAnswer: answer,
                    existingAnswer: mergeAnswer
                }));
                btn.classList.add('saved');
                btn.textContent = '合并中...';
            } else {
                // Save new cache entry
                ws.send(JSON.stringify({
                    type: 'save_cache',
                    question: question,
                    answer: answer
                }));
                btn.textContent = '已保存 ✓';
                btn.classList.add('saved');
            }
        }
    }
});

// Ingest knowledge button — show modal
ingestKnowledgeBtn.addEventListener('click', async () => {
    // Fetch files in upload directory
    try {
        const res = await fetch('/api/files?path=upload');
        const data = await res.json();
        const files = (data.files || []).filter(f => f.type === 'file');

        ingestFileList.innerHTML = '';
        if (files.length === 0) {
            ingestFileList.innerHTML = '<div class="ingest-file-empty">upload/ 目录下没有文件</div>';
            confirmIngestBtn.disabled = true;
        } else {
            files.forEach(f => {
                const label = document.createElement('label');
                label.className = 'ingest-file-item';
                label.innerHTML = `
                    <input type="checkbox" value="${f.name}" checked>
                    <span>${f.name}</span>
                    <span style="font-size:11px;color:#888;margin-left:auto">${formatFileSize(f.size)}</span>
                `;
                ingestFileList.appendChild(label);
            });
            confirmIngestBtn.disabled = false;
        }

        ingestExtraPrompt.value = '在摄入文件中的知识的时候看下与当前知识库中的md文件的内容是否有关联，如果有关联的话将差异的部分更新到相应的md文件，如果无关联知识则新增md文件，然后看是否需要刷新index.md文件';
        ingestModalStatus.textContent = '';
        ingestModal.classList.remove('hidden');
    } catch (e) {
        ingestStatusEl.textContent = '加载文件列表失败';
    }
});

// Confirm ingest — close modal immediately, process in background
confirmIngestBtn.addEventListener('click', () => {
    const checked = ingestFileList.querySelectorAll('input[type="checkbox"]:checked');
    const selectedFiles = Array.from(checked).map(cb => cb.value);
    if (selectedFiles.length === 0) return;

    // Close modal immediately
    ingestModal.classList.add('hidden');

    // Show processing status in file panel
    ingestStatusEl.textContent = `摄入中 (${selectedFiles.length} 个文件)...`;
    ingestStatusEl.style.color = '#fbbf24';

    fetch('/api/knowledge/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            config: apiConfig,
            files: selectedFiles,
            extraPrompt: ingestExtraPrompt.value.trim() || null
        })
    }).then(res => res.json()).then(data => {
        const successCount = data.results?.filter(r => r.status === 'ingested').length || 0;
        const failedResults = data.results?.filter(r => r.status === 'failed' || r.status === 'error') || [];

        if (successCount > 0) {
            const details = data.results
                .filter(r => r.status === 'ingested')
                .map(r => `  ${r.file} → ${r.kbPath || 'KB'}`)
                .join('\n');
            ingestStatusEl.textContent = `已摄入 ${successCount} 个文件` + (failedResults.length > 0 ? `，${failedResults.length} 个失败` : '');
            ingestStatusEl.title = '摄入详情:\n' + details;
            if (failedResults.length > 0) {
                ingestStatusEl.title += '\n失败:\n' + failedResults.map(r => `  ${r.file}: ${r.error || 'unknown'}`).join('\n');
            }
            loadCacheStats();
            loadFiles();
        } else if (failedResults.length > 0) {
            ingestStatusEl.textContent = `摄入失败: ${failedResults[0].file}`;
            ingestStatusEl.title = '失败详情:\n' + failedResults.map(r => `  ${r.file}: ${r.error || 'unknown'}`).join('\n');
            ingestStatusEl.style.color = '#f87171';
        } else {
            ingestStatusEl.textContent = '无文件需摄入';
        }
        ingestStatusEl.style.color = '';
    }).catch(e => {
        ingestStatusEl.textContent = '摄入失败';
        ingestStatusEl.style.color = '#f87171';
    });
});

// Cancel ingest modal
cancelIngestBtn.addEventListener('click', () => {
    ingestModal.classList.add('hidden');
});
ingestModal.addEventListener('click', (e) => {
    if (e.target === ingestModal) ingestModal.classList.add('hidden');
});

// Create directory button
createDirBtn.addEventListener('click', async () => {
    const name = prompt('请输入文件夹名称：');
    if (!name || !name.trim()) return;
    try {
        const res = await fetch('/api/files/create-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentPath, name: name.trim() })
        });
        const data = await res.json();
        if (data.success) {
            loadFiles();
        } else {
            alert('创建失败: ' + (data.error || '未知错误'));
        }
    } catch (e) {
        alert('创建失败: ' + e.message);
    }
});

// File browser event listeners
refreshFilesBtn.addEventListener('click', () => loadFiles());
uploadBtn.addEventListener('click', uploadFiles);
closeFileBtn.addEventListener('click', hideFileModal);

// Close file modal on outside click
fileModal.addEventListener('click', (e) => {
    if (e.target === fileModal) {
        hideFileModal();
    }
});

inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Close modal on outside click
configModal.addEventListener('click', (e) => {
    if (e.target === configModal) {
        hideConfigModal();
    }
});

// Intercept local file links in rendered markdown and open via file viewer
messagesEl.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('http://') || href.startsWith('https://') ||
        href.startsWith('#') || href.startsWith('mailto:')) return;

    e.preventDefault();
    openLocalFileLink(decodeURIComponent(href));
});

// Initialize
updateStatus();

// Always start connection
connect();

// Check auth status on load
checkAuthStatus();

// Help modal
helpBtn.addEventListener('click', () => {
    helpModal.classList.remove('hidden');
});
closeHelpBtn.addEventListener('click', () => {
    helpModal.classList.add('hidden');
});
helpModal.addEventListener('click', (e) => {
    if (e.target === helpModal) helpModal.classList.add('hidden');
});

// Show config modal if not configured
if (!isConfigured()) {
    showConfigModal();
}