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