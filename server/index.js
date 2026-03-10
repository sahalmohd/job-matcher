const express = require('express');
const cors = require('cors');
const matchesRouter = require('./routes/matches');
const notifyRouter = require('./routes/notify');
const llmRouter = require('./routes/llm');
const db = require('./db');

const PORT = process.env.PORT || 3456;

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api/matches', matchesRouter);
app.use('/api/notify', notifyRouter);
app.use('/api/llm', llmRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Job Matcher server running on http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log(`  GET  /api/health`);
  console.log(`  GET  /api/matches`);
  console.log(`  POST /api/matches`);
  console.log(`  DELETE /api/matches`);
  console.log(`  POST /api/notify`);
  console.log(`  POST /api/llm/score`);
  console.log(`  POST /api/llm/score-batch`);
  console.log(`  GET  /api/llm/status`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
