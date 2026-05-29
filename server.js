const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Config
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD || 'ihl2024';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-332168835e924b0aa43e6b4bd3d19634';
const DATA_DIR = path.join(__dirname, 'data');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');

// Simple token store (in-memory + file)
let validTokens = new Set();

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load tokens from file
if (fs.existsSync(TOKENS_FILE)) {
    try {
        const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
        validTokens = new Set(tokens);
    } catch (e) { /* ignore */ }
}

function saveTokens() {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify([...validTokens]));
}

// Read records from JSON file
function readRecords() {
    try {
        if (fs.existsSync(RECORDS_FILE)) {
            return JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error reading records:', e.message);
    }
    return [];
}

// Write records to JSON file
function writeRecords(records) {
    fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2), 'utf8');
}

// Middleware
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

// Auth middleware for manager routes
function managerAuth(req, res, next) {
    const token = req.query.token || req.headers['x-auth-token'];
    if (!token || !validTokens.has(token)) {
        return res.status(401).json({ error: 'Unauthorized. Please login first.' });
    }
    next();
}

// ========== API Routes ==========

// Manager login
app.post('/api/auth', (req, res) => {
    const { password } = req.body;
    if (password === MANAGER_PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        validTokens.add(token);
        saveTokens();
        return res.json({ success: true, token });
    }
    res.status(403).json({ success: false, error: '密码错误' });
});

// Manager logout
app.post('/api/auth/logout', (req, res) => {
    const token = req.query.token || req.headers['x-auth-token'];
    if (token) {
        validTokens.delete(token);
        saveTokens();
    }
    res.json({ success: true });
});

// Save a practice record (no auth needed - any user can submit)
app.post('/api/records', (req, res) => {
    try {
        const record = req.body;

        // Validate required fields
        if (!record.user || !record.total || !record.scores) {
            return res.status(400).json({ error: 'Invalid record data' });
        }

        // Add server timestamp and ID if not present
        record.id = record.id || Date.now();
        record.serverTime = new Date().toISOString();

        const records = readRecords();
        records.push(record);
        writeRecords(records);

        res.json({ success: true, id: record.id, total: records.length });
    } catch (e) {
        console.error('Save record error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all records (manager only)
app.get('/api/records', managerAuth, (req, res) => {
    try {
        let records = readRecords();

        // Filters
        const { userId, startDate, endDate, limit } = req.query;
        if (userId) records = records.filter(r => r.user && r.user.id === userId);
        if (startDate) records = records.filter(r => r.time >= startDate);
        if (endDate) records = records.filter(r => r.time <= endDate + 'T23:59:59.999Z');

        // Sort newest first
        records.sort((a, b) => new Date(b.time) - new Date(a.time));

        if (limit) records = records.slice(0, parseInt(limit));

        res.json({ success: true, count: records.length, records });
    } catch (e) {
        console.error('Get records error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get aggregate stats (manager only)
app.get('/api/stats', managerAuth, (req, res) => {
    try {
        const records = readRecords();

        if (records.length === 0) {
            return res.json({
                success: true,
                totalPractices: 0,
                activeUsers: 0,
                avgScore: 0,
                maxScore: 0,
                scoreDistribution: { '0-10': 0, '11-20': 0, '21-30': 0, '31-40': 0, '41-50': 0 },
                dimensionAvgs: { knowledge: 0, discovery: 0, competition: 0, objection: 0, technique: 0 },
                roleDistribution: {},
                userStats: []
            });
        }

        // Active users
        const userIds = new Set(records.map(r => r.user && r.user.id).filter(Boolean));

        // Score stats
        const scores = records.map(r => r.total);
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        const maxScore = Math.max(...scores);

        // Score distribution
        const dist = { '0-10': 0, '11-20': 0, '21-30': 0, '31-40': 0, '41-50': 0 };
        scores.forEach(s => {
            if (s <= 10) dist['0-10']++;
            else if (s <= 20) dist['11-20']++;
            else if (s <= 30) dist['21-30']++;
            else if (s <= 40) dist['31-40']++;
            else dist['41-50']++;
        });

        // Dimension averages
        const dims = ['knowledge', 'discovery', 'competition', 'objection', 'technique'];
        const dimAvgs = {};
        dims.forEach(d => {
            const vals = records.map(r => r.scores[d] || 0);
            dimAvgs[d] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
        });

        // Role distribution
        const roleDist = {};
        records.forEach(r => {
            const key = (r.roleType || '未知') + '·' + (r.attitude || '未知');
            roleDist[key] = (roleDist[key] || 0) + 1;
        });

        // Per-user stats
        const userMap = {};
        records.forEach(r => {
            const uid = r.user && r.user.id;
            const uname = r.user && r.user.name || '未知';
            if (!uid) return;
            if (!userMap[uid]) {
                userMap[uid] = { userId: uid, name: uname, count: 0, totalScore: 0, maxScore: 0, lastPractice: '' };
            }
            userMap[uid].count++;
            userMap[uid].totalScore += r.total;
            userMap[uid].maxScore = Math.max(userMap[uid].maxScore, r.total);
            if (r.time > userMap[uid].lastPractice) userMap[uid].lastPractice = r.time;
        });
        const userStats = Object.values(userMap).map(u => ({
            ...u,
            avgScore: Math.round((u.totalScore / u.count) * 10) / 10
        })).sort((a, b) => b.count - a.count);

        res.json({
            success: true,
            totalPractices: records.length,
            activeUsers: userIds.size,
            avgScore: Math.round(avgScore * 10) / 10,
            maxScore,
            scoreDistribution: dist,
            dimensionAvgs: dimAvgs,
            roleDistribution: roleDist,
            userStats
        });
    } catch (e) {
        console.error('Stats error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get single record detail (manager only)
app.get('/api/records/:id', managerAuth, (req, res) => {
    try {
        const records = readRecords();
        const record = records.find(r => String(r.id) === req.params.id);
        if (!record) return res.status(404).json({ error: 'Record not found' });
        res.json({ success: true, record });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ========== AI Chat Proxy (DeepSeek) ==========
app.post('/api/chat', async (req, res) => {
    const { messages, systemPrompt } = req.body;
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages array required' });
    }

    // Support runtime key update
    const activeKey = global.__DEEPSEEK_KEY_OVERRIDE__ || DEEPSEEK_API_KEY;
    if (!activeKey) {
        return res.status(503).json({ error: 'AI Key未配置，请在设置中输入DeepSeek API Key' });
    }

    const payload = JSON.stringify({
        model: 'deepseek-chat',
        messages: [
            { role: 'system', content: systemPrompt || '你是一位专业的医生。' },
            ...messages
        ],
        max_tokens: 300,
        temperature: 0.85,
        stream: false
    });

    const options = {
        hostname: 'api.deepseek.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${activeKey}`,
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => { data += chunk; });
        proxyRes.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                if (parsed.choices && parsed.choices[0]) {
                    const reply = parsed.choices[0].message.content.trim();
                    res.json({ success: true, reply });
                } else {
                    console.error('DeepSeek unexpected response:', data);
                    res.status(500).json({ error: 'AI返回格式异常', raw: data });
                }
            } catch (e) {
                res.status(500).json({ error: 'JSON解析失败', raw: data });
            }
        });
    });

    proxyReq.on('error', (e) => {
        console.error('DeepSeek API error:', e.message);
        res.status(500).json({ error: e.message });
    });

    proxyReq.setTimeout(20000, () => {
        proxyReq.destroy();
        res.status(504).json({ error: 'AI请求超时，已切换本地模式' });
    });

    proxyReq.write(payload);
    proxyReq.end();
});

// Update AI key at runtime (no restart needed)
app.post('/api/set-ai-key', (req, res) => {
    const { key } = req.body;
    if (!key || !key.startsWith('sk-')) {
        return res.status(400).json({ error: 'Invalid key format' });
    }
    // Update in-memory key for subsequent requests
    process.env.DEEPSEEK_API_KEY = key;
    // Reassign module-level constant equivalent via closure
    global.__DEEPSEEK_KEY_OVERRIDE__ = key;
    console.log('DeepSeek API key updated at', new Date().toISOString());
    res.json({ success: true });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString(), aiEnabled: !!DEEPSEEK_API_KEY });
});

// Start server
app.listen(PORT, () => {
    console.log(`伊赫莱训练平台已启动: http://localhost:${PORT}`);
    console.log(`前端页面: http://localhost:${PORT}`);
    console.log(`管理者看板: http://localhost:${PORT}/dashboard.html`);
    console.log(`数据存储: ${RECORDS_FILE}`);
});
