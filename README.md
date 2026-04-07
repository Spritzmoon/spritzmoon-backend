# SpritzMoon Backend

Backend Node.js + Express + SQLite per SpritzMoon. Gestisce mining reale server-side, trasferimenti atomici tra device, faucet, e registro pubblico.

## 📁 Cosa contiene

- `server.js` — server Express con tutti gli endpoint
- `package.json` — dipendenze
- `spritzmoon.db` — database SQLite (creato automaticamente al primo avvio)

## 🚀 Deploy su Render (gratis)

### 1. Prepara la repo GitHub

Crea una nuova repo su GitHub con questi 2 file:
- `server.js`
- `package.json`

### 2. Crea servizio su Render

1. Vai su [render.com](https://render.com) e accedi
2. Clicca **New → Web Service**
3. Collega la tua repo GitHub
4. Configurazione:
   - **Name:** `spritzmoon-api`
   - **Region:** Frankfurt (più vicino all'Italia)
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** `Free`
5. Clicca **Create Web Service**

### 3. ⚠️ IMPORTANTE — Persistenza dati

Il piano **Free** di Render ha filesystem effimero: ogni volta che il servizio si riavvia (dopo 15 min di inattività), **il database SQLite viene cancellato**.

**Due soluzioni:**

**Opzione A — Disk persistente ($1/mese):**
Nelle impostazioni del servizio su Render, aggiungi un Disk:
- **Mount Path:** `/data`
- **Size:** `1 GB`

Poi aggiungi una variabile d'ambiente:
- **Key:** `DB_PATH`
- **Value:** `/data/spritzmoon.db`

**Opzione B — Passa a Postgres (gratis ma con limiti):**
Usa Neon.tech o Supabase free tier e modifica il server per usare `pg` invece di `better-sqlite3`. Richiede modifica del codice.

Per iniziare, l'**Opzione A** è la più semplice e costa 1€/mese.

### 4. Verifica che funzioni

Una volta deployato, visita:
```
https://spritzmoon-api.onrender.com/
```

Dovresti vedere:
```json
{"status":"online","service":"SpritzMoon Backend","version":"1.0.0"}
```

Test dell'API:
```
https://spritzmoon-api.onrender.com/api/blockchain/stats
```

## 📡 Endpoint disponibili

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| `POST` | `/api/device/register` | Registra un nuovo device |
| `GET`  | `/api/device/balance?device_id=X` | Ottieni saldo |
| `GET`  | `/api/device/history?device_id=X` | Storico transazioni del device |
| `POST` | `/api/mining/start` | Inizia sessione mining |
| `POST` | `/api/mining/stop` | Ferma mining (calcolo server-side anti-cheat) |
| `POST` | `/api/transfer` | Trasferisci SPM tra device |
| `POST` | `/api/faucet/claim` | Richiedi 100 SPM (cooldown 24h) |
| `GET`  | `/api/blockchain/stats` | Statistiche di rete |
| `GET`  | `/api/blockchain/transactions?limit=100` | Transazioni recenti |

## 🛡️ Sicurezza implementata

- **Rate limiting:** 120 richieste/minuto per IP
- **Validazione Device ID:** formato obbligatorio `SPM_XXXXXXXX_XXXXXX_XX`
- **Mining anti-cheat:** tempo calcolato server-side, cap 8h per sessione
- **Transfer atomici:** usa SQLite transactions per evitare race conditions
- **CORS aperto:** il frontend può chiamare da qualsiasi dominio

## 🧪 Test locale

Se vuoi provare il backend sul tuo PC prima di deployare:

```bash
npm install
node server.js
```

Si avvierà su `http://localhost:3000`. Poi nel codice frontend cambia temporaneamente `API_BASE` a `http://localhost:3000`.

## 📊 Struttura database

3 tabelle:
- **devices** — saldo, fingerprint, ultima attività
- **mining_sessions** — sessioni di mining attive e chiuse
- **transactions** — registro immutabile di tutte le operazioni (genesis, mining, transfer, faucet)

## ⚙️ Variabili d'ambiente opzionali

- `PORT` — porta del server (default: `3000`)
- `DB_PATH` — path del database SQLite (default: `./spritzmoon.db`)

## 🔧 Mantenimento

Il backend è stateless a parte il database. Per resettarlo:
1. Ferma il servizio
2. Cancella `spritzmoon.db`
3. Riavvia (ricrea tabelle + blocco genesis)

## ❓ Problemi comuni

**"Device not found" su trasferimento:** il destinatario deve aver aperto almeno una volta il sito di mining per registrarsi.

**Backend lento al primo caricamento:** Render free tier va in sleep dopo 15 min. Il primo request dopo il sleep richiede 30-50 secondi. Upgrade a $7/mese per tenerlo sempre attivo.

**Database cancellato dopo deploy:** hai dimenticato di configurare il Disk persistente. Vedi punto 3.
