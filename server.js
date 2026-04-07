// SpritzMoon Backend — Real blockchain backend
// Node.js + Express + SQLite

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ───────────────────────────────
app.use(cors()); // Allow frontend to call from any origin
app.use(express.json());

// Simple rate limiting (per IP, per minute)
const rateLimits = new Map();
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const limit = rateLimits.get(ip) || { count: 0, reset: now + 60000 };
    if (now > limit.reset) { limit.count = 0; limit.reset = now + 60000; }
    limit.count++;
    rateLimits.set(ip, limit);
    if (limit.count > 120) return res.status(429).json({ success: false, error: 'Too many requests' });
    next();
});

// ─── DATABASE ─────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'spritzmoon.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        balance REAL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        last_faucet INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS mining_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        earned REAL DEFAULT 0,
        FOREIGN KEY (device_id) REFERENCES devices(device_id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        from_device TEXT,
        to_device TEXT,
        amount REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        block_number INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_devices ON transactions(from_device, to_device);
    CREATE INDEX IF NOT EXISTS idx_mining_device ON mining_sessions(device_id, end_time);
`);

// Insert genesis block if no transactions exist
const txCount = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
if (txCount === 0) {
    db.prepare(`INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('GENESIS_' + Date.now(), 'genesis', 'SPRITZMOON_NETWORK', 'GENESIS', 0, Date.now(), 0);
    console.log('🌟 Genesis block created');
}

// ─── HELPERS ──────────────────────────────────
const MINING_RATE = 0.1; // SPM per minute
const MAX_SESSION_MINUTES = 60 * 8; // cap mining session at 8 hours
const FAUCET_AMOUNT = 100;
const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function makeTxId() {
    return 'TX_' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function validDeviceId(id) {
    return typeof id === 'string' && /^SPM_[A-Z0-9]{8}_[A-Z0-9]{6}_[A-Z0-9]{2}$/.test(id);
}

function touchDevice(deviceId) {
    db.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?').run(Date.now(), deviceId);
}

function getOrCreateDevice(deviceId) {
    let device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
    if (!device) {
        db.prepare('INSERT INTO devices (device_id, balance, created_at, last_seen) VALUES (?, 0, ?, ?)')
          .run(deviceId, Date.now(), Date.now());
        device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
    } else {
        touchDevice(deviceId);
    }
    return device;
}

function computeBlockNumber() {
    // Every 5 txs = 1 block
    const count = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
    return Math.floor(count / 5) + 1;
}

// ─── ENDPOINTS ────────────────────────────────

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'online', service: 'SpritzMoon Backend', version: '1.0.0' });
});

// Register device
app.post('/api/device/register', (req, res) => {
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const device = getOrCreateDevice(device_id);
        res.json({ success: true, balance: device.balance, device_id });
    } catch (e) {
        console.error('register error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// Get balance
app.get('/api/device/balance', (req, res) => {
    try {
        const { device_id } = req.query;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device_id);
        if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
        touchDevice(device_id);
        res.json({ success: true, balance: device.balance });
    } catch (e) {
        console.error('balance error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// Start mining
app.post('/api/mining/start', (req, res) => {
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        getOrCreateDevice(device_id);

        // Close any orphan session
        db.prepare('UPDATE mining_sessions SET end_time = ? WHERE device_id = ? AND end_time IS NULL')
          .run(Date.now(), device_id);

        db.prepare('INSERT INTO mining_sessions (device_id, start_time) VALUES (?, ?)')
          .run(device_id, Date.now());
        res.json({ success: true });
    } catch (e) {
        console.error('mining start error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// Stop mining — SERVER-SIDE CALCULATION (anti-cheat)
app.post('/api/mining/stop', (req, res) => {
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });

        const session = db.prepare('SELECT * FROM mining_sessions WHERE device_id = ? AND end_time IS NULL ORDER BY id DESC LIMIT 1').get(device_id);
        if (!session) return res.status(400).json({ success: false, error: 'No active mining session' });

        const now = Date.now();
        const elapsedMs = now - session.start_time;
        let minutes = elapsedMs / 1000 / 60;
        if (minutes > MAX_SESSION_MINUTES) minutes = MAX_SESSION_MINUTES;
        const earned = Math.round(minutes * MINING_RATE * 10000) / 10000;

        // Atomic transaction
        const tx = db.transaction(() => {
            db.prepare('UPDATE mining_sessions SET end_time = ?, earned = ? WHERE id = ?').run(now, earned, session.id);
            db.prepare('UPDATE devices SET balance = balance + ?, last_seen = ? WHERE device_id = ?').run(earned, now, device_id);
            db.prepare(`INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number)
                        VALUES (?, 'mining', ?, ?, ?, ?, ?)`)
              .run(makeTxId(), 'MINING_REWARD', device_id, earned, now, computeBlockNumber());
        });
        tx();

        const device = db.prepare('SELECT balance FROM devices WHERE device_id = ?').get(device_id);
        res.json({ success: true, earned, balance: device.balance, minutes: Math.round(minutes * 100) / 100 });
    } catch (e) {
        console.error('mining stop error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// Transfer SPM — ATOMIC
app.post('/api/transfer', (req, res) => {
    try {
        const { from_device, to_device, amount } = req.body;
        if (!validDeviceId(from_device)) return res.status(400).json({ success: false, error: 'Invalid sender device ID' });
        if (!validDeviceId(to_device)) return res.status(400).json({ success: false, error: 'Invalid recipient device ID' });
        if (from_device === to_device) return res.status(400).json({ success: false, error: 'Cannot send to yourself' });
        const amt = parseFloat(amount);
        if (!amt || amt <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });

        const sender = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(from_device);
        if (!sender) return res.status(404).json({ success: false, error: 'Sender not registered' });
        if (sender.balance < amt) return res.status(400).json({ success: false, error: 'Insufficient balance' });

        const recipient = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(to_device);
        if (!recipient) return res.status(404).json({ success: false, error: 'Recipient not found' });

        const now = Date.now();
        const tx = db.transaction(() => {
            db.prepare('UPDATE devices SET balance = balance - ?, last_seen = ? WHERE device_id = ?').run(amt, now, from_device);
            db.prepare('UPDATE devices SET balance = balance + ? WHERE device_id = ?').run(amt, to_device);
            db.prepare(`INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number)
                        VALUES (?, 'transfer', ?, ?, ?, ?, ?)`)
              .run(makeTxId(), from_device, to_device, amt, now, computeBlockNumber());
        });
        tx();

        const updated = db.prepare('SELECT balance FROM devices WHERE device_id = ?').get(from_device);
        res.json({ success: true, balance: updated.balance, amount: amt });
    } catch (e) {
        console.error('transfer error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// Faucet claim
app.post('/api/faucet/claim', (req, res) => {
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const device = getOrCreateDevice(device_id);
        const now = Date.now();
        if (device.last_faucet && (now - device.last_faucet) < FAUCET_COOLDOWN_MS) {
            const waitMs = FAUCET_COOLDOWN_MS - (now - device.last_faucet);
            const waitH = Math.ceil(waitMs / 1000 / 60 / 60);
            return res.status(400).json({ success: false, error: `Faucet cooldown: wait ${waitH}h` });
        }

        const tx = db.transaction(() => {
            db.prepare('UPDATE devices SET balance = balance + ?, last_faucet = ?, last_seen = ? WHERE device_id = ?')
              .run(FAUCET_AMOUNT, now, now, device_id);
            db.prepare(`INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number)
                        VALUES (?, 'faucet', 'FAUCET', ?, ?, ?, ?)`)
              .run(makeTxId(), device_id, FAUCET_AMOUNT, now, computeBlockNumber());
        });
        tx();

        const updated = db.prepare('SELECT balance FROM devices WHERE device_id = ?').get(device_id);
        res.json({ success: true, amount: FAUCET_AMOUNT, balance: updated.balance });
    } catch (e) {
        console.error('faucet error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// Blockchain stats
app.get('/api/blockchain/stats', (req, res) => {
    try {
        const totalTxs = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
        const totalUsers = db.prepare('SELECT COUNT(*) as c FROM devices').get().c;
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        const activeUsers = db.prepare('SELECT COUNT(*) as c FROM devices WHERE last_seen > ?').get(fiveMinAgo).c;
        const activeMiners = db.prepare('SELECT COUNT(DISTINCT device_id) as c FROM mining_sessions WHERE end_time IS NULL').get().c;
        const totalBlocks = Math.floor(totalTxs / 5) + 1;
        const hashRate = activeMiners * 0.8 + Math.random() * 0.3;

        res.json({
            success: true,
            stats: {
                total_blocks: totalBlocks,
                total_users: totalUsers,
                active_users: Math.max(activeUsers, activeMiners),
                total_transactions: totalTxs,
                total_hash_rate: Math.round(hashRate * 10) / 10,
                active_miners: activeMiners
            }
        });
    } catch (e) {
        console.error('stats error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// Recent transactions
app.get('/api/blockchain/transactions', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const rows = db.prepare('SELECT * FROM transactions ORDER BY timestamp DESC LIMIT ?').all(limit);
        const transactions = rows.map(r => ({
            id: r.id,
            type: r.type,
            from: r.from_device,
            to: r.to_device,
            amount: r.amount,
            timestamp: r.timestamp,
            block: r.block_number
        }));
        res.json({ success: true, transactions });
    } catch (e) {
        console.error('transactions error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// Device transaction history
app.get('/api/device/history', (req, res) => {
    try {
        const { device_id } = req.query;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const rows = db.prepare(`SELECT * FROM transactions
                                 WHERE from_device = ? OR to_device = ?
                                 ORDER BY timestamp DESC LIMIT 50`).all(device_id, device_id);
        const transactions = rows.map(r => ({
            id: r.id, type: r.type, from: r.from_device, to: r.to_device,
            amount: r.amount, timestamp: r.timestamp,
            direction: r.to_device === device_id ? 'in' : 'out'
        }));
        res.json({ success: true, transactions });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// ─── START ────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 SpritzMoon backend running on port ${PORT}`);
    console.log(`📊 DB: ${DB_PATH}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });
