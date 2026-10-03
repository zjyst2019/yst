// services/logger.js
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(LOG_DIR, 'ingest.log');

// Max log file size before rotation (10MB)
const MAX_LOG_SIZE = 10 * 1024 * 1024;
// When trimming, keep this many most recent lines
const KEEP_LINES = 500;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function rotateIfNeeded() {
    try {
        const stats = fs.statSync(LOG_FILE);
        if (stats.size <= MAX_LOG_SIZE) return;

        const content = fs.readFileSync(LOG_FILE, 'utf-8');
        const lines = content.trim().split('\n');
        if (lines.length <= KEEP_LINES) return;

        const kept = lines.slice(-KEEP_LINES);
        fs.writeFileSync(LOG_FILE, kept.join('\n') + '\n', 'utf-8');
        console.log(`[Logger] Rotation: trimmed to last ${KEEP_LINES} lines (was ${lines.length})`);
    } catch (e) {
        // File might not exist yet or race condition, skip rotation
    }
}

function logIngest(entry) {
    const record = {
        timestamp: new Date().toISOString(),
        ...entry
    };
    const line = JSON.stringify(record) + '\n';
    try {
        fs.appendFileSync(LOG_FILE, line, 'utf-8');
        rotateIfNeeded();
    } catch (e) {
        console.error('[Logger] Failed to write log:', e.message);
    }
    // Also print to console for real-time visibility
    const source = record.source || 'unknown';
    const file = record.file || record.question || '-';
    const status = record.status || 'unknown';
    console.log(`[Ingest Log] ${source} | ${status} | ${file}`);
}

function getRecentLogs(limit = 50) {
    try {
        if (!fs.existsSync(LOG_FILE)) return [];
        const content = fs.readFileSync(LOG_FILE, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        return lines.slice(-limit).map(l => {
            try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(Boolean);
    } catch (e) {
        return [];
    }
}

module.exports = { logIngest, getRecentLogs };
