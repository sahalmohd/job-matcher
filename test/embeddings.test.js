'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..', 'server');

let hasDeps = true;
try {
  require.resolve('better-sqlite3', { paths: [SERVER_DIR] });
} catch {
  hasDeps = false;
}
const needsServerDeps = {
  skip: hasDeps ? false : 'run `npm install` in server/ to enable these tests',
};

/**
 * A stand-in for Ollama.
 *
 * Embedding *quality* depends on the real model, but everything this repo is
 * responsible for — chunking, caching, max-sim pooling, batching, the two-stage
 * endpoint — is ours to verify. The fake returns deterministic vectors built
 * from token overlap, so semantically related texts really do score higher.
 */
function startFakeOllama({ onEmbed, chatReply } = {}) {
  const calls = { embed: 0, embedTexts: [], chat: 0 };

  const vocabulary = [
    'python', 'kafka', 'kubernetes', 'aws', 'terraform', 'streaming',
    'nurse', 'patient', 'ward', 'design', 'figma', 'sales', 'quota',
    'engineer', 'data', 'platform', 'recruiting', 'candidates',
  ];

  // Vector = presence of each vocabulary term. Cosine over these behaves like
  // real embeddings for the purposes of these tests: related texts are close.
  const vectorFor = (text) => {
    const lower = text.toLowerCase();
    const v = vocabulary.map((term) => (lower.includes(term) ? 1 : 0));
    // Avoid all-zero vectors, which have undefined cosine.
    if (v.every((x) => x === 0)) v[0] = 0.01;
    return v;
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/api/embed') {
        calls.embed++;
        const inputs = payload.input;
        calls.embedTexts.push(...inputs);
        if (onEmbed) onEmbed(inputs);
        res.end(JSON.stringify({ embeddings: inputs.map(vectorFor) }));
        return;
      }

      if (req.url === '/api/chat') {
        calls.chat++;
        res.end(
          JSON.stringify({
            message: { content: chatReply || '{"score": 88, "rationale": "good fit"}' },
          })
        );
        return;
      }

      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }));
        return;
      }

      res.statusCode = 404;
      res.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, calls });
    });
  });
}

/** Load embeddings.js pointed at the fake Ollama and a scratch database. */
function loadEmbeddings(port, dbFile) {
  process.env.OLLAMA_URL = `http://127.0.0.1:${port}`;
  process.env.JM_DB_PATH = dbFile;
  delete require.cache[require.resolve('../server/embeddings')];
  delete require.cache[require.resolve('../server/db')];
  return require('../server/embeddings');
}

function scratchDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-emb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'test.db');
}

// ---------------------------------------------------------------------------
// Chunking — pure, no server needed
// ---------------------------------------------------------------------------

const { chunkText, cosine, maxSimScore } = require('../server/embeddings');

test('chunking splits on paragraph boundaries', () => {
  const text = 'A'.repeat(200) + '\n\n' + 'B'.repeat(200) + '\n\n' + 'C'.repeat(200);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);
});

test('chunking falls back to single newlines for bulleted resumes', () => {
  // A bulleted CV often has no blank lines at all; treating it as one block
  // would produce a single averaged vector.
  const bullets = Array.from({ length: 12 }, (_, i) => `- Built system number ${i} using Kafka and Python`);
  const chunks = chunkText(bullets.join('\n'));
  assert.ok(chunks.length > 1, `bulleted text should still chunk, got ${chunks.length}`);
});

test('no chunk greatly exceeds the maximum', () => {
  const long = 'This is a sentence about distributed systems. '.repeat(200);
  for (const chunk of chunkText(long)) {
    assert.ok(chunk.length <= 800, `chunk too long: ${chunk.length}`);
  }
});

test('a single unbroken sentence longer than the max is still split', () => {
  const chunks = chunkText('x'.repeat(5000));
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 800);
});

test('empty input yields no chunks', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText(null), []);
  assert.deepEqual(chunkText('   \n  '), []);
});

test('cosine behaves', () => {
  const a = Float32Array.from([1, 0, 0]);
  const b = Float32Array.from([1, 0, 0]);
  const c = Float32Array.from([0, 1, 0]);
  assert.equal(Math.round(cosine(a, b) * 1000) / 1000, 1);
  assert.equal(cosine(a, c), 0);
  assert.equal(cosine(a, Float32Array.from([0, 0, 0])), 0, 'zero vector must not divide by zero');
});

test('max-sim rewards covering each requirement somewhere', () => {
  // Resume covers both topics, but in separate chunks. Whole-document averaging
  // would dilute both; max-sim should score near perfect.
  const resume = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
  const job = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
  const { score } = maxSimScore(resume, job, ['aaaa', 'bbbb']);
  assert.ok(score > 0.99, `expected near-perfect coverage, got ${score}`);

  // A resume missing one topic scores lower.
  const partial = [Float32Array.from([1, 0])];
  const { score: partialScore } = maxSimScore(partial, job, ['aaaa', 'bbbb']);
  assert.ok(partialScore < score, `${partialScore} should be below ${score}`);
});

// ---------------------------------------------------------------------------
// Embedding + caching against the fake Ollama
// ---------------------------------------------------------------------------

test('embeddings are cached across calls', needsServerDeps, async (t) => {
  const fake = await startFakeOllama();
  t.after(() => fake.server.close());

  const emb = loadEmbeddings(fake.port, scratchDb(t));

  await emb.embed(['python kafka', 'nurse patient']);
  assert.equal(fake.calls.embedTexts.length, 2, 'both texts embedded on first call');

  await emb.embed(['python kafka', 'nurse patient']);
  assert.equal(fake.calls.embedTexts.length, 2, 'second call should be served entirely from cache');

  await emb.embed(['python kafka', 'a brand new text']);
  assert.equal(fake.calls.embedTexts.length, 3, 'only the new text should be embedded');
});

test('duplicate texts in one batch are embedded once', needsServerDeps, async (t) => {
  const fake = await startFakeOllama();
  t.after(() => fake.server.close());

  const emb = loadEmbeddings(fake.port, scratchDb(t));
  const vectors = await emb.embed(['same', 'same', 'same']);

  assert.equal(fake.calls.embedTexts.length, 1, 'the repeated text should be sent once');
  assert.equal(vectors.length, 3, 'but a vector is returned for every input');
  assert.deepEqual([...vectors[0]], [...vectors[2]]);
});

test('cached vectors survive a reload and match the originals', needsServerDeps, async (t) => {
  const fake = await startFakeOllama();
  t.after(() => fake.server.close());
  const dbFile = scratchDb(t);

  const first = loadEmbeddings(fake.port, dbFile);
  const [original] = await first.embed(['python kafka streaming']);

  // Fresh module instance, same database — as happens across server restarts.
  const second = loadEmbeddings(fake.port, dbFile);
  const [restored] = await second.embed(['python kafka streaming']);

  assert.equal(fake.calls.embedTexts.length, 1, 'the restart should not re-embed');
  assert.deepEqual([...restored], [...original], 'a cached vector must round-trip exactly');
});

test('semantic scoring ranks a relevant job above an unrelated one', needsServerDeps, async (t) => {
  const fake = await startFakeOllama();
  t.after(() => fake.server.close());

  const emb = loadEmbeddings(fake.port, scratchDb(t));

  const resume = [
    'Data platform engineer building streaming systems.',
    'Python and Kafka pipelines running on Kubernetes and AWS with Terraform.',
  ].join('\n\n');

  const jobs = [
    { title: 'Nurse', description: 'Patient care on the ward, ventilator monitoring duties for patients.' },
    { title: 'Data Platform Engineer', description: 'Python and Kafka streaming on Kubernetes with Terraform and AWS.' },
  ];

  const [nurse, engineer] = await emb.scoreJobsSemantically(resume, jobs);

  assert.ok(engineer.score > nurse.score, `engineer ${engineer.score} should beat nurse ${nurse.score}`);
  assert.ok(
    engineer.relevantResumeChunks.length > 0,
    'the relevant resume passages should be identified for the LLM stage'
  );
});

test('a job with no description is not scored as zero', needsServerDeps, async (t) => {
  const fake = await startFakeOllama();
  t.after(() => fake.server.close());

  const emb = loadEmbeddings(fake.port, scratchDb(t));
  const [result] = await emb.scoreJobsSemantically('Python engineer resume text here.', [
    { title: '', description: '' },
  ]);

  assert.equal(result.score, null, 'unknown must stay distinguishable from a 0% match');
});

test('an empty resume yields null scores, not zeros', needsServerDeps, async (t) => {
  const fake = await startFakeOllama();
  t.after(() => fake.server.close());

  const emb = loadEmbeddings(fake.port, scratchDb(t));
  const results = await emb.scoreJobsSemantically('', [{ title: 'X', description: 'Python role' }]);
  assert.equal(results[0].score, null);
});

// ---------------------------------------------------------------------------
// The two-stage /api/score endpoint
// ---------------------------------------------------------------------------

/** Boot the real express app against the fake Ollama. */
async function startApi(port, dbFile) {
  process.env.OLLAMA_URL = `http://127.0.0.1:${port}`;
  process.env.JM_DB_PATH = dbFile;
  for (const mod of ['../server/embeddings', '../server/db', '../server/llm', '../server/routes/score']) {
    delete require.cache[require.resolve(mod)];
  }

  const express = require(require.resolve('express', { paths: [SERVER_DIR] }));
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/score', require('../server/routes/score'));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const RESUME = [
  'Data platform engineer, eight years.',
  'Python and Kafka streaming pipelines on Kubernetes and AWS with Terraform.',
].join('\n\n');

const JOBS = [
  { id: 'nurse', title: 'Nurse', description: 'Patient care on the ward and ventilator monitoring for patients.' },
  { id: 'dpe', title: 'Data Platform Engineer', description: 'Python and Kafka streaming on Kubernetes with Terraform and AWS.' },
  { id: 'design', title: 'Designer', description: 'Figma and design systems work for our brand.' },
];

test('stage 1 only returns embedding scores without calling the LLM', needsServerDeps, async (t) => {
  const fake = await startFakeOllama();
  t.after(() => fake.server.close());
  const api = await startApi(fake.port, scratchDb(t));
  t.after(() => api.server.close());

  const res = await fetch(`${api.url}/api/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeText: RESUME, jobs: JOBS, stage2: false }),
  });

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.stage, 'embeddings');
  assert.equal(fake.calls.chat, 0, 'stage 2 was disabled, so no LLM calls');
  assert.equal(data.results.length, 3);

  const byId = Object.fromEntries(data.results.map((r) => [r.id, r]));
  assert.ok(byId.dpe.stage1Score > byId.nurse.stage1Score);
  assert.equal(byId.dpe.scorer, 'embeddings');
  // Internal fields must not leak to the client.
  assert.ok(!('_job' in byId.dpe) && !('_relevantChunks' in byId.dpe));
});

test('stage 2 judges only the shortlist and its score wins', needsServerDeps, async (t) => {
  const fake = await startFakeOllama();
  t.after(() => fake.server.close());
  const api = await startApi(fake.port, scratchDb(t));
  t.after(() => api.server.close());

  const res = await fetch(`${api.url}/api/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeText: RESUME, jobs: JOBS, stage2: true, shortlistSize: 1 }),
  });

  const data = await res.json();
  assert.equal(data.stage, 'embeddings+llm');
  assert.equal(fake.calls.chat, 1, 'only the single shortlisted job should be judged');
  assert.equal(data.judged, 1);

  const byId = Object.fromEntries(data.results.map((r) => [r.id, r]));
  assert.equal(byId.dpe.llmScore, 88, 'the top job got the LLM score');
  assert.equal(byId.dpe.finalScore, 88, 'the LLM score is what gets shown');
  assert.equal(byId.dpe.scorer, 'embeddings+llm');

  // Everything below the shortlist keeps its stage-1 score, clearly labelled.
  assert.equal(byId.nurse.llmScore, null);
  assert.equal(byId.nurse.scorer, 'embeddings');
  assert.equal(byId.nurse.finalScore, byId.nurse.stage1Score);
});

test('an LLM failure falls back to the stage-1 score rather than dropping the job', needsServerDeps, async (t) => {
  const fake = await startFakeOllama({ chatReply: 'I refuse to answer in JSON' });
  t.after(() => fake.server.close());
  const api = await startApi(fake.port, scratchDb(t));
  t.after(() => api.server.close());

  const res = await fetch(`${api.url}/api/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeText: RESUME, jobs: JOBS, stage2: true }),
  });

  const data = await res.json();
  assert.equal(data.judged, 0, 'nothing was successfully judged');

  for (const r of data.results) {
    assert.equal(r.finalScore, r.stage1Score, 'jobs keep their stage-1 score');
    assert.equal(r.scorer, 'embeddings', 'and are labelled as not LLM-judged');
  }
});

test('score endpoint validates its input', needsServerDeps, async (t) => {
  const fake = await startFakeOllama();
  t.after(() => fake.server.close());
  const api = await startApi(fake.port, scratchDb(t));
  t.after(() => api.server.close());

  const post = (body) =>
    fetch(`${api.url}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  assert.equal((await post({ jobs: JOBS })).status, 400);
  assert.equal((await post({ resumeText: RESUME })).status, 400);
  assert.equal((await post({ resumeText: RESUME, jobs: [] })).status, 400);
});
