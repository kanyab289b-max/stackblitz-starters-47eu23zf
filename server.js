import express from 'express';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { createServer } from 'http';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import initSqlJs from 'sql.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ========== DATABASE ==========
let db;
async function initDatabase() {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(`CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT, action TEXT, price REAL, confidence INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  console.log('✅ Database ready');
}

function saveSignal(symbol, action, price, confidence) {
  if (!db) return;
  db.run(`INSERT INTO signals (symbol, action, price, confidence) VALUES (?, ?, ?, ?)`, [symbol, action, price, confidence]);
}

function getSignals() {
  if (!db) return [];
  const res = db.exec(`SELECT * FROM signals ORDER BY timestamp DESC LIMIT 30`);
  if (res.length === 0) return [];
  return res[0].values.map(row => ({ id: row[0], symbol: row[1], action: row[2], price: row[3], confidence: row[4], timestamp: row[5] }));
}

// ========== API KEY ==========
const TWELVE_DATA_API_KEY = '0be46e7fd9994be88453962882bfb522';

// ========== ตัวแปรข้อมูล ==========
let cache = { tf5m: [], tf15m: [], tf1h: [] };

async function fetchCandles(symbol, interval, output = 100) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${output}&apikey=${TWELVE_DATA_API_KEY}`;
    const res = await axios.get(url);
    if (res.data?.values) {
      return res.data.values.map(v => ({
        datetime: v.datetime,
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close)
      })).reverse();
    }
    return [];
  } catch(e) { return []; }
}

async function updateData() {
  const [tf5m, tf15m, tf1h] = await Promise.all([
    fetchCandles('XAU/USD', '5min', 100),
    fetchCandles('XAU/USD', '15min', 80),
    fetchCandles('XAU/USD', '1h', 80)
  ]);
  if (tf5m.length) cache.tf5m = tf5m;
  if (tf15m.length) cache.tf15m = tf15m;
  if (tf1h.length) cache.tf1h = tf1h;
  console.log(`📊 5m:${cache.tf5m.length} 15m:${cache.tf15m.length} 1h:${cache.tf1h.length}`);
}

// ========== SMC Functions ==========
function getBias(candles) {
  if (!candles?.length) return 0;
  const ema20 = candles.slice(-20).reduce((s, c) => s + c.close, 0) / 20;
  return candles[candles.length-1].close > ema20 ? 1 : -1;
}

function calcATR(candles, period = 14) {
  if (candles.length < period+1) return 10;
  let atr = 0;
  for (let i = candles.length-period; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close));
    atr += tr;
  }
  return atr / period;
}

function detectWick(candle, atr) {
  const range = candle.high - candle.low;
  if (range === 0) return { isBull: false, isBear: false };
  const body = Math.abs(candle.close - candle.open);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const isBull = (lowerWick/range) >= 0.65 && (body/range) <= 0.2 && candle.close >= candle.high - range*0.25;
  const isBear = (upperWick/range) >= 0.65 && (body/range) <= 0.2 && candle.close <= candle.low + range*0.25;
  return { isBull, isBear };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period+1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length-period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains/period, avgLoss = losses/period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain/avgLoss));
}

function calculateScore(bias5m, bias15m, bias1h, wick, rsi) {
  let bull = 0, bear = 0;
  if (bias1h === 1) bull += 4; else if (bias1h === -1) bear += 4;
  if (bias15m === 1) bull += 2; else if (bias15m === -1) bear += 2;
  if (bias5m === 1) bull += 1; else if (bias5m === -1) bear += 1;
  if (wick.isBull) bull += 4;
  if (wick.isBear) bear += 4;
  if (rsi < 30) bull += 3;
  if (rsi > 70) bear += 3;
  const net = bull - bear;
  let action = 'WAIT', conf = 50;
  if (net >= 5) { action = 'BUY'; conf = 70 + Math.min(25, net); }
  else if (net <= -5) { action = 'SELL'; conf = 70 + Math.min(25, -net); }
  else if (net >= 2) { action = 'BUY'; conf = 55 + net*3; }
  else if (net <= -2) { action = 'SELL'; conf = 55 + (-net)*3; }
  return { action, confidence: Math.min(98, conf), bull, bear };
}

// ========== WEBSOCKET ==========
wss.on('connection', async (ws) => {
  console.log('✅ Client connected');
  let lastAction = '';
  const interval = setInterval(async () => {
    if (!cache.tf5m.length) return;
    const latest = cache.tf5m[cache.tf5m.length-1];
    const atr = calcATR(cache.tf5m);
    const wick = detectWick(latest, atr);
    const rsi = calcRSI(cache.tf5m.slice(-30).map(c => c.close));
    const score = calculateScore(getBias(cache.tf5m), getBias(cache.tf15m), getBias(cache.tf1h), wick, rsi);
    if (score.action !== 'WAIT' && score.action !== lastAction) {
      saveSignal('XAUUSD', score.action, latest.close, score.confidence);
      lastAction = score.action;
    }
    ws.send(JSON.stringify({ price: latest.close, rsi: Math.round(rsi), ...score, timestamp: Date.now() }));
  }, 5000);
  ws.on('close', () => clearInterval(interval));
});

// ========== API ==========
app.get('/api/signals', (req, res) => res.json(getSignals()));
app.post('/api/chat', (req, res) => {
  res.json({ reply: `🤖 AI: ${req.body.message}\n\nแนวโน้ม 1h: ${getBias(cache.tf1h) === 1 ? 'BULL' : 'BEAR'}\nแนะนำรอสัญญาณ SMC ที่ชัดเจน` });
});

// ========== START ==========
async function start() {
  await initDatabase();
  await updateData();
  setInterval(updateData, 60000);
  const PORT = 3000;
  server.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));
}
start();