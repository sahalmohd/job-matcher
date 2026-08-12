/**
 * Semantic similarity between a resume and a job posting, using local Ollama
 * embeddings.
 *
 * The lexical scorer in the extension can only see shared words. It cannot tell
 * that "built streaming pipelines on Kafka" answers "experience with real-time
 * event processing", and it cannot tell that a recruiter posting quoting the
 * whole engineering stack is not an engineering job. Embeddings address the
 * first; the LLM judge in llm.js addresses the second.
 */

const crypto = require('crypto');
const db = require('./db');

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const EMBED_TIMEOUT_MS = Number(process.env.OLLAMA_EMBED_TIMEOUT_MS || 120000);

// Chunking targets, in characters. Small enough that a chunk expresses one
// idea, large enough to carry context.
const MIN_CHUNK = 120;
const MAX_CHUNK = 700;

function hashText(model, text) {
  return crypto.createHash('sha256').update(`${model}\0${text}`).digest('hex');
}

/**
 * Split a document into semantically coherent chunks.
 *
 * Embedding a whole resume into one vector averages away everything
 * distinctive — a backend CV and a frontend CV end up looking similar because
 * both are dominated by generic professional language. Chunking keeps each
 * role, skills block and requirement separable.
 */
function chunkText(text, { minChunk = MIN_CHUNK, maxChunk = MAX_CHUNK } = {}) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  // Prefer blank-line paragraph boundaries; fall back to single newlines
  // (bulleted resumes often have no blank lines at all).
  let blocks = normalized.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length <= 1) {
    blocks = normalized.split(/\n/).map((b) => b.trim()).filter(Boolean);
  }

  const chunks = [];
  let buffer = '';

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) chunks.push(trimmed);
    buffer = '';
  };

  for (const block of blocks) {
    // A block longer than maxChunk is split on sentence boundaries.
    const pieces = block.length > maxChunk ? splitSentences(block, maxChunk) : [block];

    for (const piece of pieces) {
      if (buffer && buffer.length + piece.length + 1 > maxChunk) flush();
      buffer = buffer ? `${buffer}\n${piece}` : piece;
      if (buffer.length >= minChunk) flush();
    }
  }
  flush();

  return chunks;
}

function splitSentences(text, maxChunk) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out = [];
  let buffer = '';

  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length + 1 > maxChunk) {
      out.push(buffer.trim());
      buffer = '';
    }
    buffer = buffer ? `${buffer} ${sentence}` : sentence;
  }
  if (buffer.trim()) out.push(buffer.trim());

  // A single sentence longer than maxChunk still has to be broken up.
  return out.flatMap((piece) =>
    piece.length <= maxChunk
      ? [piece]
      : piece.match(new RegExp(`.{1,${maxChunk}}`, 'gs')) || []
  );
}

/** Call Ollama for a batch of texts. Returns Float32Array[]. */
async function embedUncached(texts) {
  if (texts.length === 0) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

  try {
    // /api/embed accepts a batch. Older Ollama builds only have
    // /api/embeddings, which is one text per call.
    const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.embeddings) && data.embeddings.length === texts.length) {
        return data.embeddings.map((v) => Float32Array.from(v));
      }
      throw new Error('Unexpected /api/embed response shape');
    }

    if (res.status !== 404) {
      throw new Error(`Ollama /api/embed returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    // Fall back to the older single-text endpoint.
    const out = [];
    for (const text of texts) {
      const legacy = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      });
      if (!legacy.ok) {
        throw new Error(`Ollama /api/embeddings returned ${legacy.status}`);
      }
      const data = await legacy.json();
      out.push(Float32Array.from(data.embedding));
    }
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Embed texts, reading through the SQLite cache.
 *
 * Resume chunks change only when the resume is re-uploaded and job chunks never
 * change, so on a rescore this is almost entirely cache hits.
 */
async function embed(texts, { useCache = true } = {}) {
  if (texts.length === 0) return [];

  const hashes = texts.map((t) => hashText(EMBED_MODEL, t));
  const cached = useCache ? db.getEmbeddings(hashes) : new Map();

  // Deduplicate: the same chunk can appear more than once in a batch.
  const missingByHash = new Map();
  hashes.forEach((hash, i) => {
    if (!cached.has(hash) && !missingByHash.has(hash)) {
      missingByHash.set(hash, texts[i]);
    }
  });

  if (missingByHash.size > 0) {
    const missingHashes = [...missingByHash.keys()];
    const vectors = await embedUncached([...missingByHash.values()]);

    vectors.forEach((vector, i) => cached.set(missingHashes[i], vector));

    if (useCache) {
      db.putEmbeddings(
        vectors.map((vector, i) => ({ hash: missingHashes[i], model: EMBED_MODEL, vector }))
      );
    }
  }

  return hashes.map((hash) => cached.get(hash));
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Max-sim pooling: for each job chunk, how well is it covered by the *best*
 * matching part of the resume?
 *
 * Averaging whole-document vectors asks "do these two texts read similarly",
 * which rewards shared tone. This asks "is each requirement answered somewhere
 * in this CV", which is the actual question — and it does not penalise a
 * candidate whose resume covers more ground than the posting asks for.
 *
 * Longer job chunks weigh more, since a one-line chunk ("Nice to have: Redis")
 * should not count as much as a full requirements paragraph.
 */
function maxSimScore(resumeVectors, jobVectors, jobChunks) {
  if (resumeVectors.length === 0 || jobVectors.length === 0) return null;

  let weighted = 0;
  let totalWeight = 0;
  const perChunk = [];

  jobVectors.forEach((jobVec, j) => {
    let best = -1;
    let bestIdx = -1;
    resumeVectors.forEach((resumeVec, r) => {
      const sim = cosine(jobVec, resumeVec);
      if (sim > best) {
        best = sim;
        bestIdx = r;
      }
    });

    const weight = Math.sqrt((jobChunks[j] || '').length || 1);
    weighted += best * weight;
    totalWeight += weight;
    perChunk.push({ chunk: j, similarity: best, bestResumeChunk: bestIdx });
  });

  return { score: totalWeight === 0 ? null : weighted / totalWeight, perChunk };
}

/**
 * Semantic score (0-100) for each job against the resume, plus the resume
 * chunks most relevant to each job — which the LLM stage uses instead of
 * blindly sending the first 2000 characters.
 */
async function scoreJobsSemantically(resumeText, jobs) {
  const resumeChunks = chunkText(resumeText);
  if (resumeChunks.length === 0) {
    return jobs.map(() => ({ score: null, reason: 'empty resume' }));
  }

  const jobChunkLists = jobs.map((job) =>
    chunkText([job.title, job.description].filter(Boolean).join('\n'))
  );

  // One embedding call for everything, so the cache and the model are both
  // used efficiently.
  const allTexts = [...resumeChunks, ...jobChunkLists.flat()];
  const allVectors = await embed(allTexts);

  const resumeVectors = allVectors.slice(0, resumeChunks.length);
  let cursor = resumeChunks.length;

  return jobChunkLists.map((chunks) => {
    const vectors = allVectors.slice(cursor, cursor + chunks.length);
    cursor += chunks.length;

    if (chunks.length === 0) {
      return { score: null, reason: 'no job description', relevantResumeChunks: [] };
    }

    const result = maxSimScore(resumeVectors, vectors, chunks);
    if (!result || result.score == null) {
      return { score: null, reason: 'could not embed', relevantResumeChunks: [] };
    }

    // Which parts of the resume actually answered this posting.
    const relevant = [...new Set(result.perChunk.map((p) => p.bestResumeChunk))]
      .filter((i) => i >= 0)
      .slice(0, 6)
      .sort((a, b) => a - b)
      .map((i) => resumeChunks[i]);

    return {
      // Embedding cosines for related text cluster well above zero, so the raw
      // value is rescaled to spread the usable range over 0-100. Below ~0.3 the
      // texts are unrelated.
      score: Math.round(Math.max(0, Math.min(1, (result.score - 0.3) / 0.55)) * 100 * 100) / 100,
      rawSimilarity: Math.round(result.score * 10000) / 10000,
      relevantResumeChunks: relevant,
    };
  });
}

async function checkEmbeddingHealth() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };

    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    const ready = models.some((n) => n === EMBED_MODEL || n.startsWith(EMBED_MODEL.split(':')[0]));

    return {
      available: true,
      configuredModel: EMBED_MODEL,
      modelReady: ready,
      hint: ready ? null : `Run "ollama pull ${EMBED_MODEL}" to download the embedding model`,
    };
  } catch (err) {
    return {
      available: false,
      error: err.name === 'AbortError' ? 'Timeout connecting to Ollama' : err.message,
    };
  }
}

module.exports = {
  chunkText,
  splitSentences,
  cosine,
  maxSimScore,
  embed,
  scoreJobsSemantically,
  checkEmbeddingHealth,
  hashText,
  EMBED_MODEL,
};
