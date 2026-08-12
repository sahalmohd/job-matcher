'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadScripts, LIB_DIR, REPO_ROOT } = require('../eval/load');
const { createChromeMock } = require('./helpers/chrome-mock');

/**
 * Load background.js with a mocked chrome API.
 *
 * background.js is a service worker: it opens with importScripts() and
 * registers listeners at module scope. Both are stubbed so it can be evaluated
 * in Node and its top-level functions exercised directly.
 */
function loadBackground(options = {}) {
  const mock = createChromeMock(options);

  const exported = loadScripts(
    [
      path.join(LIB_DIR, 'vocab.js'),
      path.join(LIB_DIR, 'tfidf.js'),
      path.join(LIB_DIR, 'matcher.js'),
      path.join(REPO_ROOT, 'extension', 'background.js'),
    ],
    [
      'acquireScanLock',
      'getScanState',
      'setScanState',
      'clearScanState',
      'recoverInterruptedScan',
      'finalizeInterruptedScan',
      'watchdogTick',
      'setupAlarms',
      'setTabMode',
      'getTabMode',
      'buildLinkedInSearchUrl',
      'prioritiseForEnrichment',
      'ingestJobs',
      'withMatchesLock',
      'jitter',
      'SCAN_STALL_MS',
    ],
    {
      chrome: mock.chrome,
      importScripts: () => {},
      fetch: async () => {
        throw new Error('network disabled in tests');
      },
      AbortSignal,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date,
      Math,
      JSON,
      Set,
      Map,
      Promise,
      Error,
      URLSearchParams,
    }
  );

  // Objects created inside the vm have that realm's prototypes, so
  // deepStrictEqual against a host-realm literal fails even when the contents
  // match. Compare plain snapshots instead.
  const plain = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

  return {
    ...exported,
    mock,
    plain,
    // Write session state directly, bypassing setScanState — which always
    // stamps a fresh updatedAt and so cannot be used to simulate an old state.
    seedScanState(state) {
      mock.chrome.storage.session._store.scanState = state;
    },
    readScanState() {
      return mock.chrome.storage.session._store.scanState ?? null;
    },
  };
}

test('search URLs carry no automation marker', () => {
  const bg = loadBackground();
  const url = bg.buildLinkedInSearchUrl({
    keywords: 'data engineer',
    location: 'Berlin',
    workType: 'remote',
  });

  assert.ok(!url.includes('_jm_scan'), `URL must not be fingerprinted: ${url}`);
  assert.ok(!url.includes('_jm_enrich'));
  assert.match(url, /keywords=data\+engineer/);
  assert.match(url, /f_WT=2/);
});

test('only one scan runs at a time', async () => {
  const bg = loadBackground();

  const first = await bg.acquireScanLock('profile-a');
  assert.equal(first.ok, true);

  const second = await bg.acquireScanLock('profile-b');
  assert.equal(second.ok, false, 'a concurrent scan must be refused');
  assert.match(second.reason, /already running/);
});

test('a stale lock is reclaimed rather than deadlocking', async () => {
  const bg = loadBackground();

  await bg.acquireScanLock('profile-a');
  // Backdate the holder past the stall threshold.
  bg.seedScanState({
    ...bg.readScanState(),
    updatedAt: Date.now() - (bg.SCAN_STALL_MS + 1000),
  });

  const next = await bg.acquireScanLock('profile-b');
  assert.equal(next.ok, true, 'a scan abandoned long ago must not block new scans forever');

  const state = await bg.getScanState();
  assert.equal(state.profileId, 'profile-b');
});

test('an interrupted scan is cleaned up on worker start', async () => {
  // Simulate what a killed worker leaves behind: scan state pointing at a tab,
  // and a scanStatus stuck on "scanning".
  const bg = loadBackground({
    sessionData: {
      scanState: { profileId: 'p1', phase: 'enriching', tabId: 7, updatedAt: Date.now() },
    },
    localData: {
      scanStatus: { p1: { state: 'scanning', progress: 60 } },
    },
  });

  bg.mock.tabs.set(7, { id: 7, url: 'https://linkedin.com/jobs/view/1' });

  // background.js runs recovery once at module scope, which consumes the state
  // seeded above; re-seed so the explicit call below has something to find.
  bg.seedScanState({ profileId: 'p1', phase: 'enriching', tabId: 7, updatedAt: Date.now() });

  await bg.recoverInterruptedScan();

  assert.equal(bg.readScanState(), null, 'scan state should be cleared');
  assert.equal(bg.mock.tabs.has(7), false, 'the orphaned tab should be closed');

  const status = bg.mock.chrome.storage.local._store.scanStatus.p1;
  assert.equal(status.state, 'error', 'the UI must not be left showing "scanning" forever');
  assert.match(status.error, /interrupted/i);
});

test('the watchdog ends a scan that stopped responding', async () => {
  const bg = loadBackground();

  await bg.acquireScanLock('p1');
  await bg.setScanState({ phase: 'collecting', tabId: 3 });
  bg.mock.tabs.set(3, { id: 3, url: 'https://linkedin.com/jobs/search' });

  // Not yet stalled — the watchdog should leave it alone.
  await bg.watchdogTick();
  assert.notEqual(bg.readScanState(), null, 'a live scan must not be killed');

  bg.seedScanState({
    ...bg.readScanState(),
    updatedAt: Date.now() - (bg.SCAN_STALL_MS + 1000),
    heartbeat: 0,
  });
  await bg.watchdogTick();

  assert.equal(bg.readScanState(), null, 'a stalled scan should be torn down');
  assert.equal(bg.mock.tabs.has(3), false, 'its tab should be closed');
});

test('setupAlarms leaves correctly-scheduled alarms untouched', async () => {
  const bg = loadBackground();
  const profiles = [{ id: 'p1', enabled: true, interval: 1440 }];

  await bg.setupAlarms(profiles);
  const created = bg.mock.alarms.get('search-profile-p1');
  assert.ok(created, 'an enabled profile should get an alarm');
  assert.equal(created.periodInMinutes, 1440);
  assert.equal(created.delayInMinutes, 1, 'a new profile should run soon, not a full period later');

  // Mark it as an already-scheduled alarm, then reconcile again — as happens on
  // every worker wake-up.
  bg.mock.alarms.set('search-profile-p1', {
    name: 'search-profile-p1',
    periodInMinutes: 1440,
    delayInMinutes: 1440,
  });

  await bg.setupAlarms(profiles);

  assert.deepEqual(
    bg.plain(bg.mock.alarms.get('search-profile-p1')),
    { name: 'search-profile-p1', periodInMinutes: 1440, delayInMinutes: 1440 },
    'reconciling must not reset an existing alarm — that pushed the next run back on every wake'
  );
});

test('setupAlarms clears alarms for disabled and deleted profiles', async () => {
  const bg = loadBackground();

  await bg.setupAlarms([
    { id: 'p1', enabled: true, interval: 60 },
    { id: 'p2', enabled: true, interval: 60 },
  ]);
  assert.equal(bg.mock.alarms.size, 2);

  await bg.setupAlarms([{ id: 'p1', enabled: false, interval: 60 }]);
  assert.equal(bg.mock.alarms.has('search-profile-p1'), false, 'disabled profile alarm removed');
  assert.equal(bg.mock.alarms.has('search-profile-p2'), false, 'deleted profile alarm removed');
});

test('scan intervals below the floor are raised', async () => {
  const bg = loadBackground();
  await bg.setupAlarms([{ id: 'p1', enabled: true, interval: 2 }]);
  assert.equal(bg.mock.alarms.get('search-profile-p1').periodInMinutes, 15);
});

test('tab modes are recorded per tab', async () => {
  const bg = loadBackground();

  await bg.setTabMode(42, 'enrich', 'p1');
  assert.deepEqual(bg.plain(await bg.getTabMode(42)), { mode: 'enrich', profileId: 'p1' });
  assert.equal(await bg.getTabMode(43), null, 'an unrelated tab has no mode');
});

test('jitter stays within its stated spread', () => {
  const bg = loadBackground();
  for (let i = 0; i < 200; i++) {
    const value = bg.jitter(1000, 0.35);
    assert.ok(value >= 650 && value <= 1350, `jitter(1000, 0.35) out of range: ${value}`);
  }
  // And it must actually vary.
  const values = new Set(Array.from({ length: 50 }, () => bg.jitter(1000)));
  assert.ok(values.size > 5, 'jitter should produce varied delays');
});

test('pagination produces distinct result pages', () => {
  const bg = loadBackground();
  const profile = { keywords: 'data engineer', location: 'Berlin' };

  const page0 = bg.buildLinkedInSearchUrl(profile, 0);
  const page1 = bg.buildLinkedInSearchUrl(profile, 1);
  const page2 = bg.buildLinkedInSearchUrl(profile, 2);

  assert.ok(!page0.includes('start='), 'the first page needs no start offset');
  assert.match(page1, /start=25/);
  assert.match(page2, /start=50/);
});

test('enrichment budget goes to the most promising jobs', () => {
  const bg = loadBackground();

  const resume = 'Python Kafka Kubernetes AWS Terraform data platform engineer, 8 years.';
  const jobs = [
    { title: 'Nurse, ICU', url: 'https://l/jobs/view/1', description: 'Patient care and ventilators on the ward.' },
    { title: 'Graphic Designer', url: 'https://l/jobs/view/2', description: 'Figma, Illustrator, brand design work.' },
    { title: 'Data Platform Engineer', url: 'https://l/jobs/view/3', description: 'Python, Kafka, Kubernetes, AWS, Terraform.' },
    { title: 'Sales Rep', url: 'https://l/jobs/view/4', description: 'Quota carrying enterprise sales role.' },
  ];

  // Ranked order: the relevant job must come first, ahead of everything the
  // scorer rates at zero.
  const ranked = bg.prioritiseForEnrichment(jobs, resume, {}, 4);
  assert.equal(
    ranked[0].title,
    'Data Platform Engineer',
    `expected the matching job first, got: ${ranked.map((j) => j.title).join(', ')}`
  );

  // With a budget of one, only that job is worth a page load — under the old
  // "first N in LinkedIn's order" rule this slot went to the nurse posting.
  const chosen = bg.prioritiseForEnrichment(jobs, resume, {}, 1);
  assert.deepEqual(chosen.map((j) => j.title), ['Data Platform Engineer']);
});

test('everything within budget is still returned, and still ranked', () => {
  const bg = loadBackground();
  const jobs = [
    { title: 'Nurse', url: 'https://l/jobs/view/1', description: 'Ward patient care and ventilator monitoring duties.' },
    { title: 'Kafka Engineer', url: 'https://l/jobs/view/2', description: 'Python, Kafka and Kubernetes streaming platform work.' },
  ];
  const chosen = bg.prioritiseForEnrichment(jobs, 'Python Kafka Kubernetes engineer', {}, 10);

  assert.equal(chosen.length, 2, 'nothing is dropped when everything fits');
  assert.equal(chosen[0].title, 'Kafka Engineer', 'best-first, so an interrupted scan keeps the best');
});

test('jobs without a viewable URL are never enriched', () => {
  const bg = loadBackground();
  const jobs = [
    { title: 'No URL', description: 'x'.repeat(60) },
    { title: 'Search page', url: 'https://l/jobs/search?q=1', description: 'y'.repeat(60) },
    { title: 'Real', url: 'https://l/jobs/view/9', description: 'z'.repeat(60) },
  ];
  const chosen = bg.prioritiseForEnrichment(jobs, 'resume', {}, 1);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].title, 'Real');
});

test('concurrent match writes are serialized', async () => {
  const bg = loadBackground();

  // Two overlapping read-modify-write cycles. Without the lock the second
  // read happens before the first write lands and one increment is lost.
  let shared = 0;
  const cycle = () =>
    bg.withMatchesLock(async () => {
      const read = shared;
      await new Promise((r) => setTimeout(r, 5));
      shared = read + 1;
    });

  await Promise.all([cycle(), cycle(), cycle()]);
  assert.equal(shared, 3, 'every write must be applied, none lost to a race');
});

test('a failed write does not wedge the queue', async () => {
  const bg = loadBackground();

  await assert.rejects(() => bg.withMatchesLock(async () => { throw new Error('boom'); }));

  const after = await bg.withMatchesLock(async () => 'still works');
  assert.equal(after, 'still works');
});
