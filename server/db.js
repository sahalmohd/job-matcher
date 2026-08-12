const Database = require('better-sqlite3');
const path = require('path');

// Overridable so tests can run the schema migration against a scratch file.
const DB_PATH = process.env.JM_DB_PATH || path.join(__dirname, 'job_matcher.db');

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

    -- Embedding cache. Keyed by a hash of (model, text), so a resume is
    -- embedded once per upload and a job chunk once ever. Without this every
    -- rescore re-pays the full embedding cost.
    CREATE TABLE IF NOT EXISTS embeddings (
      hash       TEXT PRIMARY KEY,
      model      TEXT NOT NULL,
      dim        INTEGER NOT NULL,
      vector     BLOB NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Existing duplicates must go before the unique index can be created;
  // creating it first fails with SQLITE_CONSTRAINT_UNIQUE on any database
  // written by an earlier version.
  deduplicateExistingRows();

  db.exec(`
    -- Without this, every scan re-inserted every job it had already seen.
    -- Partial so that rows with no URL (which cannot be deduped) still insert.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_url
      ON matches(url) WHERE url != '';
  `);
}

/**
 * Collapse duplicate URLs left behind by earlier versions, keeping the
 * highest-scoring row for each. Required before the unique index above can be
 * created on a database that already has duplicates.
 */
function deduplicateExistingRows() {
  const duplicates = db
    .prepare(`SELECT url, COUNT(*) c FROM matches WHERE url != '' GROUP BY url HAVING c > 1`)
    .all();

  if (duplicates.length === 0) return;

  db.exec(`
    DELETE FROM matches
    WHERE url != ''
      AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY url ORDER BY score DESC, matched_at DESC
          ) rn
          FROM matches WHERE url != ''
        ) WHERE rn = 1
      );
  `);

  console.log(`[db] Collapsed duplicates for ${duplicates.length} job URL(s)`);
}

function insertMatches(matches) {
  // Upsert: a job seen again updates in place, and keeps the better score
  // rather than creating a second row.
  const stmt = db.prepare(`
    INSERT INTO matches (job_title, company, url, score, platform, matched_skills, missing_skills, matched_at)
    VALUES (@jobTitle, @company, @url, @score, @platform, @matchedSkills, @missingSkills, @matchedAt)
    ON CONFLICT(url) WHERE url != '' DO UPDATE SET
      score          = MAX(matches.score, excluded.score),
      job_title      = excluded.job_title,
      company        = excluded.company,
      platform       = excluded.platform,
      matched_skills = excluded.matched_skills,
      missing_skills = excluded.missing_skills,
      matched_at     = excluded.matched_at
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

// ---------------------------------------------------------------------------
// Embedding cache
// ---------------------------------------------------------------------------

/** Fetch cached vectors for the given hashes. Returns Map<hash, Float32Array>. */
function getEmbeddings(hashes) {
  if (hashes.length === 0) return new Map();

  const placeholders = hashes.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT hash, dim, vector FROM embeddings WHERE hash IN (${placeholders})`)
    .all(...hashes);

  const found = new Map();
  for (const row of rows) {
    // The BLOB is the raw Float32 buffer; copy so the vector does not alias
    // node-sqlite's buffer.
    const copy = Buffer.from(row.vector);
    found.set(row.hash, new Float32Array(copy.buffer, copy.byteOffset, row.dim));
  }
  return found;
}

/** Store vectors. `entries` is an array of { hash, model, vector: Float32Array }. */
function putEmbeddings(entries) {
  if (entries.length === 0) return;

  const stmt = getDb().prepare(`
    INSERT INTO embeddings (hash, model, dim, vector)
    VALUES (@hash, @model, @dim, @vector)
    ON CONFLICT(hash) DO NOTHING
  `);

  const insert = getDb().transaction((items) => {
    for (const item of items) {
      stmt.run({
        hash: item.hash,
        model: item.model,
        dim: item.vector.length,
        vector: Buffer.from(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength),
      });
    }
  });

  insert(entries);
}

function getEmbeddingCount() {
  return getDb().prepare('SELECT COUNT(*) as count FROM embeddings').get().count;
}

function clearEmbeddings() {
  getDb().prepare('DELETE FROM embeddings').run();
}

module.exports = {
  getDb,
  insertMatches,
  getMatches,
  getMatchCount,
  deleteAllMatches,
  getEmbeddings,
  putEmbeddings,
  getEmbeddingCount,
  clearEmbeddings,
  close,
};
