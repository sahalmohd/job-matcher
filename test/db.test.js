'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..', 'server');

// better-sqlite3 is a dependency of server/, not of the repo root, and it is a
// native module — skip rather than fail when the server deps aren't installed.
let Database;
try {
  Database = require(require.resolve('better-sqlite3', { paths: [SERVER_DIR] }));
} catch {
  Database = null;
}

const needsServerDeps = {
  skip: Database ? false : 'run `npm install` in server/ to enable database tests',
};

/** Create a database in the pre-migration schema, with duplicate URLs. */
function seedLegacyDb(file) {
  const legacy = new Database(file);
  legacy.exec(`
    CREATE TABLE matches (
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
  `);

  const insert = legacy.prepare(
    'INSERT INTO matches (job_title, url, score, matched_at) VALUES (?, ?, ?, ?)'
  );
  insert.run('Data Engineer', 'https://x/jobs/1', 60, '2026-01-01');
  insert.run('Data Engineer', 'https://x/jobs/1', 82, '2026-02-01');
  insert.run('Data Engineer', 'https://x/jobs/1', 71, '2026-03-01');
  insert.run('Backend Engineer', 'https://x/jobs/2', 55, '2026-01-01');
  insert.run('No URL A', '', 40, '2026-01-01');
  insert.run('No URL B', '', 41, '2026-01-01');
  legacy.close();
}

function loadDbModuleAt(file) {
  process.env.JM_DB_PATH = file;
  delete require.cache[require.resolve('../server/db')];
  return require('../server/db');
}

test('migration collapses duplicate URLs, keeping the best score', needsServerDeps, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-db-'));
  const file = path.join(dir, 'test.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  seedLegacyDb(file);

  const db = loadDbModuleAt(file);
  db.getDb(); // triggers initSchema + deduplication

  const rows = db.getMatches({ limit: 100 });
  const jobOne = rows.filter((r) => r.url === 'https://x/jobs/1');

  assert.equal(jobOne.length, 1, 'the three duplicate rows should collapse to one');
  assert.equal(jobOne[0].score, 82, 'the highest score should survive');

  // Rows with no URL cannot be deduplicated and must all be kept.
  assert.equal(rows.filter((r) => r.url === '').length, 2);
  assert.equal(db.getMatchCount(), 4);

  db.close();
});

test('re-inserting a known job updates instead of duplicating', needsServerDeps, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-db-'));
  const file = path.join(dir, 'test.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const db = loadDbModuleAt(file);
  db.getDb();

  const match = {
    jobTitle: 'Platform Engineer',
    company: 'Acme',
    url: 'https://x/jobs/9',
    score: 61,
    platform: 'linkedin',
    matchedSkills: ['kafka', 'python'],
    missingSkills: ['rust'],
    matchedAt: '2026-01-01',
  };

  db.insertMatches([match]);
  db.insertMatches([{ ...match, score: 74, matchedAt: '2026-02-01' }]);
  db.insertMatches([{ ...match, score: 50, matchedAt: '2026-03-01' }]);

  assert.equal(db.getMatchCount(), 1, 'the same URL must not create extra rows');

  const [row] = db.getMatches({ limit: 10 });
  assert.equal(row.score, 74, 'the best score should be retained');
  assert.deepEqual(row.matched_skills, ['kafka', 'python'], 'skills must persist, not stay []');
  assert.deepEqual(row.missing_skills, ['rust']);

  db.close();
});
