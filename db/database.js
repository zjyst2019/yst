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

// Get recent messages for context (limited to MAX_HISTORY_MESSAGES)
function getRecentMessages(sessionId, limit = 5) {
    // Get recent messages in descending order, then reverse to get chronological order
    const messages = db.prepare(
        'SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(sessionId, limit);
    return messages.reverse();
}

// Clear all messages for a session (for "clear conversation" feature)
function clearSessionMessages(sessionId) {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
}

module.exports = {
    createSession,
    getSession,
    updateLastActive,
    deleteSession,
    addMessage,
    getMessages,
    getRecentMessages,
    clearSessionMessages
};