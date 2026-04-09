// SpritzMoon Backend — PostgreSQL version (Neon)
// Node.js + Express + pg

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ───────────────────────────────
app.use(cors());
app.use(express.json());

// Rate limiting
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
if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable is required!');
    console.error('   Get a free Postgres database at https://neon.tech');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
    console.error('Unexpected pool error:', err);
});

async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                balance DOUBLE PRECISION DEFAULT 0,
                created_at BIGINT NOT NULL,
                last_seen BIGINT NOT NULL,
                last_faucet BIGINT DEFAULT 0
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS mining_sessions (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                start_time BIGINT NOT NULL,
                end_time BIGINT,
                earned DOUBLE PRECISION DEFAULT 0
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                from_device TEXT,
                to_device TEXT,
                amount DOUBLE PRECISION NOT NULL,
                timestamp BIGINT NOT NULL,
                block_number INTEGER
            );
        `);

        await client.query('CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp DESC);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_tx_devices ON transactions(from_device, to_device);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_mining_device ON mining_sessions(device_id, end_time);');

        const txCheck = await client.query('SELECT COUNT(*) AS c FROM transactions');
        if (parseInt(txCheck.rows[0].c) === 0) {
            await client.query(
                `INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                ['GENESIS_' + Date.now(), 'genesis', 'SPRITZMOON_NETWORK', 'GENESIS', 0, Date.now(), 0]
            );
            console.log('🌟 Genesis block created');
        }

        console.log('✅ Database schema ready');
    } finally {
        client.release();
    }
}

// ─── HELPERS ──────────────────────────────────
const MINING_RATE = 0.1;
const MAX_SESSION_MINUTES = 60 * 8;
const FAUCET_AMOUNT = 100;
const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function makeTxId() {
    return 'TX_' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function validDeviceId(id) {
    return typeof id === 'string' && /^SPM_[A-Z0-9]{8}_[A-Z0-9]{6}_[A-Z0-9]{2}$/.test(id);
}

async function touchDevice(deviceId) {
    await pool.query('UPDATE devices SET last_seen = $1 WHERE device_id = $2', [Date.now(), deviceId]);
}

async function getOrCreateDevice(deviceId) {
    let result = await pool.query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    if (result.rows.length === 0) {
        await pool.query(
            'INSERT INTO devices (device_id, balance, created_at, last_seen) VALUES ($1, 0, $2, $3) ON CONFLICT (device_id) DO NOTHING',
            [deviceId, Date.now(), Date.now()]
        );
        result = await pool.query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    } else {
        await touchDevice(deviceId);
    }
    return result.rows[0];
}

async function computeBlockNumber() {
    const r = await pool.query('SELECT COUNT(*) AS c FROM transactions');
    return Math.floor(parseInt(r.rows[0].c) / 5) + 1;
}

// ─── ENDPOINTS ────────────────────────────────

app.get('/', (req, res) => {
    res.json({ status: 'online', service: 'SpritzMoon Backend', version: '2.0.0', database: 'postgres' });
});

app.post('/api/device/register', async (req, res) => {
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const device = await getOrCreateDevice(device_id);
        res.json({ success: true, balance: parseFloat(device.balance), device_id });
    } catch (e) {
        console.error('register error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

app.get('/api/device/balance', async (req, res) => {
    try {
        const { device_id } = req.query;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const result = await pool.query('SELECT * FROM devices WHERE device_id = $1', [device_id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Device not found' });
        await touchDevice(device_id);
        res.json({ success: true, balance: parseFloat(result.rows[0].balance) });
    } catch (e) {
        console.error('balance error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

app.post('/api/mining/start', async (req, res) => {
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        await getOrCreateDevice(device_id);

        await pool.query(
            'UPDATE mining_sessions SET end_time = $1 WHERE device_id = $2 AND end_time IS NULL',
            [Date.now(), device_id]
        );

        await pool.query(
            'INSERT INTO mining_sessions (device_id, start_time) VALUES ($1, $2)',
            [device_id, Date.now()]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('mining start error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

app.post('/api/mining/stop', async (req, res) => {
    const client = await pool.connect();
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) {
            return res.status(400).json({ success: false, error: 'Invalid device ID' });
        }

        const sessionResult = await client.query(
            'SELECT * FROM mining_sessions WHERE device_id = $1 AND end_time IS NULL ORDER BY id DESC LIMIT 1',
            [device_id]
        );

        if (sessionResult.rows.length === 0) {
            return res.status(400).json({ success: false, error: 'No active mining session' });
        }

        const session = sessionResult.rows[0];
        const now = Date.now();
        const elapsedMs = now - parseInt(session.start_time);
        let minutes = elapsedMs / 1000 / 60;
        if (minutes > MAX_SESSION_MINUTES) minutes = MAX_SESSION_MINUTES;
        const earned = Math.round(minutes * MINING_RATE * 10000) / 10000;
        const blockNum = await computeBlockNumber();

        await client.query('BEGIN');
        try {
            await client.query(
                'UPDATE mining_sessions SET end_time = $1, earned = $2 WHERE id = $3',
                [now, earned, session.id]
            );
            await client.query(
                'UPDATE devices SET balance = balance + $1, last_seen = $2 WHERE device_id = $3',
                [earned, now, device_id]
            );
            await client.query(
                `INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number)
                 VALUES ($1, 'mining', $2, $3, $4, $5, $6)`,
                [makeTxId(), 'MINING_REWARD', device_id, earned, now, blockNum]
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }

        const balResult = await client.query('SELECT balance FROM devices WHERE device_id = $1', [device_id]);
        res.json({
            success: true,
            earned,
            balance: parseFloat(balResult.rows[0].balance),
            minutes: Math.round(minutes * 100) / 100
        });
    } catch (e) {
        console.error('mining stop error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    } finally {
        client.release();
    }
});

app.post('/api/transfer', async (req, res) => {
    const client = await pool.connect();
    try {
        const { from_device, to_device, amount } = req.body;
        if (!validDeviceId(from_device)) return res.status(400).json({ success: false, error: 'Invalid sender device ID' });
        if (!validDeviceId(to_device)) return res.status(400).json({ success: false, error: 'Invalid recipient device ID' });
        if (from_device === to_device) return res.status(400).json({ success: false, error: 'Cannot send to yourself' });
        const amt = parseFloat(amount);
        if (!amt || amt <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });

        const senderResult = await client.query('SELECT * FROM devices WHERE device_id = $1', [from_device]);
        if (senderResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Sender not registered' });
        if (parseFloat(senderResult.rows[0].balance) < amt) return res.status(400).json({ success: false, error: 'Insufficient balance' });

        const recipientResult = await client.query('SELECT * FROM devices WHERE device_id = $1', [to_device]);
        if (recipientResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Recipient not found' });

        const now = Date.now();
        const blockNum = await computeBlockNumber();

        await client.query('BEGIN');
        try {
            await client.query(
                'UPDATE devices SET balance = balance - $1, last_seen = $2 WHERE device_id = $3',
                [amt, now, from_device]
            );
            await client.query(
                'UPDATE devices SET balance = balance + $1 WHERE device_id = $2',
                [amt, to_device]
            );
            await client.query(
                `INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number)
                 VALUES ($1, 'transfer', $2, $3, $4, $5, $6)`,
                [makeTxId(), from_device, to_device, amt, now, blockNum]
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }

        const updated = await client.query('SELECT balance FROM devices WHERE device_id = $1', [from_device]);
        res.json({ success: true, balance: parseFloat(updated.rows[0].balance), amount: amt });
    } catch (e) {
        console.error('transfer error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    } finally {
        client.release();
    }
});

app.post('/api/faucet/claim', async (req, res) => {
    const client = await pool.connect();
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const device = await getOrCreateDevice(device_id);
        const now = Date.now();
        if (device.last_faucet && (now - parseInt(device.last_faucet)) < FAUCET_COOLDOWN_MS) {
            const waitMs = FAUCET_COOLDOWN_MS - (now - parseInt(device.last_faucet));
            const waitH = Math.ceil(waitMs / 1000 / 60 / 60);
            return res.status(400).json({ success: false, error: `Faucet cooldown: wait ${waitH}h` });
        }

        const blockNum = await computeBlockNumber();

        await client.query('BEGIN');
        try {
            await client.query(
                'UPDATE devices SET balance = balance + $1, last_faucet = $2, last_seen = $3 WHERE device_id = $4',
                [FAUCET_AMOUNT, now, now, device_id]
            );
            await client.query(
                `INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number)
                 VALUES ($1, 'faucet', 'FAUCET', $2, $3, $4, $5)`,
                [makeTxId(), device_id, FAUCET_AMOUNT, now, blockNum]
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }

        const updated = await client.query('SELECT balance FROM devices WHERE device_id = $1', [device_id]);
        res.json({ success: true, amount: FAUCET_AMOUNT, balance: parseFloat(updated.rows[0].balance) });
    } catch (e) {
        console.error('faucet error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    } finally {
        client.release();
    }
});

app.get('/api/blockchain/stats', async (req, res) => {
    try {
        const totalTxsR = await pool.query('SELECT COUNT(*) AS c FROM transactions');
        const totalUsersR = await pool.query('SELECT COUNT(*) AS c FROM devices');
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        const activeUsersR = await pool.query('SELECT COUNT(*) AS c FROM devices WHERE last_seen > $1', [fiveMinAgo]);
        const activeMinersR = await pool.query('SELECT COUNT(DISTINCT device_id) AS c FROM mining_sessions WHERE end_time IS NULL');

        const totalTxs = parseInt(totalTxsR.rows[0].c);
        const totalUsers = parseInt(totalUsersR.rows[0].c);
        const activeUsers = parseInt(activeUsersR.rows[0].c);
        const activeMiners = parseInt(activeMinersR.rows[0].c);
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

app.get('/api/blockchain/transactions', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const r = await pool.query('SELECT * FROM transactions ORDER BY timestamp DESC LIMIT $1', [limit]);
        const transactions = r.rows.map(row => ({
            id: row.id,
            type: row.type,
            from: row.from_device,
            to: row.to_device,
            amount: parseFloat(row.amount),
            timestamp: parseInt(row.timestamp),
            block: row.block_number
        }));
        res.json({ success: true, transactions });
    } catch (e) {
        console.error('transactions error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

app.get('/api/device/history', async (req, res) => {
    try {
        const { device_id } = req.query;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const r = await pool.query(
            `SELECT * FROM transactions
             WHERE from_device = $1 OR to_device = $1
             ORDER BY timestamp DESC LIMIT 50`,
            [device_id]
        );
        const transactions = r.rows.map(row => ({
            id: row.id,
            type: row.type,
            from: row.from_device,
            to: row.to_device,
            amount: parseFloat(row.amount),
            timestamp: parseInt(row.timestamp),
            direction: row.to_device === device_id ? 'in' : 'out'
        }));
        res.json({ success: true, transactions });
    } catch (e) {
        console.error('history error:', e);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// ─── START ────────────────────────────────────
initDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`🚀 SpritzMoon backend running on port ${PORT}`);
            console.log(`🐘 Database: PostgreSQL (Neon)`);
        });
    })
    .catch(err => {
        console.error('❌ Failed to initialize database:', err);
        process.exit(1);
    });

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
