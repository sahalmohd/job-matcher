'use strict';

/**
 * Scorer variant registry. Each variant exposes:
 *   name        - CLI identifier
 *   describe    - one-line summary for the report
 *   available() - async; return {ok:true} or {ok:false, reason} so variants that
 *                 need the backend or Ollama skip cleanly instead of failing the run
 *   score()     - async; (resumeText, jobs) => [{ id, score }]
 *
 * Variants must not mutate the jobs they are given.
 */

const { loadCurrent, loadBaseline } = require('./load');

/** Score every job one-at-a-time through a JobMatcher-shaped API. */
function scorePerJob(ctx, resumeText, jobs) {
  return jobs.map((job) => {
    const result = ctx.JobMatcher.scoreJob(resumeText, job);
    return {
      id: job.id,
      score: result.score,
      detail: {
        tfidfScore: result.tfidfScore,
        skillScore: result.skillScore,
        matchedSkills: result.matchedSkills,
      },
    };
  });
}

const baseline = {
  name: 'baseline',
  describe: 'frozen pre-fix scorer (eval/baseline) — degenerate TF-IDF, asymmetric skills',
  async available() {
    return { ok: true };
  },
  async score(resumeText, jobs) {
    return scorePerJob(loadBaseline(), resumeText, jobs);
  },
};

const current = {
  name: 'current',
  describe: 'live extension/lib scorer',
  async available() {
    return { ok: true };
  },
  async score(resumeText, jobs) {
    const ctx = loadCurrent();
    // Prefer a corpus-aware batch API once matcher.js exposes one, so the
    // repaired IDF is measured the way production computes it.
    if (typeof ctx.JobMatcher.scoreBatch === 'function') {
      const results = ctx.JobMatcher.scoreBatch(resumeText, jobs);
      return results.map((r, i) => ({
        id: jobs[i].id,
        score: r.score,
        detail: {
          tfidfScore: r.tfidfScore,
          skillScore: r.skillScore,
          matchedSkills: r.matchedSkills,
        },
      }));
    }
    return scorePerJob(ctx, resumeText, jobs);
  },
};

/** Isolate the lexical half so a change there is attributable. */
const lexicalOnly = {
  name: 'lexical-only',
  describe: 'live TFIDF.score() alone, no skills component',
  async available() {
    return { ok: true };
  },
  async score(resumeText, jobs) {
    const ctx = loadCurrent();
    return jobs.map((job) => {
      const jobText = [job.title, job.company, job.description, job.location]
        .filter(Boolean)
        .join(' ');
      const score = ctx.TFIDF.score(resumeText, jobText);
      return { id: job.id, score: score == null ? 0 : score };
    });
  },
};

/** Isolate the skills half. */
const skillsOnly = {
  name: 'skills-only',
  describe: 'skill-overlap component alone',
  async available() {
    return { ok: true };
  },
  async score(resumeText, jobs) {
    const ctx = loadCurrent();
    const resumeSkills = ctx.JobMatcher.extractSkills(resumeText);
    return jobs.map((job) => {
      const jobText = [job.title, job.description].filter(Boolean).join(' ');
      const jobSkills = ctx.JobMatcher.extractSkills(jobText);
      const ratio = ctx.JobMatcher.skillMatchRatio(resumeSkills, jobSkills);
      return { id: job.id, score: Math.round(ratio * 10000) / 100 };
    });
  },
};

/**
 * Random ranking. Not a serious contender — it is the floor. If a real variant
 * cannot clearly beat this on the golden set, that variant is noise.
 */
const randomBaseline = {
  name: 'random',
  describe: 'control: uniform random scores (seeded)',
  async available() {
    return { ok: true };
  },
  async score(resumeText, jobs) {
    // Deterministic LCG so runs are reproducible.
    let seed = 1337;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    return jobs.map((job) => ({ id: job.id, score: Math.round(next() * 10000) / 100 }));
  },
};

const SERVER_URL = process.env.JM_SERVER_URL || 'http://localhost:3456';

/**
 * The embedding variants need the backend AND Ollama AND both models pulled.
 * Report precisely which piece is missing — "skipped" with no reason sends
 * people hunting.
 */
async function serverReady() {
  let status;
  try {
    const res = await fetch(`${SERVER_URL}/api/score/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, reason: `/api/score/status returned ${res.status}` };
    status = await res.json();
  } catch (err) {
    return { ok: false, reason: `backend unreachable at ${SERVER_URL} (${err.message})` };
  }

  if (!status.embeddings?.available || !status.chat?.available) {
    return { ok: false, reason: 'Ollama not running (start it with `ollama serve`)' };
  }
  if (!status.embeddings.modelReady) {
    return { ok: false, reason: status.embeddings.hint || 'embedding model not pulled' };
  }
  if (!status.chat.modelReady) {
    return { ok: false, reason: status.chat.hint || 'chat model not pulled' };
  }

  return { ok: true };
}

/**
 * Phase 2 variants. These call the backend rather than reimplementing scoring,
 * so the harness measures the same code path production uses.
 */
const embeddings = {
  name: 'embeddings',
  describe: 'stage 1 only: Ollama embedding max-sim + skills (via POST /api/score)',
  async available() {
    return serverReady();
  },
  async score(resumeText, jobs) {
    return postScore(resumeText, jobs, { stage2: false });
  },
};

const embeddingsLlm = {
  name: 'embeddings+llm',
  describe: 'stage 1 shortlist + LLM judge on top N (via POST /api/score)',
  async available() {
    return serverReady();
  },
  async score(resumeText, jobs) {
    return postScore(resumeText, jobs, { stage2: true });
  },
};

async function postScore(resumeText, jobs, { stage2 }) {
  const res = await fetch(`${SERVER_URL}/api/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeText, jobs, stage2 }),
    // LLM judging over a golden set is slow; allow generous headroom.
    signal: AbortSignal.timeout(stage2 ? 15 * 60 * 1000 : 5 * 60 * 1000),
  });

  if (!res.ok) {
    throw new Error(`POST /api/score returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  const byId = new Map((data.results || []).map((r) => [r.id, r]));

  return jobs.map((job) => {
    const r = byId.get(job.id);
    return {
      id: job.id,
      // A job the server declined to score must not silently become a zero.
      score: r && r.finalScore != null ? r.finalScore : null,
      detail: r ? { stage1Score: r.stage1Score, llmScore: r.llmScore, scorer: r.scorer } : null,
    };
  });
}

const VARIANTS = [
  randomBaseline,
  baseline,
  current,
  lexicalOnly,
  skillsOnly,
  embeddings,
  embeddingsLlm,
];

function getVariant(name) {
  const found = VARIANTS.find((v) => v.name === name);
  if (!found) {
    throw new Error(
      `Unknown variant "${name}". Available: ${VARIANTS.map((v) => v.name).join(', ')}`
    );
  }
  return found;
}

module.exports = { VARIANTS, getVariant };
