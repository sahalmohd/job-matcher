const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'job_matcher.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_title TEXT NOT NULL,
      company TEXT DEFAULT '',
      url TEXT DEFAULT '',
      score REAL NOT NULL,
      platform TEXT DEFAULT '',
      matched_skills TEXT DEFAULT '[]',
      missing_skills TEXT DEFAULT '[]',
      matched_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_matches_score ON matches(score DESC);
    CREATE INDEX IF NOT EXISTS idx_matches_platform ON matches(platform);
    CREATE INDEX IF NOT EXISTS idx_matches_matched_at ON matches(matched_at DESC);
  `);
}

function insertMatches(matches) {
  const stmt = db.prepare(`
    INSERT INTO matches (job_title, company, url, score, platform, matched_skills, missing_skills, matched_at)
    VALUES (@jobTitle, @company, @url, @score, @platform, @matchedSkills, @missingSkills, @matchedAt)
  `);

  const insert = db.transaction((items) => {
    for (const item of items) {
      stmt.run({
        jobTitle: item.jobTitle || '',
        company: item.company || '',
        url: item.url || '',
        score: item.score || 0,
        platform: item.platform || '',
        matchedSkills: JSON.stringify(item.matchedSkills || []),
        missingSkills: JSON.stringify(item.missingSkills || []),
        matchedAt: item.matchedAt || new Date().toISOString(),
      });
    }
  });

  insert(matches);
}

function getMatches({ limit = 100, offset = 0, minScore = 0, platform = null } = {}) {
  let query = 'SELECT * FROM matches WHERE score >= ?';
  const params = [minScore];

  if (platform) {
    query += ' AND platform = ?';
    params.push(platform);
  }

  query += ' ORDER BY matched_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = getDb().prepare(query).all(...params);

  return rows.map((row) => ({
    ...row,
    matched_skills: JSON.parse(row.matched_skills || '[]'),
    missing_skills: JSON.parse(row.missing_skills || '[]'),
  }));
}

function getMatchCount() {
  return getDb().prepare('SELECT COUNT(*) as count FROM matches').get().count;
}

function deleteAllMatches() {
  getDb().prepare('DELETE FROM matches').run();
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  insertMatches,
  getMatches,
  getMatchCount,
  deleteAllMatches,
  close,
};
