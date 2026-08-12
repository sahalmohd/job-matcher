const express = require('express');
const cors = require('cors');
const matchesRouter = require('./routes/matches');
const notifyRouter = require('./routes/notify');
const llmRouter = require('./routes/llm');
const scoreRouter = require('./routes/score');
const db = require('./db');

const PORT = process.env.PORT || 3456;

const app = express();

/**
 * Restrict CORS to the extension itself.
 *
 * This was previously `cors()` with no options and no auth, so any web page the
 * user had open could POST to /api/notify to send mail from their account, or
 * drive their local Ollama through /api/llm/score-batch.
 *
 * Set JM_ALLOWED_ORIGINS to the extension origin, which you can read from
 * chrome://extensions (it looks like chrome-extension://<id>). Requests with no
 * Origin header — curl, the extension service worker itself — are still
 * allowed, since the risk here is specifically other *pages*.
 */
const ALLOWED_ORIGINS = (process.env.JM_ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.length === 0 && origin.startsWith('chrome-extension://')) {
        return callback(null, true);
      }
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} is not allowed`));
    },
  })
);
app.use(express.json({ limit: '2mb' }));

app.use('/api/matches', matchesRouter);
app.use('/api/notify', notifyRouter);
app.use('/api/llm', llmRouter);
app.use('/api/score', scoreRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// A rejected origin is a deliberate refusal, not a server fault — report it as
// 403 rather than letting Express turn the thrown Error into an opaque 500.
app.use((err, req, res, next) => {
  if (err && /not allowed/.test(err.message)) {
    return res.status(403).json({
      error: err.message,
      hint: 'Set JM_ALLOWED_ORIGINS to your chrome-extension:// origin if this is your extension.',
    });
  }
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error' });
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
  console.log(`  POST /api/score           (two-stage: embeddings + LLM judge)`);
  console.log(`  GET  /api/score/status`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
