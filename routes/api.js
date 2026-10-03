// routes/api.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const db = require('../db/database');
const fs = require('fs');
const path = require('path');

// Get work directory from Claude service
const claudeService = require('../services/claude');
const qaCache = require('../services/qaCache');

// Admin auth — simple token-based, in-memory store
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin';
const authTokens = new Map();

function authMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (!token || !authTokens.has(token)) {
        return res.status(401).json({ error: '需要管理员登录后才能执行此操作' });
    }
    next();
}

// Helper to safely resolve paths
function safeResolve(workDir, subPath) {
    const resolved = path.resolve(workDir, subPath || '');
    // Security check: ensure path is within workDir
    if (!resolved.startsWith(path.resolve(workDir))) {
        return null;
    }
    return resolved;
}

// Auth endpoints
router.post('/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = crypto.randomBytes(32).toString('hex');
        authTokens.set(token, { username, loginAt: new Date().toISOString() });
        return res.json({ success: true, token });
    }
    res.status(401).json({ error: '用户名或密码错误' });
});

router.post('/auth/logout', (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '');
    authTokens.delete(token);
    res.json({ success: true });
});

router.get('/auth/status', (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '');
    const valid = !!(token && authTokens.has(token));
    res.json({ loggedIn: valid });
});

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

// Get file list with directory navigation
router.get('/files', (req, res) => {
    const workDir = claudeService.getWorkDir();
    const subPath = req.query.path || '';

    const targetDir = safeResolve(workDir, subPath);
    if (!targetDir) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(targetDir)) {
        return res.status(404).json({ error: 'Directory not found' });
    }

    try {
        const items = fs.readdirSync(targetDir)
            .filter(name => !name.startsWith('.')) // Filter hidden files
            .map(name => {
                const itemPath = path.join(targetDir, name);
                const stats = fs.statSync(itemPath);
                const relativePath = subPath ? `${subPath}/${name}` : name;
                return {
                    name: name,
                    path: relativePath,
                    type: stats.isDirectory() ? 'directory' : 'file',
                    size: stats.isDirectory() ? 0 : stats.size,
                    modified: stats.mtime
                };
            });

        // Sort: directories first, then files
        items.sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            return a.type === 'directory' ? -1 : 1;
        });

        res.json({
            files: items,
            currentPath: subPath,
            parentPath: subPath ? subPath.split('/').slice(0, -1).join('/') : null
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to read directory: ' + e.message });
    }
});

// Get file content
router.get('/files/content', (req, res) => {
    const workDir = claudeService.getWorkDir();
    const filePath = req.query.path || '';

    const targetFile = safeResolve(workDir, filePath);
    if (!targetFile) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(targetFile)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const stats = fs.statSync(targetFile);
    if (stats.isDirectory()) {
        return res.status(400).json({ error: 'Cannot read directory content' });
    }

    // Check file size limit (5MB for text files)
    if (stats.size > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'File too large (max 5MB)' });
    }

    try {
        const content = fs.readFileSync(targetFile, 'utf-8');
        res.json({
            filename: path.basename(filePath),
            content: content,
            size: stats.size
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to read file: ' + e.message });
    }
});

// Upload file with path support
router.post('/files/upload', (req, res) => {
    const workDir = claudeService.getWorkDir();
    const targetPath = req.query.path || ''; // Optional subdirectory

    const targetDir = safeResolve(workDir, targetPath);
    if (!targetDir) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const Busboy = require('busboy');
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } });

    let uploadedFiles = [];

    busboy.on('file', (fieldname, file, info, encoding, mimetype) => {
        // busboy v1.x passes info as { filename, encoding, mimeType } object
        const filename = typeof info === 'object' ? info.filename : info;
        const savePath = path.join(targetDir, filename);
        const writeStream = fs.createWriteStream(savePath);

        file.pipe(writeStream);

        writeStream.on('finish', () => {
            uploadedFiles.push({ filename, size: fs.statSync(savePath).size });
        });
    });

    busboy.on('finish', () => {
        res.json({
            success: true,
            files: uploadedFiles
        });
    });

    busboy.on('error', (err) => {
        res.status(500).json({ error: 'Upload failed: ' + err.message });
    });

    req.pipe(busboy);
});

// Delete file or directory (requires admin login)
router.delete('/files', authMiddleware, (req, res) => {
    const workDir = claudeService.getWorkDir();
    const filePath = req.query.path || '';

    if (!filePath) {
        return res.status(400).json({ error: 'File path required' });
    }

    const targetPath = safeResolve(workDir, filePath);
    if (!targetPath) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    try {
        const stats = fs.statSync(targetPath);
        if (stats.isDirectory()) {
            fs.rmSync(targetPath, { recursive: true, force: false });
        } else {
            fs.unlinkSync(targetPath);
        }
        res.json({ success: true, path: filePath });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete: ' + e.message });
    }
});

// Create directory
router.post('/files/create-directory', (req, res) => {
    const workDir = claudeService.getWorkDir();
    const { path: targetPath, name } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Directory name required' });
    }

    const parentDir = safeResolve(workDir, targetPath);
    if (!parentDir) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const newDirPath = path.join(parentDir, name);

    try {
        fs.mkdirSync(newDirPath, { recursive: false });
        res.json({ success: true, path: targetPath ? `${targetPath}/${name}` : name });
    } catch (e) {
        if (e.code === 'EEXIST') {
            return res.status(400).json({ error: 'Directory already exists' });
        }
        res.status(500).json({ error: 'Failed to create directory: ' + e.message });
    }
});

// Cache API endpoints
router.get('/cache/stats', (req, res) => {
    const stats = qaCache.getStats();
    res.json(stats);
});

router.delete('/cache', (req, res) => {
    qaCache.clearAll();
    res.json({ success: true });
});

router.post('/cache/refresh', (req, res) => {
    const { hasUpdate, updatedFiles } = qaCache.checkKnowledgeBaseUpdate();
    if (hasUpdate) {
        qaCache.clearCacheByFiles(updatedFiles);
    }
    res.json({ hasUpdate, updatedFiles });
});

// Trigger knowledge ingestion for files in upload directory
router.post('/knowledge/ingest', async (req, res) => {
    const knowledgeIngest = require('../services/knowledgeIngest');
    const workDir = claudeService.getWorkDir();
    const uploadDir = process.env.KNOWLEDGE_UPLOAD_DIR || path.join(workDir, 'upload');
    const processedDir = path.join(uploadDir, 'processed');
    const failedDir = path.join(uploadDir, 'failed');
    const userConfig = req.body.config || null;
    const selectedFiles = req.body.files || null;   // Optional: specific files to ingest
    const extraPrompt = req.body.extraPrompt || null; // Optional: user-provided guidance

    if (!fs.existsSync(processedDir)) {
        fs.mkdirSync(processedDir, { recursive: true });
    }
    if (!fs.existsSync(failedDir)) {
        fs.mkdirSync(failedDir, { recursive: true });
    }

    try {
        const supportedFormats = /\.(pdf|docx?|xlsx?|pptx?|md|txt|csv)$/i;
        let files = fs.readdirSync(uploadDir).filter(f => {
            const fullPath = path.join(uploadDir, f);
            return fs.statSync(fullPath).isFile() && supportedFormats.test(f);
        });

        // Filter to selected files if provided
        if (selectedFiles && selectedFiles.length > 0) {
            files = files.filter(f => selectedFiles.includes(f));
        }

        if (files.length === 0) {
            return res.json({ success: true, ingested: 0, message: 'No files to ingest' });
        }

        const results = [];
        for (const file of files) {
            const filePath = path.join(uploadDir, file);
            console.log(`[API Ingest] Processing: ${file}`);

            try {
                // Let Claude read the file directly (supports PDF/DOCX/XLSX/PPTX/MD/TXT/CSV)
                const kbPath = await knowledgeIngest.ingestFile(filePath, userConfig, extraPrompt);
                const destPath = path.join(kbPath ? processedDir : failedDir, file);
                if (fs.existsSync(filePath)) {
                    fs.renameSync(filePath, destPath);
                } else {
                    console.warn(`[API Ingest] Source file vanished: ${filePath}`);
                }
                if (kbPath) {
                    results.push({ file, status: 'ingested', kbPath });
                    console.log(`[API Ingest] Done: ${file}`);
                } else {
                    results.push({ file, status: 'failed', error: 'Ingestion returned no output' });
                    console.error(`[API Ingest] Failed: ${file}`);
                }
            } catch (e) {
                const destPath = path.join(failedDir, file);
                try { if (fs.existsSync(filePath)) fs.renameSync(filePath, destPath); } catch (_) {}
                results.push({ file, status: 'error', error: e.message });
                console.error(`[API Ingest] Error ${file}:`, e.message);
            }
        }

        res.json({
            success: true,
            ingested: results.filter(r => r.status === 'ingested').length,
            results
        });
    } catch (e) {
        res.status(500).json({ error: 'Ingestion failed: ' + e.message });
    }
});

// Get ingest logs
router.get('/knowledge/logs', (req, res) => {
    const logger = require('../services/logger');
    const limit = parseInt(req.query.limit) || 50;
    const logs = logger.getRecentLogs(limit);
    res.json({ logs, total: logs.length });
});

module.exports = router;