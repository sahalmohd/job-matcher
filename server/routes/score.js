const express = require('express');
const { scoreJobsSemantically, checkEmbeddingHealth } = require('../embeddings');
const { scoreWithLLM, checkOllamaHealth } = require('../llm');

const router = express.Router();

// How many of the stage-1 leaders get the expensive LLM judgement.
const SHORTLIST_SIZE = Number(process.env.JM_SHORTLIST_SIZE || 10);
// Ollama handles a few concurrent generations comfortably, and this is the
// dominant cost of a scan. Scoring was previously strictly sequential.
const LLM_CONCURRENCY = Number(process.env.JM_LLM_CONCURRENCY || 3);

/** Run an async mapper over items with bounded concurrency, preserving order. */
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Two-stage scoring.
 *
 *   Stage 1 — embed every job and score it by max-sim against the resume.
 *             Cheap enough to run over the whole scan, and cached.
 *   Stage 2 — hand the top N to the LLM for a judged score with a rationale.
 *
 * The LLM score becomes the score shown; stage 1 decides who gets judged and
 * breaks ties below the shortlist.
 */
router.post('/', async (req, res) => {
  try {
    const { resumeText, jobs, stage2 = true, shortlistSize = SHORTLIST_SIZE } = req.body;

    if (!resumeText || typeof resumeText !== 'string') {
      return res.status(400).json({ error: 'resumeText string is required' });
    }
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ error: 'jobs array is required' });
    }

    // Stage 1: semantic similarity for everything.
    const semantic = await scoreJobsSemantically(resumeText, jobs);

    const results = jobs.map((job, i) => ({
      id: job.id ?? job._jmId ?? job.url ?? `idx-${i}`,
      title: job.title,
      stage1Score: semantic[i].score,
      rawSimilarity: semantic[i].rawSimilarity ?? null,
      finalScore: semantic[i].score,
      llmScore: null,
      rationale: null,
      keyStrengths: [],
      gaps: [],
      scorer: 'embeddings',
      // Not sent to the client; used to build the stage-2 prompt.
      _relevantChunks: semantic[i].relevantResumeChunks || [],
      _job: job,
      _index: i,
    }));

    if (!stage2) {
      return res.json({ results: results.map(strip), stage: 'embeddings' });
    }

    // Stage 2: judge the leaders.
    const shortlist = results
      .filter((r) => r.stage1Score != null)
      .sort((a, b) => b.stage1Score - a.stage1Score)
      .slice(0, shortlistSize);

    await mapWithConcurrency(shortlist, LLM_CONCURRENCY, async (entry) => {
      try {
        // Send the resume passages stage 1 found relevant rather than the
        // first 2000 characters, which often cut off mid-section.
        const focusedResume = entry._relevantChunks.length > 0
          ? entry._relevantChunks.join('\n\n')
          : resumeText;

        const judged = await scoreWithLLM(focusedResume, entry._job);
        if (judged && judged.score != null) {
          entry.llmScore = judged.score;
          entry.finalScore = judged.score;
          entry.rationale = judged.rationale || null;
          entry.keyStrengths = judged.keyStrengths || [];
          entry.gaps = judged.gaps || [];
          entry.scorer = 'embeddings+llm';
          entry.model = judged.model;
        }
      } catch (err) {
        // A job the LLM could not judge keeps its stage-1 score, and says so.
        entry.llmError = err.message;
        console.warn(`LLM judge failed for "${entry.title}": ${err.message}`);
      }
    });

    res.json({
      results: results.map(strip),
      stage: 'embeddings+llm',
      judged: shortlist.filter((e) => e.llmScore != null).length,
      shortlistSize: shortlist.length,
    });
  } catch (err) {
    console.error('Score error:', err);
    res.status(502).json({ error: 'Scoring failed', detail: err.message });
  }
});

/** Drop internal fields before returning to the client. */
function strip(entry) {
  const { _relevantChunks, _job, _index, ...rest } = entry;
  return rest;
}

router.get('/status', async (req, res) => {
  const [chat, embeddings] = await Promise.all([checkOllamaHealth(), checkEmbeddingHealth()]);
  res.json({
    available: chat.available && embeddings.available,
    chat,
    embeddings,
    shortlistSize: SHORTLIST_SIZE,
    concurrency: LLM_CONCURRENCY,
  });
});

module.exports = router;
