const express = require('express');
const db = require('../db');

const router = express.Router();

router.post('/', (req, res) => {
  try {
    const { matches } = req.body;

    if (!Array.isArray(matches) || matches.length === 0) {
      return res.status(400).json({ error: 'matches array is required' });
    }

    db.getDb();
    db.insertMatches(matches);

    res.json({
      status: 'ok',
      inserted: matches.length,
      total: db.getMatchCount(),
    });
  } catch (err) {
    console.error('Error inserting matches:', err);
    res.status(500).json({ error: 'Failed to insert matches' });
  }
});

router.get('/', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const minScore = parseFloat(req.query.minScore) || 0;
    const platform = req.query.platform || null;

    db.getDb();
    const matches = db.getMatches({ limit, offset, minScore, platform });
    const total = db.getMatchCount();

    res.json({ matches, total, limit, offset });
  } catch (err) {
    console.error('Error fetching matches:', err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

router.delete('/', (req, res) => {
  try {
    db.getDb();
    db.deleteAllMatches();
    res.json({ status: 'ok', message: 'All matches deleted' });
  } catch (err) {
    console.error('Error deleting matches:', err);
    res.status(500).json({ error: 'Failed to delete matches' });
  }
});

module.exports = router;
