import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.static('.'));

// Endpoint เรียกข้อมูลราคาจาก Binance
app.get('/api/price', async (req, res) => {
  try {
    const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=XAUUSDT');
    res.json({ 
      price: parseFloat(response.data.price),
      timestamp: Date.now()
    });
  } catch(error) {
    console.error('Binance error:', error.message);
    res.status(500).json({ error: 'Binance API failed' });
  }
});

// Endpoint เรียกข้อมูลย้อนหลัง (optional)
app.get('/api/klines', async (req, res) => {
  const interval = req.query.interval || '5m';
  const limit = req.query.limit || 50;
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=XAUUSDT&interval=${interval}&limit=${limit}`;
    const response = await axios.get(url);
    const candles = response.data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4])
    }));
    res.json(candles);
  } catch(error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`✅ Proxy XAUUSDT via Binance`);
});
