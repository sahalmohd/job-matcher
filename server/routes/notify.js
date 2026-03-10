const express = require('express');
const { sendMatchNotification } = require('../email');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { email, matches } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }

    if (!Array.isArray(matches) || matches.length === 0) {
      return res.status(400).json({ error: 'matches array is required' });
    }

    const result = await sendMatchNotification(email, matches);

    if (result.sent) {
      res.json({ status: 'ok', message: `Email sent to ${email}` });
    } else if (result.reason === 'rate_limited') {
      res.status(429).json({
        status: 'rate_limited',
        message: 'Email rate limit exceeded',
        retryAfterMs: result.retryAfter,
      });
    } else {
      res.status(503).json({
        status: 'unavailable',
        reason: result.reason,
        hint: result.hint || result.error,
      });
    }
  } catch (err) {
    console.error('Notify error:', err);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

module.exports = router;
