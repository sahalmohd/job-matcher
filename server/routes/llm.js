const express = require('express');
const { scoreWithLLM, checkOllamaHealth } = require('../llm');

const router = express.Router();

// Reported back to the client so it can detect a mismatch with its own limit
// instead of the two silently drifting apart.
const BATCH_LIMIT = Number(process.env.LLM_BATCH_LIMIT || 10);

router.post('/score', async (req, res) => {
  try {
    const { resumeText, job } = req.body;

    if (!resumeText || typeof resumeText !== 'string') {
      return res.status(400).json({ error: 'resumeText string is required' });
    }
    if (!job || typeof job !== 'object') {
      return res.status(400).json({ error: 'job object is required' });
    }

    const result = await scoreWithLLM(resumeText, job);
    res.json(result);
  } catch (err) {
    console.error('LLM score error:', err.message);
    res.status(502).json({
      error: 'LLM scoring failed',
      detail: err.message,
    });
  }
});

router.post('/score-batch', async (req, res) => {
  try {
    const { resumeText, jobs } = req.body;

    if (!resumeText || typeof resumeText !== 'string') {
      return res.status(400).json({ error: 'resumeText string is required' });
    }
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ error: 'jobs array is required' });
    }

    const capped = jobs.slice(0, BATCH_LIMIT);
    const results = [];

    for (let i = 0; i < capped.length; i++) {
      const job = capped[i];
      // Echo the caller's identifier so results are matched by id rather than
      // by array position, which silently misattributed scores whenever the
      // client's batch limit and this one diverged.
      const _jmId = job._jmId ?? `idx-${i}`;

      try {
        const result = await scoreWithLLM(resumeText, job);
        results.push({ _jmId, title: job.title, ...result });
      } catch (err) {
        results.push({
          _jmId,
          title: job.title,
          score: null,
          error: err.message,
          rationale: null,
          keyStrengths: [],
          gaps: [],
        });
      }
    }

    res.json({ results, processedCount: results.length, batchLimit: BATCH_LIMIT });
  } catch (err) {
    console.error('LLM batch score error:', err.message);
    res.status(502).json({ error: 'LLM batch scoring failed', detail: err.message });
  }
});

router.get('/status', async (req, res) => {
  const status = await checkOllamaHealth();
  res.json(status);
});

module.exports = router;
