// SpritzMoon Backend v2.1 — PostgreSQL + Telegram Bot
// Node.js + Express + pg + grammY

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const { Bot, InlineKeyboard, GrammyError, HttpError } = require('grammy');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ───────────────────────────────
app.use(cors());
app.use(express.json());

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
    console.error('❌ DATABASE_URL is required');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', (err) => console.error('Pool error:', err));

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

        // NEW: Telegram ↔ Device linking
        await client.query(`
            CREATE TABLE IF NOT EXISTS telegram_users (
                telegram_id BIGINT PRIMARY KEY,
                device_id TEXT NOT NULL,
                username TEXT,
                first_name TEXT,
                linked_at BIGINT NOT NULL,
                daily_streak INTEGER DEFAULT 0,
                last_daily BIGINT DEFAULT 0,
                lang TEXT DEFAULT 'it'
            );
        `);

        // NEW: Network-level events for celebrations
        await client.query(`
            CREATE TABLE IF NOT EXISTS milestones (
                id SERIAL PRIMARY KEY,
                type TEXT NOT NULL,
                value BIGINT NOT NULL,
                achieved_at BIGINT NOT NULL
            );
        `);

        await client.query('CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp DESC);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_tx_devices ON transactions(from_device, to_device);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_mining_device ON mining_sessions(device_id, end_time);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_tg_device ON telegram_users(device_id);');

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
const MAX_SUPPLY = 21_000_000;
const MAX_SESSION_MINUTES = 60 * 8;
const FAUCET_AMOUNT = 100;
const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Tokenomics phases — Spritz varieties with decreasing mining rates
const PHASES = [
    { id: 1, name: 'Campari',  emoji: '🔴', color: '#C8102E', from: 0,          to: 5_250_000,  rate: 0.10 },
    { id: 2, name: 'Aperol',   emoji: '🟠', color: '#FF6A2F', from: 5_250_000,  to: 10_500_000, rate: 0.05 },
    { id: 3, name: 'Select',   emoji: '🟤', color: '#8B1A1A', from: 10_500_000, to: 15_750_000, rate: 0.02 },
    { id: 4, name: 'Hugo',     emoji: '🟢', color: '#7FB069', from: 15_750_000, to: 21_000_000, rate: 0.005 }
];

function getPhaseForSupply(totalMined) {
    if (totalMined >= MAX_SUPPLY) return null; // cap reached
    for (const p of PHASES) {
        if (totalMined >= p.from && totalMined < p.to) return p;
    }
    return PHASES[PHASES.length - 1];
}

// Total minted = mining + faucet + daily (transfers don't create new SPM)
async function getTotalMined() {
    const r = await pool.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type IN ('mining', 'faucet', 'daily')"
    );
    return parseFloat(r.rows[0].total);
}

async function getCurrentMiningRate() {
    const total = await getTotalMined();
    const phase = getPhaseForSupply(total);
    return phase ? phase.rate : 0;
}
const DAILY_COOLDOWN_MS = 20 * 60 * 60 * 1000; // allow every 20h to be forgiving
const DAILY_BASE_REWARD = 10;
const ADMIN_TELEGRAM_ID = 1054120151;
const COMMUNITY_CHAT_ID = process.env.COMMUNITY_CHAT_ID ? parseInt(process.env.COMMUNITY_CHAT_ID) : null;

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
    let r = await pool.query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    if (r.rows.length === 0) {
        await pool.query(
            'INSERT INTO devices (device_id, balance, created_at, last_seen) VALUES ($1, 0, $2, $3) ON CONFLICT (device_id) DO NOTHING',
            [deviceId, Date.now(), Date.now()]
        );
        r = await pool.query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    } else {
        await touchDevice(deviceId);
    }
    return r.rows[0];
}

async function computeBlockNumber() {
    const r = await pool.query('SELECT COUNT(*) AS c FROM transactions');
    return Math.floor(parseInt(r.rows[0].c) / 5) + 1;
}

// ─── HTTP ENDPOINTS ───────────────────────────

app.get('/', (req, res) => {
    res.json({ status: 'online', service: 'SpritzMoon Backend', version: '2.1.0', database: 'postgres', bot: 'enabled' });
});

app.post('/api/device/register', async (req, res) => {
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const device = await getOrCreateDevice(device_id);
        res.json({ success: true, balance: parseFloat(device.balance), device_id });
    } catch (e) { console.error('register:', e); res.status(500).json({ success: false, error: 'Internal error' }); }
});

app.get('/api/device/balance', async (req, res) => {
    try {
        const { device_id } = req.query;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const r = await pool.query('SELECT * FROM devices WHERE device_id = $1', [device_id]);
        if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Device not found' });
        await touchDevice(device_id);
        res.json({ success: true, balance: parseFloat(r.rows[0].balance) });
    } catch (e) { console.error('balance:', e); res.status(500).json({ success: false, error: 'Internal error' }); }
});

app.post('/api/mining/start', async (req, res) => {
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        await getOrCreateDevice(device_id);
        await pool.query('UPDATE mining_sessions SET end_time = $1 WHERE device_id = $2 AND end_time IS NULL', [Date.now(), device_id]);
        await pool.query('INSERT INTO mining_sessions (device_id, start_time) VALUES ($1, $2)', [device_id, Date.now()]);
        res.json({ success: true });
    } catch (e) { console.error('mining start:', e); res.status(500).json({ success: false, error: 'Internal error' }); }
});

app.post('/api/mining/stop', async (req, res) => {
    const client = await pool.connect();
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const s = await client.query('SELECT * FROM mining_sessions WHERE device_id = $1 AND end_time IS NULL ORDER BY id DESC LIMIT 1', [device_id]);
        if (s.rows.length === 0) return res.status(400).json({ success: false, error: 'No active mining session' });
        const session = s.rows[0];
        const now = Date.now();
        const elapsedMs = now - parseInt(session.start_time);
        let minutes = elapsedMs / 1000 / 60;
        if (minutes > MAX_SESSION_MINUTES) minutes = MAX_SESSION_MINUTES;

        // Dynamic mining rate based on current phase
        const totalMined = await getTotalMined();
        const phase = getPhaseForSupply(totalMined);

        if (!phase) {
            // Cap reached — close session with zero reward
            await client.query('UPDATE mining_sessions SET end_time = $1, earned = 0 WHERE id = $2', [now, session.id]);
            return res.json({ success: true, earned: 0, balance: 0, minutes: Math.round(minutes * 100) / 100, cap_reached: true, message: 'Mining cap of 21M SPM reached — Spritz Completo!' });
        }

        let earned = Math.round(minutes * phase.rate * 10000) / 10000;

        // Don't exceed the cap
        const remainingInPhase = MAX_SUPPLY - totalMined;
        if (earned > remainingInPhase) earned = Math.round(remainingInPhase * 10000) / 10000;

        const blockNum = await computeBlockNumber();
        await client.query('BEGIN');
        try {
            await client.query('UPDATE mining_sessions SET end_time = $1, earned = $2 WHERE id = $3', [now, earned, session.id]);
            await client.query('UPDATE devices SET balance = balance + $1, last_seen = $2 WHERE device_id = $3', [earned, now, device_id]);
            await client.query(
                `INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number) VALUES ($1, 'mining', $2, $3, $4, $5, $6)`,
                [makeTxId(), 'MINING_REWARD', device_id, earned, now, blockNum]
            );
            await client.query('COMMIT');
        } catch (err) { await client.query('ROLLBACK'); throw err; }
        const bal = await client.query('SELECT balance FROM devices WHERE device_id = $1', [device_id]);
        res.json({
            success: true,
            earned,
            balance: parseFloat(bal.rows[0].balance),
            minutes: Math.round(minutes * 100) / 100,
            phase: { id: phase.id, name: phase.name, emoji: phase.emoji, rate: phase.rate }
        });
    } catch (e) { console.error('mining stop:', e); res.status(500).json({ success: false, error: 'Internal error' }); }
    finally { client.release(); }
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
        const sender = await client.query('SELECT * FROM devices WHERE device_id = $1', [from_device]);
        if (sender.rows.length === 0) return res.status(404).json({ success: false, error: 'Sender not registered' });
        if (parseFloat(sender.rows[0].balance) < amt) return res.status(400).json({ success: false, error: 'Insufficient balance' });
        const recipient = await client.query('SELECT * FROM devices WHERE device_id = $1', [to_device]);
        if (recipient.rows.length === 0) return res.status(404).json({ success: false, error: 'Recipient not found' });
        const now = Date.now();
        const blockNum = await computeBlockNumber();
        await client.query('BEGIN');
        try {
            await client.query('UPDATE devices SET balance = balance - $1, last_seen = $2 WHERE device_id = $3', [amt, now, from_device]);
            await client.query('UPDATE devices SET balance = balance + $1 WHERE device_id = $2', [amt, to_device]);
            await client.query(
                `INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number) VALUES ($1, 'transfer', $2, $3, $4, $5, $6)`,
                [makeTxId(), from_device, to_device, amt, now, blockNum]
            );
            await client.query('COMMIT');
        } catch (err) { await client.query('ROLLBACK'); throw err; }
        const u = await client.query('SELECT balance FROM devices WHERE device_id = $1', [from_device]);

        // Notify recipient on Telegram if linked
        notifyTransferRecipient(to_device, from_device, amt).catch(e => console.warn('Notify failed:', e.message));

        res.json({ success: true, balance: parseFloat(u.rows[0].balance), amount: amt });
    } catch (e) { console.error('transfer:', e); res.status(500).json({ success: false, error: 'Internal error' }); }
    finally { client.release(); }
});

app.post('/api/faucet/claim', async (req, res) => {
    const client = await pool.connect();
    try {
        const { device_id } = req.body;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const device = await getOrCreateDevice(device_id);
        const now = Date.now();
        if (device.last_faucet && (now - parseInt(device.last_faucet)) < FAUCET_COOLDOWN_MS) {
            const waitH = Math.ceil((FAUCET_COOLDOWN_MS - (now - parseInt(device.last_faucet))) / 1000 / 60 / 60);
            return res.status(400).json({ success: false, error: `Faucet cooldown: wait ${waitH}h` });
        }
        // Respect supply cap
        const totalMined = await getTotalMined();
        if (totalMined >= MAX_SUPPLY) {
            return res.status(400).json({ success: false, error: 'Supply cap reached — faucet closed' });
        }
        let faucetAmount = FAUCET_AMOUNT;
        const remaining = MAX_SUPPLY - totalMined;
        if (faucetAmount > remaining) faucetAmount = Math.round(remaining * 10000) / 10000;

        const blockNum = await computeBlockNumber();
        await client.query('BEGIN');
        try {
            await client.query('UPDATE devices SET balance = balance + $1, last_faucet = $2, last_seen = $3 WHERE device_id = $4', [faucetAmount, now, now, device_id]);
            await client.query(
                `INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number) VALUES ($1, 'faucet', 'FAUCET', $2, $3, $4, $5)`,
                [makeTxId(), device_id, faucetAmount, now, blockNum]
            );
            await client.query('COMMIT');
        } catch (err) { await client.query('ROLLBACK'); throw err; }
        const u = await client.query('SELECT balance FROM devices WHERE device_id = $1', [device_id]);
        res.json({ success: true, amount: faucetAmount, balance: parseFloat(u.rows[0].balance) });
    } catch (e) { console.error('faucet:', e); res.status(500).json({ success: false, error: 'Internal error' }); }
    finally { client.release(); }
});

app.get('/api/blockchain/stats', async (req, res) => {
    try {
        const tTx = await pool.query('SELECT COUNT(*) AS c FROM transactions');
        const tU = await pool.query('SELECT COUNT(*) AS c FROM devices');
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        const aU = await pool.query('SELECT COUNT(*) AS c FROM devices WHERE last_seen > $1', [fiveMinAgo]);
        const aM = await pool.query('SELECT COUNT(DISTINCT device_id) AS c FROM mining_sessions WHERE end_time IS NULL');
        const totalTxs = parseInt(tTx.rows[0].c);
        const totalUsers = parseInt(tU.rows[0].c);
        const activeUsers = parseInt(aU.rows[0].c);
        const activeMiners = parseInt(aM.rows[0].c);
        const totalMined = await getTotalMined();
        const currentPhase = getPhaseForSupply(totalMined);
        res.json({
            success: true,
            stats: {
                total_blocks: Math.floor(totalTxs / 5) + 1,
                total_users: totalUsers,
                active_users: Math.max(activeUsers, activeMiners),
                total_transactions: totalTxs,
                total_hash_rate: Math.round((activeMiners * 0.8 + Math.random() * 0.3) * 10) / 10,
                active_miners: activeMiners,
                total_mined: totalMined,
                max_supply: MAX_SUPPLY,
                supply_percent: Math.round((totalMined / MAX_SUPPLY) * 10000) / 100,
                current_phase: currentPhase ? { id: currentPhase.id, name: currentPhase.name, emoji: currentPhase.emoji, color: currentPhase.color, rate: currentPhase.rate } : null
            }
        });
    } catch (e) { console.error('stats:', e); res.status(500).json({ success: false, error: 'Internal error' }); }
});

app.get('/api/mining/phase', async (req, res) => {
    try {
        const totalMined = await getTotalMined();
        const phase = getPhaseForSupply(totalMined);
        const capReached = phase === null;
        const currentPhase = phase || PHASES[PHASES.length - 1];
        const progressInPhase = capReached ? 100 : ((totalMined - currentPhase.from) / (currentPhase.to - currentPhase.from)) * 100;
        const overallProgress = (totalMined / MAX_SUPPLY) * 100;
        const nextPhase = capReached ? null : PHASES.find(p => p.id === currentPhase.id + 1) || null;
        const remainingInPhase = capReached ? 0 : currentPhase.to - totalMined;
        const remainingTotal = MAX_SUPPLY - totalMined;

        res.json({
            success: true,
            cap_reached: capReached,
            max_supply: MAX_SUPPLY,
            total_mined: Math.round(totalMined * 10000) / 10000,
            overall_progress_pct: Math.round(overallProgress * 100) / 100,
            current_phase: capReached ? null : {
                id: currentPhase.id,
                name: currentPhase.name,
                emoji: currentPhase.emoji,
                color: currentPhase.color,
                rate: currentPhase.rate,
                from: currentPhase.from,
                to: currentPhase.to,
                progress_pct: Math.round(progressInPhase * 100) / 100,
                remaining: Math.round(remainingInPhase * 10000) / 10000
            },
            next_phase: nextPhase ? {
                id: nextPhase.id,
                name: nextPhase.name,
                emoji: nextPhase.emoji,
                color: nextPhase.color,
                rate: nextPhase.rate
            } : null,
            all_phases: PHASES,
            remaining_total: Math.round(remainingTotal * 10000) / 10000
        });
    } catch (e) { console.error('phase:', e); res.status(500).json({ success: false, error: 'Internal error' }); }
});

app.get('/api/blockchain/transactions', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const r = await pool.query('SELECT * FROM transactions ORDER BY timestamp DESC LIMIT $1', [limit]);
        res.json({
            success: true,
            transactions: r.rows.map(row => ({
                id: row.id, type: row.type, from: row.from_device, to: row.to_device,
                amount: parseFloat(row.amount), timestamp: parseInt(row.timestamp), block: row.block_number
            }))
        });
    } catch (e) { console.error('transactions:', e); res.status(500).json({ success: false, error: 'Internal error' }); }
});

app.get('/api/device/history', async (req, res) => {
    try {
        const { device_id } = req.query;
        if (!validDeviceId(device_id)) return res.status(400).json({ success: false, error: 'Invalid device ID' });
        const r = await pool.query(
            `SELECT * FROM transactions WHERE from_device = $1 OR to_device = $1 ORDER BY timestamp DESC LIMIT 50`,
            [device_id]
        );
        res.json({
            success: true,
            transactions: r.rows.map(row => ({
                id: row.id, type: row.type, from: row.from_device, to: row.to_device,
                amount: parseFloat(row.amount), timestamp: parseInt(row.timestamp),
                direction: row.to_device === device_id ? 'in' : 'out'
            }))
        });
    } catch (e) { console.error('history:', e); res.status(500).json({ success: false, error: 'Internal error' }); }
});

// ════════════════════════════════════════════════════════════
// ─── TELEGRAM BOT ─────────────────────────────────────────
// ════════════════════════════════════════════════════════════

let bot = null;

async function notifyTransferRecipient(toDeviceId, fromDeviceId, amount) {
    if (!bot) return;
    try {
        const r = await pool.query('SELECT telegram_id, lang FROM telegram_users WHERE device_id = $1 LIMIT 1', [toDeviceId]);
        if (r.rows.length === 0) return;
        const { telegram_id, lang } = r.rows[0];
        const shortFrom = fromDeviceId.slice(0, 12) + '...';
        const msg = lang === 'en'
            ? `💸 *New incoming transfer!*\n\nYou received *${amount.toFixed(4)} SPM*\nFrom: \`${shortFrom}\`\n\nCheck /balance to see your updated wallet.`
            : `💸 *Nuovo trasferimento in arrivo!*\n\nHai ricevuto *${amount.toFixed(4)} SPM*\nDa: \`${shortFrom}\`\n\nUsa /balance per vedere il saldo aggiornato.`;
        await bot.api.sendMessage(telegram_id, msg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.warn('Notify error:', e.message);
    }
}

if (process.env.BOT_TOKEN) {
    console.log('🤖 Initializing Telegram bot...');
    bot = new Bot(process.env.BOT_TOKEN);

    // ─── TRANSLATIONS ───────────────────────────
    const T = {
        it: {
            welcome: `🍹 *Benvenuto in SpritzMoon!*\n\nIo sono il bot ufficiale della community. Posso aiutarti a gestire il tuo wallet, minare, controllare il saldo e restare aggiornato — tutto da qui dentro.\n\n*Per iniziare, collega il tuo Device ID:*\nApri [spritzmoon.net](https://spritzmoon.net) dal browser, copia il tuo Device ID (formato \`SPM_XXXXXXXX_XXXXXX_XX\`) e mandamelo qui.\n\nOppure usa /help per vedere tutti i comandi.`,
            link_success: (devId) => `✅ *Wallet collegato con successo!*\n\nDevice ID: \`${devId}\`\n\nOra puoi usare tutti i comandi del bot:\n/balance — Saldo\n/mining — Avvia/ferma mining\n/send — Invia SPM\n/daily — Bonus giornaliero\n/stats — Statistiche rete\n/top — Classifica miner\n\nBenvenuto nella community! 🍹`,
            link_invalid: `❌ Device ID non valido.\n\nIl formato corretto è: \`SPM_XXXXXXXX_XXXXXX_XX\`\n\nTrovi il tuo Device ID aprendo [spritzmoon.net](https://spritzmoon.net) dal browser, nella card "Device Information".`,
            link_not_found: `⚠️ Device ID non trovato nel sistema.\n\nAssicurati di aver aperto almeno una volta [spritzmoon.net](https://spritzmoon.net) dal browser — questo registra il tuo wallet. Poi rimandami l'ID.`,
            not_linked: `⚠️ Prima devi collegare il tuo wallet!\n\nUsa /start e segui le istruzioni.`,
            balance: (bal) => `💰 *Il tuo saldo*\n\n*${bal.toFixed(4)} SPM*\n\n_Ultimo aggiornamento dal server_ 🔄`,
            mining_active: `⛏️ *Mining attivo!*\n\nStai minando 0.10 SPM al minuto. Premi il pulsante qui sotto per fermare la sessione e raccogliere i tuoi SPM.`,
            mining_stopped: (earned, bal) => `✅ *Mining fermato!*\n\n💎 Hai guadagnato: *${earned.toFixed(4)} SPM*\n💰 Nuovo saldo: *${bal.toFixed(4)} SPM*\n\nBravo! 🎉`,
            mining_start: `🚀 Mining avviato! Tornerà qui quando lo fermi.`,
            send_usage: `💸 *Invia SPM*\n\nUso: \`/send <device_id> <amount>\`\n\nEsempio:\n\`/send SPM_ABC12345_XYZ789_01 10\`\n\nInvia 10 SPM al destinatario.`,
            send_success: (amt, to) => `✅ *Trasferimento completato!*\n\n💸 Inviati: *${amt.toFixed(4)} SPM*\n📬 A: \`${to.slice(0, 14)}...\`\n\nLa transazione è stata registrata nella blockchain pubblica.`,
            daily_ok: (amt, streak, bal) => `🎁 *Bonus giornaliero riscattato!*\n\n💎 Ricompensa: *+${amt} SPM*\n🔥 Streak: *${streak} giorni di fila*\n💰 Nuovo saldo: *${bal.toFixed(4)} SPM*\n\nTorna domani per continuare la streak! 🍹`,
            daily_wait: (h) => `⏳ *Daily bonus già riscattato*\n\nTorna tra circa ${h} ore per il prossimo bonus.\n\nLa streak si mantiene finché torni ogni giorno! 🔥`,
            stats: (s) => `📊 *Statistiche di rete*\n\n🧱 Blocchi: *${s.total_blocks}*\n👥 Utenti totali: *${s.total_users}*\n🟢 Attivi ora: *${s.active_users}*\n⛏️ Miner attivi: *${s.active_miners}*\n📝 Transazioni: *${s.total_transactions}*\n⚡ Hash rate: *${s.total_hash_rate} TH/s*\n\n🔗 [Registro pubblico](https://spritzmoon.net/registry.html)`,
            help: `🍹 *SpritzMoon Bot — Comandi disponibili*\n\n👤 *Account*\n/start — Avvia il bot e collega wallet\n/balance — Controlla saldo\n/history — Ultime 10 transazioni\n/lang — Cambia lingua IT/EN\n\n⛏️ *Mining & Trasferimenti*\n/mining — Avvia/ferma mining\n/send — Invia SPM a un altro utente\n/daily — Bonus giornaliero\n\n📊 *Rete*\n/stats — Statistiche rete\n/top — Classifica miner\n\n🍹 *Divertimento*\n/aperitivo — Una frase Spritz\n\n❓ /help — Mostra questo messaggio`,
            aperitivo: [
                "🍹 _«Un Spritz al giorno toglie il broker di torno»_",
                "🍊 _«Non c'è crypto senza prosecco»_",
                "🥂 _«Minare è come preparare uno Spritz: serve pazienza, ghiaccio e la giusta dose di Aperol»_",
                "🍹 _«Lo Spritz migliore è quello che bevi con chi mina con te»_",
                "🍊 _«Ogni blocco è un cubetto di ghiaccio nella blockchain»_",
                "🥂 _«Il vero valore di SPM? Quello che scambi in una chiacchierata davanti a uno Spritz»_",
                "🍹 _«Satoshi avrebbe amato l'ora dell'aperitivo»_",
                "🍊 _«Un Aperol, un Campari, un Select... tu scegli, SpritzMoon è per tutti»_"
            ],
            top_header: `🏆 *Top 10 Holder — Tutti i tempi*\n\n`,
            top_empty: `📊 Nessun dato ancora. Sii il primo a minare!`,
            history_empty: `📜 Nessuna transazione trovata nella tua cronologia.`,
            history_header: `📜 *Le tue ultime transazioni*\n\n`,
            welcome_new_member: (name) => `🍹 Benvenuto *${name}* nella community SpritzMoon!\n\nPer iniziare a minare:\n1️⃣ Apri [spritzmoon.net](https://spritzmoon.net)\n2️⃣ Collega il wallet con @SpritzMoonBot\n3️⃣ Inizia a minare gratis!\n\nSe hai domande, siamo qui per aiutarti. 🥂`,
            lang_set: `✅ Lingua impostata: *Italiano*`,
            error: `❌ Si è verificato un errore. Riprova più tardi o contatta @SpritzMoonBot`
        },
        en: {
            welcome: `🍹 *Welcome to SpritzMoon!*\n\nI'm the official community bot. I can help you manage your wallet, mine, check balance and stay updated — all from here.\n\n*To start, link your Device ID:*\nOpen [spritzmoon.net](https://spritzmoon.net) in your browser, copy your Device ID (format \`SPM_XXXXXXXX_XXXXXX_XX\`) and send it to me here.\n\nOr use /help to see all commands.`,
            link_success: (devId) => `✅ *Wallet linked successfully!*\n\nDevice ID: \`${devId}\`\n\nYou can now use all bot commands:\n/balance — Balance\n/mining — Start/stop mining\n/send — Send SPM\n/daily — Daily bonus\n/stats — Network stats\n/top — Top miners\n\nWelcome to the community! 🍹`,
            link_invalid: `❌ Invalid Device ID.\n\nCorrect format: \`SPM_XXXXXXXX_XXXXXX_XX\`\n\nFind your Device ID at [spritzmoon.net](https://spritzmoon.net) in the "Device Information" card.`,
            link_not_found: `⚠️ Device ID not found in the system.\n\nMake sure you've opened [spritzmoon.net](https://spritzmoon.net) at least once in your browser — this registers your wallet. Then send me the ID again.`,
            not_linked: `⚠️ You need to link your wallet first!\n\nUse /start and follow the instructions.`,
            balance: (bal) => `💰 *Your balance*\n\n*${bal.toFixed(4)} SPM*\n\n_Last update from server_ 🔄`,
            mining_active: `⛏️ *Mining active!*\n\nYou're mining 0.10 SPM per minute. Tap the button below to stop the session and collect your SPM.`,
            mining_stopped: (earned, bal) => `✅ *Mining stopped!*\n\n💎 Earned: *${earned.toFixed(4)} SPM*\n💰 New balance: *${bal.toFixed(4)} SPM*\n\nWell done! 🎉`,
            mining_start: `🚀 Mining started! Come back when you want to stop.`,
            send_usage: `💸 *Send SPM*\n\nUsage: \`/send <device_id> <amount>\`\n\nExample:\n\`/send SPM_ABC12345_XYZ789_01 10\`\n\nSends 10 SPM to the recipient.`,
            send_success: (amt, to) => `✅ *Transfer completed!*\n\n💸 Sent: *${amt.toFixed(4)} SPM*\n📬 To: \`${to.slice(0, 14)}...\`\n\nThe transaction has been recorded on the public blockchain.`,
            daily_ok: (amt, streak, bal) => `🎁 *Daily bonus claimed!*\n\n💎 Reward: *+${amt} SPM*\n🔥 Streak: *${streak} days in a row*\n💰 New balance: *${bal.toFixed(4)} SPM*\n\nCome back tomorrow to keep the streak going! 🍹`,
            daily_wait: (h) => `⏳ *Daily bonus already claimed*\n\nCome back in about ${h} hours for the next bonus.\n\nThe streak stays alive as long as you come back every day! 🔥`,
            stats: (s) => `📊 *Network stats*\n\n🧱 Blocks: *${s.total_blocks}*\n👥 Total users: *${s.total_users}*\n🟢 Active now: *${s.active_users}*\n⛏️ Active miners: *${s.active_miners}*\n📝 Transactions: *${s.total_transactions}*\n⚡ Hash rate: *${s.total_hash_rate} TH/s*\n\n🔗 [Public registry](https://spritzmoon.net/registry.html)`,
            help: `🍹 *SpritzMoon Bot — Available commands*\n\n👤 *Account*\n/start — Start bot and link wallet\n/balance — Check balance\n/history — Last 10 transactions\n/lang — Change language IT/EN\n\n⛏️ *Mining & Transfers*\n/mining — Start/stop mining\n/send — Send SPM to another user\n/daily — Daily bonus\n\n📊 *Network*\n/stats — Network stats\n/top — Top miners\n\n🍹 *Fun*\n/aperitivo — A Spritz quote\n\n❓ /help — Show this message`,
            aperitivo: [
                "🍹 _«A Spritz a day keeps the broker away»_",
                "🍊 _«No crypto without prosecco»_",
                "🥂 _«Mining is like making a Spritz: takes patience, ice, and the right dose of Aperol»_",
                "🍹 _«The best Spritz is the one you drink with those who mine with you»_",
                "🍊 _«Every block is an ice cube in the blockchain»_",
                "🥂 _«The real value of SPM? The one you trade in a chat over a Spritz»_",
                "🍹 _«Satoshi would have loved aperitivo time»_",
                "🍊 _«An Aperol, a Campari, a Select... you choose, SpritzMoon is for all»_"
            ],
            top_header: `🏆 *Top 10 Holders — All time*\n\n`,
            top_empty: `📊 No data yet. Be the first to mine!`,
            history_empty: `📜 No transactions found in your history.`,
            history_header: `📜 *Your recent transactions*\n\n`,
            welcome_new_member: (name) => `🍹 Welcome *${name}* to the SpritzMoon community!\n\nTo start mining:\n1️⃣ Open [spritzmoon.net](https://spritzmoon.net)\n2️⃣ Link your wallet with @SpritzMoonBot\n3️⃣ Start mining for free!\n\nIf you have questions, we're here to help. 🥂`,
            lang_set: `✅ Language set: *English*`,
            error: `❌ An error occurred. Please try again later or contact @SpritzMoonBot`
        }
    };

    async function getUserLang(tgId) {
        const r = await pool.query('SELECT lang FROM telegram_users WHERE telegram_id = $1', [tgId]);
        return r.rows.length > 0 ? (r.rows[0].lang || 'it') : 'it';
    }

    async function getUserDevice(tgId) {
        const r = await pool.query('SELECT device_id FROM telegram_users WHERE telegram_id = $1', [tgId]);
        return r.rows.length > 0 ? r.rows[0].device_id : null;
    }

    // ─── COMMAND: /start ───────────────────────
    bot.command('start', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const existing = await getUserDevice(ctx.from.id);
            if (existing) {
                await ctx.reply(`🍹 Bentornato! Il tuo wallet è già collegato: \`${existing}\`\n\nUsa /help per vedere tutti i comandi.`, { parse_mode: 'Markdown' });
            } else {
                await ctx.reply(T[lang].welcome, { parse_mode: 'Markdown', disable_web_page_preview: true });
            }
        } catch (e) { console.error('start:', e); }
    });

    // ─── Handle device ID message (when not a command) ───
    bot.on('message:text', async (ctx, next) => {
        const text = ctx.message.text.trim();
        // If it starts with /, it's a command, pass through
        if (text.startsWith('/')) return next();
        // If it looks like a Device ID, try to link
        if (validDeviceId(text)) {
            try {
                const lang = await getUserLang(ctx.from.id);
                const r = await pool.query('SELECT device_id FROM devices WHERE device_id = $1', [text]);
                if (r.rows.length === 0) {
                    await ctx.reply(T[lang].link_not_found, { parse_mode: 'Markdown', disable_web_page_preview: true });
                    return;
                }
                // Link — upsert
                await pool.query(
                    `INSERT INTO telegram_users (telegram_id, device_id, username, first_name, linked_at, lang)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (telegram_id) DO UPDATE SET device_id = EXCLUDED.device_id, username = EXCLUDED.username, first_name = EXCLUDED.first_name`,
                    [ctx.from.id, text, ctx.from.username || null, ctx.from.first_name || null, Date.now(), lang]
                );
                await ctx.reply(T[lang].link_success(text), { parse_mode: 'Markdown' });
            } catch (e) { console.error('link:', e); }
            return;
        }
        // Otherwise, if someone sends something that looks like it should be a device ID but isn't
        if (text.toUpperCase().startsWith('SPM_') || text.length > 15) {
            const lang = await getUserLang(ctx.from.id);
            await ctx.reply(T[lang].link_invalid, { parse_mode: 'Markdown', disable_web_page_preview: true });
        }
    });

    // ─── COMMAND: /balance ─────────────────────
    bot.command('balance', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const devId = await getUserDevice(ctx.from.id);
            if (!devId) return ctx.reply(T[lang].not_linked, { parse_mode: 'Markdown' });
            const r = await pool.query('SELECT balance FROM devices WHERE device_id = $1', [devId]);
            if (r.rows.length === 0) return ctx.reply(T[lang].not_linked, { parse_mode: 'Markdown' });
            await ctx.reply(T[lang].balance(parseFloat(r.rows[0].balance)), { parse_mode: 'Markdown' });
        } catch (e) { console.error('balance cmd:', e); }
    });

    // ─── COMMAND: /mining ──────────────────────
    bot.command('mining', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const devId = await getUserDevice(ctx.from.id);
            if (!devId) return ctx.reply(T[lang].not_linked, { parse_mode: 'Markdown' });
            // Check if there's an active session
            const s = await pool.query('SELECT * FROM mining_sessions WHERE device_id = $1 AND end_time IS NULL ORDER BY id DESC LIMIT 1', [devId]);
            const kb = new InlineKeyboard();
            if (s.rows.length > 0) {
                kb.text(lang === 'en' ? '⏹️ Stop Mining' : '⏹️ Ferma Mining', 'mining_stop');
            } else {
                kb.text(lang === 'en' ? '🚀 Start Mining' : '🚀 Avvia Mining', 'mining_start');
            }
            await ctx.reply(T[lang].mining_active, { parse_mode: 'Markdown', reply_markup: kb });
        } catch (e) { console.error('mining cmd:', e); }
    });

    bot.callbackQuery('mining_start', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const devId = await getUserDevice(ctx.from.id);
            if (!devId) return ctx.answerCallbackQuery({ text: 'Wallet non collegato' });
            await getOrCreateDevice(devId);
            await pool.query('UPDATE mining_sessions SET end_time = $1 WHERE device_id = $2 AND end_time IS NULL', [Date.now(), devId]);
            await pool.query('INSERT INTO mining_sessions (device_id, start_time) VALUES ($1, $2)', [devId, Date.now()]);
            await ctx.answerCallbackQuery({ text: '⛏️ Mining avviato!' });
            const kb = new InlineKeyboard().text(lang === 'en' ? '⏹️ Stop Mining' : '⏹️ Ferma Mining', 'mining_stop');
            await ctx.editMessageText(T[lang].mining_active + '\n\n✅ ' + T[lang].mining_start, { parse_mode: 'Markdown', reply_markup: kb });
        } catch (e) { console.error('mining_start cb:', e); }
    });

    bot.callbackQuery('mining_stop', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const devId = await getUserDevice(ctx.from.id);
            if (!devId) return ctx.answerCallbackQuery({ text: 'Wallet non collegato' });
            const s = await pool.query('SELECT * FROM mining_sessions WHERE device_id = $1 AND end_time IS NULL ORDER BY id DESC LIMIT 1', [devId]);
            if (s.rows.length === 0) return ctx.answerCallbackQuery({ text: 'Nessuna sessione attiva' });
            const session = s.rows[0];
            const now = Date.now();
            const elapsedMs = now - parseInt(session.start_time);
            let minutes = elapsedMs / 1000 / 60;
            if (minutes > MAX_SESSION_MINUTES) minutes = MAX_SESSION_MINUTES;
            const totalMinedBot = await getTotalMined();
            const phaseBot = getPhaseForSupply(totalMinedBot);
            if (!phaseBot) {
                await pool.query('UPDATE mining_sessions SET end_time = $1, earned = 0 WHERE id = $2', [now, session.id]);
                return ctx.answerCallbackQuery({ text: '🍹 Spritz Completo! Cap raggiunto.' });
            }
            let earned = Math.round(minutes * phaseBot.rate * 10000) / 10000;
            const remBot = MAX_SUPPLY - totalMinedBot;
            if (earned > remBot) earned = Math.round(remBot * 10000) / 10000;
            const blockNum = await computeBlockNumber();
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE mining_sessions SET end_time = $1, earned = $2 WHERE id = $3', [now, earned, session.id]);
                await client.query('UPDATE devices SET balance = balance + $1, last_seen = $2 WHERE device_id = $3', [earned, now, devId]);
                await client.query(
                    `INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number) VALUES ($1, 'mining', $2, $3, $4, $5, $6)`,
                    [makeTxId(), 'MINING_REWARD', devId, earned, now, blockNum]
                );
                await client.query('COMMIT');
            } catch (err) { await client.query('ROLLBACK'); throw err; }
            finally { client.release(); }
            const bal = await pool.query('SELECT balance FROM devices WHERE device_id = $1', [devId]);
            await ctx.answerCallbackQuery({ text: `✅ +${earned.toFixed(4)} SPM` });
            await ctx.editMessageText(T[lang].mining_stopped(earned, parseFloat(bal.rows[0].balance)), { parse_mode: 'Markdown' });
        } catch (e) { console.error('mining_stop cb:', e); }
    });

    // ─── COMMAND: /send ────────────────────────
    bot.command('send', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const devId = await getUserDevice(ctx.from.id);
            if (!devId) return ctx.reply(T[lang].not_linked, { parse_mode: 'Markdown' });
            const parts = ctx.match.trim().split(/\s+/);
            if (parts.length !== 2) return ctx.reply(T[lang].send_usage, { parse_mode: 'Markdown' });
            const [toDev, amtStr] = parts;
            if (!validDeviceId(toDev)) return ctx.reply(T[lang].send_usage, { parse_mode: 'Markdown' });
            const amt = parseFloat(amtStr);
            if (!amt || amt <= 0) return ctx.reply(T[lang].send_usage, { parse_mode: 'Markdown' });
            if (toDev === devId) return ctx.reply('❌ Cannot send to yourself');
            const sender = await pool.query('SELECT balance FROM devices WHERE device_id = $1', [devId]);
            if (parseFloat(sender.rows[0].balance) < amt) return ctx.reply('❌ Insufficient balance');
            const recipient = await pool.query('SELECT device_id FROM devices WHERE device_id = $1', [toDev]);
            if (recipient.rows.length === 0) return ctx.reply('❌ Recipient not found');
            const now = Date.now();
            const blockNum = await computeBlockNumber();
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE devices SET balance = balance - $1, last_seen = $2 WHERE device_id = $3', [amt, now, devId]);
                await client.query('UPDATE devices SET balance = balance + $1 WHERE device_id = $2', [amt, toDev]);
                await client.query(
                    `INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number) VALUES ($1, 'transfer', $2, $3, $4, $5, $6)`,
                    [makeTxId(), devId, toDev, amt, now, blockNum]
                );
                await client.query('COMMIT');
            } catch (err) { await client.query('ROLLBACK'); throw err; }
            finally { client.release(); }
            await ctx.reply(T[lang].send_success(amt, toDev), { parse_mode: 'Markdown' });
            notifyTransferRecipient(toDev, devId, amt).catch(() => {});
        } catch (e) { console.error('send cmd:', e); }
    });

    // ─── COMMAND: /daily ───────────────────────
    bot.command('daily', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const devId = await getUserDevice(ctx.from.id);
            if (!devId) return ctx.reply(T[lang].not_linked, { parse_mode: 'Markdown' });
            const user = await pool.query('SELECT * FROM telegram_users WHERE telegram_id = $1', [ctx.from.id]);
            const u = user.rows[0];
            const now = Date.now();
            const lastDaily = parseInt(u.last_daily) || 0;
            if (lastDaily && (now - lastDaily) < DAILY_COOLDOWN_MS) {
                const h = Math.ceil((DAILY_COOLDOWN_MS - (now - lastDaily)) / 1000 / 60 / 60);
                return ctx.reply(T[lang].daily_wait(h), { parse_mode: 'Markdown' });
            }
            // If more than 48h passed since last daily, reset streak
            let newStreak = (u.daily_streak || 0) + 1;
            if (lastDaily && (now - lastDaily) > 48 * 60 * 60 * 1000) newStreak = 1;
            const reward = DAILY_BASE_REWARD + (newStreak - 1) * 2; // day 1 = 10, day 7 = 22
            const blockNum = await computeBlockNumber();
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE devices SET balance = balance + $1, last_seen = $2 WHERE device_id = $3', [reward, now, devId]);
                await client.query('UPDATE telegram_users SET daily_streak = $1, last_daily = $2 WHERE telegram_id = $3', [newStreak, now, ctx.from.id]);
                await client.query(
                    `INSERT INTO transactions (id, type, from_device, to_device, amount, timestamp, block_number) VALUES ($1, 'daily', 'DAILY_BONUS', $2, $3, $4, $5)`,
                    [makeTxId(), devId, reward, now, blockNum]
                );
                await client.query('COMMIT');
            } catch (err) { await client.query('ROLLBACK'); throw err; }
            finally { client.release(); }
            const bal = await pool.query('SELECT balance FROM devices WHERE device_id = $1', [devId]);
            await ctx.reply(T[lang].daily_ok(reward, newStreak, parseFloat(bal.rows[0].balance)), { parse_mode: 'Markdown' });
        } catch (e) { console.error('daily cmd:', e); }
    });

    // ─── COMMAND: /stats ───────────────────────
    bot.command('stats', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const tTx = await pool.query('SELECT COUNT(*) AS c FROM transactions');
            const tU = await pool.query('SELECT COUNT(*) AS c FROM devices');
            const fiveMinAgo = Date.now() - 5 * 60 * 1000;
            const aU = await pool.query('SELECT COUNT(*) AS c FROM devices WHERE last_seen > $1', [fiveMinAgo]);
            const aM = await pool.query('SELECT COUNT(DISTINCT device_id) AS c FROM mining_sessions WHERE end_time IS NULL');
            const totalTxs = parseInt(tTx.rows[0].c);
            const stats = {
                total_blocks: Math.floor(totalTxs / 5) + 1,
                total_users: parseInt(tU.rows[0].c),
                active_users: Math.max(parseInt(aU.rows[0].c), parseInt(aM.rows[0].c)),
                active_miners: parseInt(aM.rows[0].c),
                total_transactions: totalTxs,
                total_hash_rate: Math.round((parseInt(aM.rows[0].c) * 0.8 + Math.random() * 0.3) * 10) / 10
            };
            await ctx.reply(T[lang].stats(stats), { parse_mode: 'Markdown', disable_web_page_preview: true });
        } catch (e) { console.error('stats cmd:', e); }
    });

    // ─── COMMAND: /phase ───────────────────────
    bot.command('phase', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const totalMined = await getTotalMined();
            const phase = getPhaseForSupply(totalMined);
            const overallPct = (totalMined / MAX_SUPPLY) * 100;
            const formatSup = (n) => n >= 1_000_000 ? (n/1_000_000).toFixed(2) + 'M' : n >= 1000 ? (n/1000).toFixed(1) + 'K' : Math.round(n).toString();

            if (!phase) {
                const msg = lang === 'en'
                    ? `🍹 *Spritz Completo!*\n\nThe 21M cap has been reached. Mining is closed forever.\n\nTotal mined: *${formatSup(totalMined)} / 21M SPM*\n\nThe community now lives on transfers, partner bars and exclusive events. The toast is eternal.`
                    : `🍹 *Spritz Completo!*\n\nIl cap di 21M è stato raggiunto. Il mining è chiuso per sempre.\n\nTotale minato: *${formatSup(totalMined)} / 21M SPM*\n\nLa community vive ora dei trasferimenti, dei bar partner e degli eventi esclusivi. Il brindisi è eterno.`;
                await ctx.reply(msg, { parse_mode: 'Markdown' });
                return;
            }

            const phaseSize = MAX_SUPPLY / 4;
            const phaseStart = (phase.id - 1) * phaseSize;
            const minedInPhase = Math.max(0, totalMined - phaseStart);
            const phasePct = (minedInPhase / phaseSize) * 100;
            const nextPhase = PHASES.find(p => p.id === phase.id + 1);
            const barLen = 20;
            const filled = Math.round((phasePct / 100) * barLen);
            const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

            const msg = lang === 'en'
                ? `${phase.emoji} *${phase.name} Phase* · ${phase.id}/4\n\n⚡ *Mining rate:* \`${phase.rate} SPM/min\`\n\n📊 *Phase progress:*\n\`${bar}\` ${phasePct.toFixed(2)}%\n\n💎 *Phase supply:* ${formatSup(minedInPhase)} / ${formatSup(phaseSize)}\n🌐 *Total mined:* ${formatSup(totalMined)} / 21M (${overallPct.toFixed(3)}%)\n${nextPhase ? `\n⏭️ *Next phase:* ${nextPhase.emoji} ${nextPhase.name} at ${formatSup(phase.to)} (rate: ${nextPhase.rate} SPM/min)` : '\n🍹 *Next:* Spritz Completo — mining closes'}\n\n🔗 [Public registry](https://spritzmoon.net/registry.html)`
                : `${phase.emoji} *Fase ${phase.name}* · ${phase.id}/4\n\n⚡ *Mining rate:* \`${phase.rate} SPM/min\`\n\n📊 *Progresso fase:*\n\`${bar}\` ${phasePct.toFixed(2)}%\n\n💎 *Supply fase:* ${formatSup(minedInPhase)} / ${formatSup(phaseSize)}\n🌐 *Totale minato:* ${formatSup(totalMined)} / 21M (${overallPct.toFixed(3)}%)\n${nextPhase ? `\n⏭️ *Prossima fase:* ${nextPhase.emoji} ${nextPhase.name} a ${formatSup(phase.to)} (rate: ${nextPhase.rate} SPM/min)` : '\n🍹 *Prossima:* Spritz Completo — mining chiuso'}\n\n🔗 [Registro pubblico](https://spritzmoon.net/registry.html)`;
            await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
        } catch (e) { console.error('phase cmd:', e); }
    });

    // ─── COMMAND: /top ─────────────────────────
    bot.command('top', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const r = await pool.query('SELECT device_id, balance FROM devices ORDER BY balance DESC LIMIT 10');
            if (r.rows.length === 0) return ctx.reply(T[lang].top_empty, { parse_mode: 'Markdown' });
            let msg = T[lang].top_header;
            const medals = ['🥇', '🥈', '🥉'];
            r.rows.forEach((row, i) => {
                const medal = medals[i] || `${i + 1}.`;
                const shortId = row.device_id.slice(0, 12) + '...';
                msg += `${medal} \`${shortId}\`\n    *${parseFloat(row.balance).toFixed(2)} SPM*\n\n`;
            });
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        } catch (e) { console.error('top cmd:', e); }
    });

    // ─── COMMAND: /history ─────────────────────
    bot.command('history', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const devId = await getUserDevice(ctx.from.id);
            if (!devId) return ctx.reply(T[lang].not_linked, { parse_mode: 'Markdown' });
            const r = await pool.query(
                `SELECT * FROM transactions WHERE from_device = $1 OR to_device = $1 ORDER BY timestamp DESC LIMIT 10`,
                [devId]
            );
            if (r.rows.length === 0) return ctx.reply(T[lang].history_empty, { parse_mode: 'Markdown' });
            let msg = T[lang].history_header;
            r.rows.forEach((row) => {
                const isIn = row.to_device === devId;
                const icon = row.type === 'mining' ? '⛏️' : row.type === 'faucet' ? '🎁' : row.type === 'daily' ? '🎁' : (isIn ? '📥' : '📤');
                const sign = isIn || row.type === 'mining' || row.type === 'faucet' || row.type === 'daily' ? '+' : '-';
                const date = new Date(parseInt(row.timestamp)).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                msg += `${icon} ${sign}${parseFloat(row.amount).toFixed(4)} SPM — _${date}_\n`;
            });
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        } catch (e) { console.error('history cmd:', e); }
    });

    // ─── COMMAND: /aperitivo ───────────────────
    bot.command('aperitivo', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            const quotes = T[lang].aperitivo;
            const q = quotes[Math.floor(Math.random() * quotes.length)];
            await ctx.reply(q, { parse_mode: 'Markdown' });
        } catch (e) { console.error('aperitivo cmd:', e); }
    });

    // ─── COMMAND: /lang ────────────────────────
    bot.command('lang', async (ctx) => {
        try {
            const current = await getUserLang(ctx.from.id);
            const newLang = current === 'it' ? 'en' : 'it';
            await pool.query('UPDATE telegram_users SET lang = $1 WHERE telegram_id = $2', [newLang, ctx.from.id]);
            await ctx.reply(T[newLang].lang_set, { parse_mode: 'Markdown' });
        } catch (e) { console.error('lang cmd:', e); }
    });

    // ─── COMMAND: /help ────────────────────────
    bot.command('help', async (ctx) => {
        try {
            const lang = await getUserLang(ctx.from.id);
            await ctx.reply(T[lang].help, { parse_mode: 'Markdown' });
        } catch (e) { console.error('help cmd:', e); }
    });

    // ─── ADMIN: /announce ──────────────────────
    bot.command('announce', async (ctx) => {
        if (ctx.from.id !== ADMIN_TELEGRAM_ID) return;
        const text = ctx.match;
        if (!text) return ctx.reply('Usage: /announce <message>');
        const users = await pool.query('SELECT telegram_id FROM telegram_users');
        let sent = 0, failed = 0;
        for (const u of users.rows) {
            try {
                await bot.api.sendMessage(u.telegram_id, `📢 *Annuncio SpritzMoon*\n\n${text}`, { parse_mode: 'Markdown' });
                sent++;
                await new Promise(r => setTimeout(r, 50)); // rate limit safety
            } catch (e) { failed++; }
        }
        await ctx.reply(`✅ Annuncio inviato a ${sent} utenti (${failed} falliti)`);
    });

    bot.command('broadcast', async (ctx) => {
        if (ctx.from.id !== ADMIN_TELEGRAM_ID) return;
        if (!COMMUNITY_CHAT_ID) return ctx.reply('❌ COMMUNITY_CHAT_ID non configurato');
        const text = ctx.match;
        if (!text) return ctx.reply('Usage: /broadcast <message>');
        try {
            await bot.api.sendMessage(COMMUNITY_CHAT_ID, `📢 *${text}*`, { parse_mode: 'Markdown' });
            await ctx.reply('✅ Broadcast inviato al gruppo');
        } catch (e) {
            await ctx.reply('❌ Errore: ' + e.message);
        }
    });

    // ─── GROUP: welcome new members ─────────────
    bot.on('chat_member', async (ctx) => {
        try {
            if (ctx.chatMember.new_chat_member.status === 'member' && ctx.chatMember.old_chat_member.status === 'left') {
                const name = ctx.chatMember.new_chat_member.user.first_name || 'amico';
                const msg = T.it.welcome_new_member(name);
                await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
            }
        } catch (e) { console.error('welcome:', e); }
    });

    // ─── Error handler ──────────────────────────
    bot.catch((err) => {
        const ctx = err.ctx;
        console.error(`Bot error for update ${ctx.update.update_id}:`);
        const e = err.error;
        if (e instanceof GrammyError) console.error('Grammy error:', e.description);
        else if (e instanceof HttpError) console.error('HTTP error:', e);
        else console.error('Unknown error:', e);
    });

    console.log('✅ Telegram bot configured');
} else {
    console.warn('⚠️  BOT_TOKEN not set — Telegram bot disabled');
}

// ─── START ────────────────────────────────────
initDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`🚀 SpritzMoon backend running on port ${PORT}`);
            console.log(`🐘 Database: PostgreSQL (Neon)`);
            if (bot) {
                bot.start({
                    allowed_updates: ['message', 'callback_query', 'chat_member']
                });
                console.log('🤖 Telegram bot started (polling)');
            }
        });
    })
    .catch(err => {
        console.error('❌ Failed to initialize database:', err);
        process.exit(1);
    });

process.on('SIGTERM', async () => {
    if (bot) bot.stop();
    await pool.end();
    process.exit(0);
});
process.on('SIGINT', async () => {
    if (bot) bot.stop();
    await pool.end();
    process.exit(0);
});
