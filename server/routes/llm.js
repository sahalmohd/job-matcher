const express = require('express');
const { scoreWithLLM, checkOllamaHealth } = require('../llm');

const router = express.Router();

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

    const capped = jobs.slice(0, 10);
    const results = [];

    for (const job of capped) {
      try {
        const result = await scoreWithLLM(resumeText, job);
        results.push({ job, ...result });
      } catch (err) {
        results.push({
          job,
          score: null,
          error: err.message,
          rationale: null,
          keyStrengths: [],
          gaps: [],
        });
      }
    }

    res.json({ results, processedCount: results.length });
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
