// ... ส่วน imports เหมือนเดิม ...

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });  // ✅ เพิ่ม path

// ... middlewares, database, API ...

// ใน WebSocket connection (เปลี่ยนบรรทัด ws.send ให้ใช้ JSON ปกติ)
wss.on('connection', (ws) => {
  console.log('✅ WebSocket connected');
  const interval = setInterval(async () => {
    // ... logic ของคุณ ...
    ws.send(JSON.stringify({ price: 1234, action: 'BUY', confidence: 75 }));
  }, 3000);
  ws.on('close', () => clearInterval(interval));
});

// เปลี่ยน server.listen
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));
