importScripts('lib/vocab.js', 'lib/tfidf.js', 'lib/matcher.js');

const STORAGE_KEYS = {
  RESUME_TEXT: 'resumeText',
  THRESHOLD: 'threshold',
  MATCHES: 'matches',
  SETTINGS: 'settings',
  LAST_EMAIL_TIME: 'lastEmailTime',
  PENDING_EMAIL_MATCHES: 'pendingEmailMatches',
  SEARCH_PROFILES: 'searchProfiles',
  SCAN_STATUS: 'scanStatus',
};

const ALARM_PREFIX = 'search-profile-';
const SCAN_TIMEOUT_MS = 120000;
// Raised from 15 now that enrichment is interruptible and watchdog-guarded.
const ENRICH_LIMIT = 25;
// Result pages to walk per scan. LinkedIn returns ~25 cards per page, so the
// scan previously saw only the first ~25 jobs of any search.
const SEARCH_PAGES = 3;
const RESULTS_PER_PAGE = 25;
const ENRICH_PAGE_TIMEOUT_MS = 15000;
const WORK_TYPE_MAP = { remote: '2', onsite: '1', hybrid: '3' };

const DEFAULTS = {
  threshold: 50,
  settings: {
    notificationsEnabled: true,
    emailEnabled: false,
    emailAddress: '',
    serverUrl: 'http://localhost:3456',
    platforms: { linkedin: true, indeed: true, glassdoor: true },
    weights: { lexical: 0.55, skills: 0.45 },
    llmEnabled: false,
    llmWeight: 0.3,
  },
};

const LLM_BATCH_LIMIT = 10;
// Ollama scores sequentially at up to 60s per job, so allow the full batch.
const LLM_REQUEST_TIMEOUT_MS = LLM_BATCH_LIMIT * 60 * 1000;

const EMAIL_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
// Cap on matches held for the next digest email during the cooldown window.
const PENDING_EMAIL_LIMIT = 50;

const MAX_STORED_MATCHES = 200;
const NOTIFICATION_LIMIT = 5;

/**
 * Serializes read-modify-write cycles on the stored matches array.
 *
 * Interactive content scripts post JOBS_FOUND every 2 seconds from every open
 * LinkedIn tab, and a scheduled scan writes at the same time. Each path did
 * get -> mutate -> set with no coordination, so concurrent writes overwrote one
 * another and matches were silently lost.
 */
let matchesWriteQueue = Promise.resolve();

function withMatchesLock(fn) {
  const run = matchesWriteQueue.then(fn, fn);
  // Keep the chain alive even if one operation rejects.
  matchesWriteQueue = run.catch(() => {});
  return run;
}

function normalizeJobUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch {
    return url.split('?')[0].replace(/\/$/, '');
  }
}

// Single message listener for all extension messaging
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Route scan-tab messages (progress, job lists, enrichment results)
  if (message.type === 'SCAN_PROGRESS' || message.type === 'SCAN_JOBS_LIST' || message.type === 'SCAN_JOB_DETAIL') {
    handleScanTabMessage(message, sender);
    return;
  }

  if (message.type === 'JOBS_FOUND') {
    if (sender.tab && (pendingScanTabs.has(sender.tab.id) || pendingEnrichTabs.has(sender.tab.id))) {
      handleScanTabMessage(message, sender);
      sendResponse({ status: 'ok' });
      return;
    }
    handleJobsFound(message.jobs, message.source).then(() => {
      sendResponse({ status: 'ok' });
    });
    return true;
  }

  // A content script asking what its tab is for. Replaces the _jm_scan /
  // _jm_enrich URL markers.
  if (message.type === 'GET_TAB_MODE') {
    if (!sender.tab) {
      sendResponse({ mode: 'interactive' });
      return;
    }
    getTabMode(sender.tab.id).then((entry) => {
      sendResponse({ mode: entry ? entry.mode : 'interactive' });
    });
    return true;
  }

  if (message.type === 'GET_MATCHES') {
    getStoredMatches().then((matches) => sendResponse({ matches }));
    return true; // async response
  }

  if (message.type === 'CLEAR_MATCHES') {
    chrome.storage.local.set({ [STORAGE_KEYS.MATCHES]: [] }, () => {
      sendResponse({ status: 'ok' });
    });
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    getSettings().then((settings) => sendResponse(settings));
    return true;
  }

  if (message.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: message.settings }, () => {
      sendResponse({ status: 'ok' });
    });
    return true;
  }

  if (message.type === 'SAVE_RESUME') {
    chrome.storage.local.set({ [STORAGE_KEYS.RESUME_TEXT]: message.text }, () => {
      sendResponse({ status: 'ok' });
    });
    return true;
  }

  if (message.type === 'GET_RESUME') {
    chrome.storage.local.get(STORAGE_KEYS.RESUME_TEXT, (data) => {
      sendResponse({ text: data[STORAGE_KEYS.RESUME_TEXT] || '' });
    });
    return true;
  }

  if (message.type === 'SAVE_THRESHOLD') {
    chrome.storage.local.set({ [STORAGE_KEYS.THRESHOLD]: message.threshold }, () => {
      sendResponse({ status: 'ok' });
    });
    return true;
  }

  if (message.type === 'SCORE_JOB') {
    scoreOneJob(message.job).then((result) => sendResponse(result));
    return true;
  }

  if (message.type === 'CHECK_LLM_STATUS') {
    checkLLMStatus(message.serverUrl).then((status) => sendResponse(status));
    return true;
  }

  if (message.type === 'GET_SEARCH_PROFILES') {
    getSearchProfiles().then((profiles) => sendResponse({ profiles }));
    return true;
  }

  if (message.type === 'SAVE_SEARCH_PROFILES') {
    saveSearchProfiles(message.profiles).then(() => {
      setupAlarms(message.profiles);
      sendResponse({ status: 'ok' });
    });
    return true;
  }

  if (message.type === 'RUN_SEARCH_NOW') {
    runScheduledScan(message.profileId).then((result) => sendResponse(result));
    return true;
  }

  if (message.type === 'GET_SCAN_STATUS') {
    getScanStatus().then((status) => sendResponse(status));
    return true;
  }

  if (message.type === 'RESCORE_ALL') {
    rescoreAllMatches().then((result) => sendResponse(result));
    return true;
  }

  if (message.type === 'DEBUG_DUMP') {
    (async () => {
      const resumeText = await getResumeText();
      const matches = await getStoredMatches();
      const { settings } = await getSettings();
      sendResponse({
        resumeLength: resumeText.length,
        matchCount: matches.length,
        matches: matches.map((m) => ({
          title: m.job?.title,
          company: m.job?.company,
          descLength: (m.job?.description || '').length,
          descPreview: (m.job?.description || '').substring(0, 100),
          url: m.job?.url,
          score: m.score,
          lexicalScore: m.lexicalScore,
          skillScore: m.skillScore,
          hasJobObject: !!m.job,
        })),
        weights: settings.weights,
      });
    })();
    return true;
  }
});

async function rescoreAllMatches() {
  try {
    const resumeText = await getResumeText();
    if (!resumeText) {
      console.warn('[JM Rescore] No resume text found');
      return { error: 'No resume uploaded — go to Resume tab and upload one' };
    }

    const { settings } = await getSettings();
    const matches = await getStoredMatches();
    if (matches.length === 0) {
      console.warn('[JM Rescore] No matches in storage');
      return { error: 'No matches to re-score' };
    }

    console.log(`[JM Rescore] Re-scoring ${matches.length} matches`);

    for (const match of matches) {
      if (match.job?.url) {
        match.job.url = normalizeJobUrl(match.job.url);
      }
    }

    // Score in one batch so IDF is built across the whole set, matching how
    // scan-time scoring works. Scoring each match on its own gave every job a
    // two-document corpus and a meaningless IDF.
    const results = JobMatcher.scoreBatch(
      resumeText,
      matches.map((m) => m.job || {}),
      { weights: settings.weights }
    );

    let updated = 0;
    results.forEach((result, i) => {
      const match = matches[i];
      if (!result.scoreable) {
        console.log(`[JM Rescore] Skipping "${match.job?.title}": ${result.reason}`);
        return;
      }

      match.localScore = result.score;
      match.lexicalScore = result.lexicalScore;
      match.skillScore = result.skillScore;
      match.matchedSkills = result.matchedSkills;
      match.missingSkills = result.missingSkills;

      // The local score changed, so any previously blended hybrid score is
      // stale. Re-blend against the retained LLM score rather than overwriting
      // `score` with the local value while leaving llmScore on the row — that
      // made the popup render "Local X% + LLM Y%" beside an unrelated third
      // number and silently discarded the LLM's contribution.
      if (match.llmScore != null) {
        match.score = blendHybridScore(result.score, match.llmScore, settings);
      } else {
        match.score = result.score;
      }

      updated++;
    });

    matches.sort((a, b) => (b.score || 0) - (a.score || 0));
    await saveMatches(matches);

    console.log(`[JM Rescore] Done — ${updated}/${matches.length} matches re-scored`);
    return { status: 'ok', updated };
  } catch (err) {
    console.error('[JM Rescore] Fatal error:', err);
    return { error: err.message || 'Unknown error during re-scoring' };
  }
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [STORAGE_KEYS.SETTINGS, STORAGE_KEYS.THRESHOLD],
      (data) => {
        const settings = { ...DEFAULTS.settings, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
        const threshold = data[STORAGE_KEYS.THRESHOLD] ?? DEFAULTS.threshold;
        resolve({ settings, threshold });
      }
    );
  });
}

async function getResumeText() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.RESUME_TEXT, (data) => {
      resolve(data[STORAGE_KEYS.RESUME_TEXT] || '');
    });
  });
}

async function getStoredMatches() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.MATCHES, (data) => {
      resolve(data[STORAGE_KEYS.MATCHES] || []);
    });
  });
}

/**
 * Full LinkedIn descriptions run 5-15KB each. Retaining them for 200 matches
 * can alone approach the 10MB storage.local quota, and nothing in the UI shows
 * more than an excerpt.
 */
const STORED_DESCRIPTION_CHARS = 1200;

function trimMatchForStorage(match) {
  const description = match.job?.description;
  if (!description || description.length <= STORED_DESCRIPTION_CHARS) return match;

  return {
    ...match,
    job: {
      ...match.job,
      description: description.slice(0, STORED_DESCRIPTION_CHARS),
      descriptionTruncated: true,
      descriptionLength: description.length,
    },
  };
}

/**
 * Persist matches, reporting quota failures instead of dropping them.
 *
 * Every storage.set in this file previously ignored chrome.runtime.lastError,
 * so exceeding the quota failed completely silently — matches simply stopped
 * being saved with no indication anywhere.
 */
async function saveMatches(matches) {
  const trimmed = matches.map(trimMatchForStorage);

  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEYS.MATCHES]: trimmed }, () => {
      const err = chrome.runtime.lastError;
      if (!err) return resolve({ ok: true });

      console.error(`[JM Storage] Failed to save ${trimmed.length} matches: ${err.message}`);

      // Most likely the quota. Retry with a smaller, description-free set so
      // the user keeps their matches rather than losing the write entirely.
      const minimal = trimmed.slice(0, 100).map((m) => ({
        ...m,
        job: { ...m.job, description: '' },
      }));

      chrome.storage.local.set({ [STORAGE_KEYS.MATCHES]: minimal }, () => {
        const retryErr = chrome.runtime.lastError;
        if (retryErr) {
          console.error(`[JM Storage] Retry also failed: ${retryErr.message}`);
          resolve({ ok: false, error: retryErr.message });
        } else {
          console.warn('[JM Storage] Saved a reduced match set after a quota failure');
          resolve({ ok: true, reduced: true });
        }
      });
    });
  });
}

/**
 * Single ingestion path for scored jobs, whatever found them.
 *
 * handleJobsFound and handleJobsFoundFromScan were ~90% identical, and the
 * copies had already drifted: only the interactive one honoured the platform
 * toggle. Worse, they were two of three concurrent read-modify-write paths on
 * the `matches` array — interactive content scripts post JOBS_FOUND on a 2s
 * interval from every open LinkedIn tab, so a scan running at the same time
 * could silently drop matches. All writes now go through one serialized queue.
 */
async function ingestJobs(jobs, source, { origin = 'interactive' } = {}) {
  const tag = origin === 'scan' ? '[JM Scan]' : '[JM Interactive]';

  const resumeText = await getResumeText();
  if (!resumeText) {
    console.warn(`${tag} No resume text — cannot score`);
    return 0;
  }

  const { settings, threshold } = await getSettings();

  if (!settings.platforms[source]) {
    console.log(`${tag} Platform "${source}" is disabled — discarding ${jobs.length} jobs`);
    return 0;
  }

  const jobsWithContent = jobs.filter((j) => {
    const hasDesc = j.description && j.description.length > 20;
    const hasMeta = j.title && j.title.length > 2;
    return hasDesc || hasMeta;
  });
  if (jobsWithContent.length === 0) return 0;

  // Score everything; `threshold` governs notifications, not storage.
  const results = JobMatcher.matchJobs(resumeText, jobsWithContent, 0, settings.weights);
  console.log(`${tag} scored ${results.length}/${jobsWithContent.length} jobs`);
  if (results.length === 0) return 0;

  // Everything from here mutates stored matches, so it runs inside the queue.
  return withMatchesLock(async () => {
    const existingMatches = await getStoredMatches();
    const existingByUrl = new Map(existingMatches.map((m) => [normalizeJobUrl(m.job.url), m]));

    let newMatches = [];
    let updatedCount = 0;

    for (const r of results) {
      const normUrl = normalizeJobUrl(r.job.url);
      const existing = existingByUrl.get(normUrl);
      if (existing) {
        existingByUrl.set(normUrl, {
          ...existing,
          score: r.score,
          lexicalScore: r.lexicalScore,
          skillScore: r.skillScore,
          matchedSkills: r.matchedSkills,
          missingSkills: r.missingSkills,
          job: { ...existing.job, ...r.job },
        });
        updatedCount++;
      } else {
        newMatches.push(r);
      }
    }

    if (newMatches.length > 0 && settings.llmEnabled && settings.serverUrl) {
      newMatches = await enhanceWithBackendScoring(newMatches, resumeText, settings);
    }

    const timestamped = newMatches.map((m) => ({
      ...m,
      matchedAt: new Date().toISOString(),
      ...(origin === 'scan' ? { fromScheduledScan: true } : {}),
    }));

    const allMatches = [...timestamped, ...existingByUrl.values()]
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, MAX_STORED_MATCHES);
    await saveMatches(allMatches);

    const notifiable = newMatches.filter((m) => m.score >= threshold);

    if (notifiable.length > 0 && settings.notificationsEnabled) {
      for (const match of notifiable.slice(0, NOTIFICATION_LIMIT)) {
        showNotification(match);
      }
      if (notifiable.length > NOTIFICATION_LIMIT) {
        showNotification({
          job: { title: `+${notifiable.length - NOTIFICATION_LIMIT} more matches found` },
          score: notifiable[notifiable.length - 1].score,
        });
      }
    }

    if (notifiable.length > 0 && settings.emailEnabled && settings.emailAddress) {
      queueEmailNotification(notifiable, settings);
    }

    if (newMatches.length > 0 && settings.serverUrl) {
      persistToServer(newMatches, settings.serverUrl);
    }

    const totalChanged = newMatches.length + updatedCount;
    if (totalChanged > 0) {
      chrome.action.setBadgeText({ text: String(totalChanged) });
      chrome.action.setBadgeBackgroundColor({ color: '#10B981' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10000);
    }

    return totalChanged;
  });
}

function handleJobsFound(jobs, source) {
  return ingestJobs(jobs, source, { origin: 'interactive' });
}

function handleJobsFoundFromScan(jobs, source) {
  return ingestJobs(jobs, source, { origin: 'scan' });
}

/** Single definition of how a local score and an LLM score combine. */
function blendHybridScore(localScore, llmScore, settings) {
  const llmWeight = settings.llmWeight ?? 0.3;
  return Math.round(((1 - llmWeight) * localScore + llmWeight * llmScore) * 100) / 100;
}

/** Stable identifier for a job within one batch. */
function jobKey(job, index) {
  return job && job.url ? normalizeJobUrl(job.url) : `idx-${index}`;
}

/**
 * Send matches to the backend's two-stage scorer.
 *
 * Stage 1 embeds every job and ranks it semantically; stage 2 has the LLM judge
 * the leaders and its score becomes the one displayed. Both run server-side, so
 * this replaces the old "blend 30% of an LLM score into the top 10" path.
 *
 * On any failure the local scores stand — but the rows are left labelled
 * `local`, so a locally-scored match is never presented as though a model had
 * judged it.
 */
async function enhanceWithBackendScoring(matches, resumeText, settings) {
  if (matches.length === 0) return matches;

  const payload = matches.map((m, i) => ({ ...m.job, id: jobKey(m.job, i) }));

  try {
    const res = await fetch(`${settings.serverUrl}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeText, jobs: payload }),
      signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`[JM Score] /api/score returned ${res.status}; keeping local scores`);
      return matches;
    }

    const data = await res.json();
    const byId = new Map((data.results || []).map((r) => [r.id, r]));

    const enhanced = matches.map((match, i) => {
      const result = byId.get(jobKey(match.job, i));
      if (!result || result.finalScore == null) return match;

      return {
        ...match,
        // The backend's judged score is the headline number; the local score is
        // kept so the popup can show where it came from.
        score: result.finalScore,
        localScore: match.score,
        semanticScore: result.stage1Score ?? null,
        llmScore: result.llmScore ?? null,
        llmRationale: result.rationale || null,
        llmKeyStrengths: result.keyStrengths || [],
        llmGaps: result.gaps || [],
        llmModel: result.model || null,
        scorer: result.scorer || 'embeddings',
      };
    });

    enhanced.sort((a, b) => b.score - a.score);
    return enhanced;
  } catch (err) {
    console.warn(`[JM Score] Backend scoring unavailable (${err.message}); keeping local scores`);
    return matches.map((m) => ({ ...m, scorer: 'local' }));
  }
}

async function checkLLMStatus(serverUrl) {
  try {
    const url = serverUrl || DEFAULTS.settings.serverUrl;
    const res = await fetch(`${url}/api/score/status`);
    if (!res.ok) return { available: false, error: `Server returned ${res.status}` };
    return await res.json();
  } catch {
    return { available: false, error: 'Backend server unreachable' };
  }
}

async function scoreOneJob(job) {
  const resumeText = await getResumeText();
  if (!resumeText) return { error: 'No resume uploaded' };
  const { settings } = await getSettings();
  return JobMatcher.scoreJob(resumeText, job, settings.weights);
}

/**
 * Notification id -> job URL, so a click opens the job it was actually about.
 * Kept in storage.session rather than memory because the service worker is
 * routinely evicted between showing a notification and the user clicking it.
 */
const NOTIF_URL_PREFIX = 'notif-url:';

function showNotification(match) {
  const category = JobMatcher.getScoreCategory(match.score);
  const icon = category === 'excellent' ? '🟢' : category === 'good' ? '🟡' : '🔴';

  const notifId = `match-${Date.now()}-${Math.random()}`;

  if (match.job.url) {
    chrome.storage.session.set({ [NOTIF_URL_PREFIX + notifId]: match.job.url });
  }

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: `${icon} Job Match: ${match.score}%`,
    message: `${match.job.title}${match.job.company ? ' at ' + match.job.company : ''}`,
    priority: category === 'excellent' ? 2 : 1,
  });
}

// Click a notification to open the job it refers to. This previously ignored
// notifId entirely and always opened matches[0] — whichever job happened to
// rank highest by the time the user clicked.
chrome.notifications.onClicked.addListener(async (notifId) => {
  const key = NOTIF_URL_PREFIX + notifId;
  const stored = await chrome.storage.session.get(key);
  const url = stored[key];

  if (url) {
    chrome.tabs.create({ url });
    chrome.storage.session.remove(key);
    return;
  }

  // Session storage was cleared (browser restart). Open the popup's match list
  // rather than guessing at a job.
  chrome.action.openPopup?.();
});

chrome.notifications.onClosed.addListener((notifId) => {
  chrome.storage.session.remove(NOTIF_URL_PREFIX + notifId);
});

async function queueEmailNotification(newMatches, settings) {
  const now = Date.now();
  const data = await new Promise((resolve) => {
    chrome.storage.local.get(
      [STORAGE_KEYS.LAST_EMAIL_TIME, STORAGE_KEYS.PENDING_EMAIL_MATCHES],
      resolve
    );
  });

  const lastEmailTime = data[STORAGE_KEYS.LAST_EMAIL_TIME] || 0;
  const pending = data[STORAGE_KEYS.PENDING_EMAIL_MATCHES] || [];

  // Store only what the digest email actually renders. This list previously
  // accumulated whole match objects — full job descriptions included — for as
  // long as the cooldown held, with no cap at all.
  const digestEntries = newMatches.map((m) => ({
    job: {
      title: m.job?.title,
      company: m.job?.company,
      url: m.job?.url,
    },
    score: m.score,
    matchedSkills: (m.matchedSkills || []).slice(0, 12),
    missingSkills: (m.missingSkills || []).slice(0, 12),
  }));

  const allPending = [...pending, ...digestEntries]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, PENDING_EMAIL_LIMIT);

  if (now - lastEmailTime >= EMAIL_COOLDOWN_MS) {
    sendEmailNotification(allPending, settings);
    setStorageChecked({
      [STORAGE_KEYS.LAST_EMAIL_TIME]: now,
      [STORAGE_KEYS.PENDING_EMAIL_MATCHES]: [],
    });
  } else {
    setStorageChecked({
      [STORAGE_KEYS.PENDING_EMAIL_MATCHES]: allPending,
    });
  }
}

/** storage.local.set that reports failures rather than swallowing them. */
function setStorageChecked(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => {
      const err = chrome.runtime.lastError;
      if (err) console.error(`[JM Storage] set(${Object.keys(items).join(', ')}) failed: ${err.message}`);
      resolve(!err);
    });
  });
}

async function sendEmailNotification(matches, settings) {
  if (!settings.serverUrl || matches.length === 0) return;

  try {
    await fetch(`${settings.serverUrl}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: settings.emailAddress,
        matches: matches.map((m) => ({
          title: m.job.title,
          company: m.job.company,
          url: m.job.url,
          score: m.score,
          matchedSkills: m.matchedSkills,
          missingSkills: m.missingSkills,
        })),
      }),
    });
  } catch (err) {
    console.error('Job Matcher: Failed to send email notification', err);
  }
}

async function persistToServer(matches, serverUrl) {
  try {
    await fetch(`${serverUrl}/api/matches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matches: matches.map((m) => ({
          jobTitle: m.job.title,
          company: m.job.company || '',
          url: m.job.url || '',
          score: m.score,
          platform: m.job.platform || '',
          // These were never sent, so the matched_skills / missing_skills
          // columns were permanently '[]' for every row in the database.
          matchedSkills: m.matchedSkills || [],
          missingSkills: m.missingSkills || [],
          matchedAt: m.matchedAt,
        })),
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    // The backend is optional; matches still live in extension storage.
    console.debug(`[JM Persist] Could not reach server: ${err.message}`);
  }
}

// ============================================================
// Scheduled Search Profiles
// ============================================================

async function getSearchProfiles() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.SEARCH_PROFILES, (data) => {
      resolve(data[STORAGE_KEYS.SEARCH_PROFILES] || []);
    });
  });
}

async function saveSearchProfiles(profiles) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEYS.SEARCH_PROFILES]: profiles }, resolve);
  });
}

async function getScanStatus() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.SCAN_STATUS, (data) => {
      resolve(data[STORAGE_KEYS.SCAN_STATUS] || {});
    });
  });
}

async function setScanStatus(profileId, status) {
  const current = await getScanStatus();
  current[profileId] = { ...status, updatedAt: new Date().toISOString() };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEYS.SCAN_STATUS]: current }, resolve);
  });
}

function buildLinkedInSearchUrl(profile, page = 0) {
  const params = new URLSearchParams();
  if (profile.keywords) params.set('keywords', profile.keywords);
  if (profile.location) params.set('location', profile.location);
  if (profile.workType && profile.workType !== 'any') {
    const code = WORK_TYPE_MAP[profile.workType];
    if (code) params.set('f_WT', code);
  }
  params.set('sortBy', 'DD');
  if (page > 0) params.set('start', String(page * RESULTS_PER_PAGE));
  // No _jm_scan marker: the tab's role is recorded in session storage against
  // its tab id, so the URLs we load look like ordinary LinkedIn searches.
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

/**
 * Rank cards before spending the enrichment budget on them.
 *
 * Enrichment is the expensive part of a scan — one page load each — and the
 * budget used to go to whatever LinkedIn happened to list first. Scoring the
 * card text (title plus whatever snippet we have) costs nothing and puts the
 * budget on the jobs most likely to be worth fetching in full.
 */
function prioritiseForEnrichment(cardJobs, resumeText, settings, limit) {
  const candidates = cardJobs.filter((j) => j.url && j.url.includes('/jobs/view/'));
  if (candidates.length === 0) return [];

  // Rank even when everything fits the budget: a scan can be cut short by the
  // watchdog or a closed tab, and the jobs most worth having should already be
  // fetched by then.
  const scored = JobMatcher.scoreBatch(resumeText, candidates, { weights: settings.weights });

  return candidates
    .map((job, i) => ({ job, score: scored[i].scoreable ? scored[i].score : 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.job);
}

// ============================================================
// Scan state
//
// These three maps used to live only in memory. A scheduled scan runs for
// minutes, and an MV3 service worker can be evicted at any point in that
// window — when it was, the in-flight scan's tab was orphaned, its promises
// never settled, and scanStatus stayed on 'scanning' forever with no way back
// except reinstalling. Coordination state now lives in chrome.storage.session
// so a fresh worker can find an interrupted scan and either resume or end it.
// ============================================================

const SESSION_KEYS = {
  SCAN_STATE: 'scanState',
  TAB_MODE_PREFIX: 'tabMode:',
};

const WATCHDOG_ALARM = 'scan-watchdog';
// A scan whose state has not advanced in this long is considered dead.
const SCAN_STALL_MS = 4 * 60 * 1000;

// In-memory promise resolvers. These are inherently per-worker — a promise
// cannot outlive the worker that created it — so they are treated as a fast
// path only, with storage.session holding the durable truth.
const pendingScanTabs = new Map();
const pendingEnrichTabs = new Map();
const scanTabToProfile = new Map();

async function getScanState() {
  const data = await chrome.storage.session.get(SESSION_KEYS.SCAN_STATE);
  return data[SESSION_KEYS.SCAN_STATE] || null;
}

async function setScanState(patch) {
  const current = (await getScanState()) || {};
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ [SESSION_KEYS.SCAN_STATE]: next });
  return next;
}

async function clearScanState() {
  await chrome.storage.session.remove(SESSION_KEYS.SCAN_STATE);
  await chrome.alarms.clear(WATCHDOG_ALARM);
}

/** Record what a tab is for, so its content script can ask. */
async function setTabMode(tabId, mode, profileId) {
  await chrome.storage.session.set({
    [SESSION_KEYS.TAB_MODE_PREFIX + tabId]: { mode, profileId },
  });
}

async function getTabMode(tabId) {
  const key = SESSION_KEYS.TAB_MODE_PREFIX + tabId;
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

async function clearTabMode(tabId) {
  await chrome.storage.session.remove(SESSION_KEYS.TAB_MODE_PREFIX + tabId);
}

/**
 * Only one scan may run at a time. Several profiles sharing an interval used to
 * fire together, each opening its own tab and all writing `matches`
 * concurrently.
 */
async function acquireScanLock(profileId) {
  const existing = await getScanState();

  if (existing && existing.phase !== 'done') {
    const age = Date.now() - (existing.updatedAt || 0);
    if (age < SCAN_STALL_MS) {
      return { ok: false, reason: `a scan for profile ${existing.profileId} is already running` };
    }
    // The holder is stale — reclaim it rather than deadlocking forever.
    console.warn(`[JM Scan] Reclaiming stale scan lock from profile ${existing.profileId}`);
    await finalizeInterruptedScan(existing, 'superseded by a new scan');
  }

  await setScanState({ profileId, phase: 'starting', startTime: Date.now() });
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  return { ok: true };
}

/** Close an interrupted scan's tab and leave its status in a terminal state. */
async function finalizeInterruptedScan(state, reason) {
  if (state.tabId != null) {
    try {
      await chrome.tabs.remove(state.tabId);
    } catch {
      // Tab already gone.
    }
    await clearTabMode(state.tabId);
  }

  if (state.profileId) {
    await setScanStatus(state.profileId, {
      state: 'error',
      error: `Scan interrupted (${reason})`,
      progress: 0,
      lastRun: new Date().toISOString(),
    });
  }

  await clearScanState();
}

/**
 * Called when the worker starts. If a scan was in flight when the previous
 * worker died, it cannot be resumed — its tab callbacks are gone — so clean up
 * and report it rather than leaving the UI spinning.
 */
async function recoverInterruptedScan() {
  const state = await getScanState();
  if (!state || state.phase === 'done') return;

  console.warn(`[JM Scan] Found an interrupted scan for profile ${state.profileId}; cleaning up`);
  await finalizeInterruptedScan(state, 'the extension worker restarted');
}

/** Clear per-tab mode records for tabs that no longer exist. */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearTabMode(tabId);

  const state = await getScanState();
  if (state && state.tabId === tabId && state.phase !== 'done') {
    console.warn('[JM Scan] Scan tab was closed; ending the scan');
    await finalizeInterruptedScan(state, 'the scan tab was closed');
  }
});

/** Randomised delay so navigation timing is not perfectly regular. */
function jitter(baseMs, spread = 0.35) {
  return Math.round(baseMs * (1 + (Math.random() * 2 - 1) * spread));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enrichJobWithDetail(tabId, job, profileId, index, total, startTime) {
  await setScanStatus(profileId, {
    state: 'scanning',
    step: 'enriching',
    detail: `Enriching job ${index + 1}/${total} — ${job.title || 'Untitled'}`,
    progress: 40 + Math.round(((index + 1) / total) * 50),
    startTime,
  });

  // Persist the cursor so an interrupted scan can be reported accurately.
  await setScanState({ phase: 'enriching', cursor: index, total });

  // Mark the tab before navigating: the content script asks for its mode as
  // soon as it runs, and the navigation must not carry a marker in its URL.
  await setTabMode(tabId, 'enrich', profileId);

  try {
    await chrome.tabs.update(tabId, { url: job.url });
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingEnrichTabs.delete(tabId);
      resolve(null);
    }, ENRICH_PAGE_TIMEOUT_MS);

    pendingEnrichTabs.set(tabId, { resolve, timeout });
  });
}

async function runScheduledScan(profileId) {
  const profiles = await getSearchProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return { error: 'Profile not found' };

  const lock = await acquireScanLock(profileId);
  if (!lock.ok) {
    console.log(`[JM Scan] Skipping profile ${profileId}: ${lock.reason}`);
    return { status: 'skipped', reason: lock.reason };
  }

  const startTime = Date.now();
  await setScanStatus(profileId, {
    state: 'scanning',
    step: 'opening',
    detail: 'Opening LinkedIn search',
    progress: 0,
    startTime,
  });

  const keepalive = setInterval(() => {
    chrome.storage.local.set({ _jm_keepalive: Date.now() });
    // Refresh the state timestamp so the watchdog can tell a slow scan from a
    // dead one.
    setScanState({ heartbeat: Date.now() });
  }, 20000);

  try {
    const tab = await chrome.tabs.create({
      url: buildLinkedInSearchUrl(profile, 0),
      active: false,
    });
    scanTabToProfile.set(tab.id, profileId);
    await setTabMode(tab.id, 'scan', profileId);
    await setScanState({ phase: 'collecting', tabId: tab.id });

    await setScanStatus(profileId, {
      state: 'scanning',
      step: 'loading',
      detail: 'Waiting for page to load',
      progress: 5,
      startTime,
    });

    // Phase 1: walk the result pages. Only page 1 was ever read before, so a
    // search with hundreds of hits contributed ~25 candidates.
    const cardJobs = [];
    const seenCardUrls = new Set();

    for (let page = 0; page < SEARCH_PAGES; page++) {
      if (page > 0) {
        await setScanStatus(profileId, {
          state: 'scanning',
          step: 'loading',
          detail: `Loading results page ${page + 1}/${SEARCH_PAGES}`,
          progress: 5 + Math.round((page / SEARCH_PAGES) * 30),
          startTime,
        });

        await sleep(jitter(2000));
        await setTabMode(tab.id, 'scan', profileId);
        try {
          await chrome.tabs.update(tab.id, { url: buildLinkedInSearchUrl(profile, page) });
        } catch {
          break; // Tab is gone; keep whatever we already collected.
        }
      }

      const pageJobs = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pendingScanTabs.delete(tab.id);
          resolve([]);
        }, SCAN_TIMEOUT_MS);

        pendingScanTabs.set(tab.id, { resolve, timeout });
      });

      let added = 0;
      for (const job of pageJobs) {
        const key = normalizeJobUrl(job.url) || `${job.title}|${job.company}`;
        if (seenCardUrls.has(key)) continue;
        seenCardUrls.add(key);
        cardJobs.push(job);
        added++;
      }

      console.log(`[JM Scan] Page ${page + 1}: ${pageJobs.length} cards, ${added} new`);
      await setScanState({ phase: 'collecting', page, collected: cardJobs.length });

      // A page that contributed nothing new means we have reached the end of
      // the useful results; stop rather than loading identical pages.
      if (added === 0) break;
    }

    scanTabToProfile.delete(tab.id);
    console.log(`[JM Scan] Phase 1 complete: ${cardJobs.length} unique card jobs`);

    if (cardJobs.length === 0) {
      try { await chrome.tabs.remove(tab.id); } catch {}
      await clearTabMode(tab.id);
      clearInterval(keepalive);
      chrome.storage.local.remove('_jm_keepalive');
      await clearScanState();
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      await setScanStatus(profileId, {
        state: 'idle',
        lastRun: new Date().toISOString(),
        jobsFound: 0,
        matchCount: 0,
        progress: 100,
        elapsed,
      });
      return { status: 'ok', jobsFound: 0, matchCount: 0, elapsed };
    }

    // Phase 2: enrich the most promising jobs by loading their detail pages.
    // Ranking first means the budget is spent on likely matches rather than on
    // whatever LinkedIn happened to list first.
    const resumeForRanking = await getResumeText();
    const { settings: rankSettings } = await getSettings();
    const toEnrich = resumeForRanking
      ? prioritiseForEnrichment(cardJobs, resumeForRanking, rankSettings, ENRICH_LIMIT)
      : cardJobs.filter((j) => j.url && j.url.includes('/jobs/view/')).slice(0, ENRICH_LIMIT);

    await setScanStatus(profileId, {
      state: 'scanning',
      step: 'enriching',
      detail: `Enriching 0/${toEnrich.length} jobs with full descriptions`,
      progress: 40,
      startTime,
    });

    const enrichedJobs = [...cardJobs];
    const enrichedUrls = new Set();
    let enrichedCount = 0;

    // Build a normalized-URL-to-index map for fast lookup
    const normUrlToIdx = new Map();
    for (let ei = 0; ei < enrichedJobs.length; ei++) {
      normUrlToIdx.set(normalizeJobUrl(enrichedJobs[ei].url), ei);
    }

    for (let i = 0; i < toEnrich.length; i++) {
      const cardJob = toEnrich[i];

      // Pause between detail-page loads. Fifteen back-to-back navigations at a
      // fixed cadence is a recognisable automation signature.
      if (i > 0) await sleep(jitter(1200));

      const detail = await enrichJobWithDetail(
        tab.id, cardJob, profileId, i, toEnrich.length, startTime
      );

      if (detail && detail.description && detail.description.length >= 10) {
        enrichedCount++;
        const normCardUrl = normalizeJobUrl(cardJob.url);
        enrichedUrls.add(normCardUrl);
        console.log(`[JM Scan] Enriched ${i + 1}/${toEnrich.length}: ${cardJob.title} (${detail.description.length} chars)`);
        const idx = normUrlToIdx.get(normCardUrl);
        if (idx !== undefined) {
          enrichedJobs[idx] = {
            ...enrichedJobs[idx],
            title: detail.title || enrichedJobs[idx].title,
            company: detail.company || enrichedJobs[idx].company,
            location: detail.location || enrichedJobs[idx].location,
            description: detail.description,
            url: detail.url || enrichedJobs[idx].url,
          };
        }
      }
    }

    try { await chrome.tabs.remove(tab.id); } catch {}
    await clearTabMode(tab.id);

    // Phase 3: score all jobs
    await setScanState({ phase: 'scoring', tabId: null });
    await setScanStatus(profileId, {
      state: 'scanning',
      step: 'scoring',
      detail: `Scoring ${enrichedJobs.length} jobs (${enrichedCount} with full descriptions)`,
      progress: 92,
      startTime,
    });

    const withDesc = enrichedJobs.filter((j) => j.description && j.description.length >= 10).length;
    console.log(`[JM Scan] Phase 3: scoring ${enrichedJobs.length} jobs (${withDesc} with descriptions, ${enrichedCount} enriched)`);
    const matchCount = await handleJobsFoundFromScan(enrichedJobs, 'linkedin');

    const freshProfiles = await getSearchProfiles();
    const idx = freshProfiles.findIndex((p) => p.id === profileId);
    if (idx !== -1) {
      freshProfiles[idx].lastRun = new Date().toISOString();
      freshProfiles[idx].resultCount = (freshProfiles[idx].resultCount || 0) + enrichedJobs.length;
      await saveSearchProfiles(freshProfiles);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    await setScanStatus(profileId, {
      state: 'idle',
      lastRun: new Date().toISOString(),
      jobsFound: enrichedJobs.length,
      enrichedCount,
      matchCount,
      progress: 100,
      elapsed,
    });

    clearInterval(keepalive);
    chrome.storage.local.remove('_jm_keepalive');
    await clearScanState();
    return { status: 'ok', jobsFound: enrichedJobs.length, enrichedCount, matchCount, elapsed };
  } catch (err) {
    clearInterval(keepalive);
    chrome.storage.local.remove('_jm_keepalive');

    // Release the tab and the lock, or the next scheduled scan is blocked
    // until the stall timeout expires.
    const state = await getScanState();
    if (state && state.tabId != null) {
      try { await chrome.tabs.remove(state.tabId); } catch {}
      await clearTabMode(state.tabId);
    }
    await clearScanState();

    await setScanStatus(profileId, { state: 'error', error: err.message, progress: 0 });
    return { error: err.message };
  }
}

// Handled inside the main onMessage listener above — see handleScanTabMessage()

function handleScanTabMessage(message, sender) {
  if (!sender.tab) return;
  const tabId = sender.tab.id;

  if (message.type === 'SCAN_PROGRESS' && scanTabToProfile.has(tabId)) {
    const profileId = scanTabToProfile.get(tabId);
    const progressPct = 5 + Math.round((message.pass / message.maxPasses) * 35);
    setScanStatus(profileId, {
      state: 'scanning',
      step: message.step,
      detail: message.detail,
      progress: Math.min(progressPct, 40),
      jobsSoFar: message.jobsSoFar,
    });
  }

  if (message.type === 'SCAN_JOBS_LIST' && pendingScanTabs.has(tabId)) {
    const pending = pendingScanTabs.get(tabId);
    pendingScanTabs.delete(tabId);
    clearTimeout(pending.timeout);
    pending.resolve(message.jobs || []);
  }

  if (message.type === 'JOBS_FOUND' && pendingScanTabs.has(tabId)) {
    const pending = pendingScanTabs.get(tabId);
    pendingScanTabs.delete(tabId);
    clearTimeout(pending.timeout);
    pending.resolve(message.jobs || []);
  }

  if (message.type === 'SCAN_JOB_DETAIL' && pendingEnrichTabs.has(tabId)) {
    const pending = pendingEnrichTabs.get(tabId);
    pendingEnrichTabs.delete(tabId);
    clearTimeout(pending.timeout);
    pending.resolve(message.job || null);
  }
}

// ============================================================
// Chrome Alarms — Scheduling
// ============================================================

/**
 * Reconcile alarms against the enabled profiles.
 *
 * This used to clear every alarm and recreate it with
 * `delayInMinutes === periodInMinutes` on every single worker wake-up. Because
 * the worker wakes constantly, each wake pushed the next run a full period into
 * the future — a profile on a 24-hour interval could go indefinitely without
 * ever firing. Existing alarms are now left alone, and only missing or
 * out-of-date ones are (re)created.
 */
async function setupAlarms(profiles) {
  if (!profiles) profiles = await getSearchProfiles();

  const existing = await chrome.alarms.getAll();
  const byName = new Map(existing.map((a) => [a.name, a]));
  const wanted = new Set();

  for (const profile of profiles) {
    if (!profile.enabled) continue;

    const name = ALARM_PREFIX + profile.id;
    const periodInMinutes = Math.max(profile.interval || 60, 15);
    wanted.add(name);

    const current = byName.get(name);
    if (current && current.periodInMinutes === periodInMinutes) {
      continue; // Already scheduled correctly — leave its next run intact.
    }

    // A newly enabled or rescheduled profile runs shortly, not a full period
    // from now.
    await chrome.alarms.create(name, {
      delayInMinutes: current ? periodInMinutes : 1,
      periodInMinutes,
    });
  }

  // Drop alarms for profiles that were deleted or disabled.
  for (const alarm of existing) {
    if (alarm.name.startsWith(ALARM_PREFIX) && !wanted.has(alarm.name)) {
      await chrome.alarms.clear(alarm.name);
    }
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === WATCHDOG_ALARM) {
    return watchdogTick();
  }

  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const profileId = alarm.name.slice(ALARM_PREFIX.length);
  await runScheduledScan(profileId);
});

/**
 * Fires once a minute while a scan is in flight. If the state has not advanced
 * within SCAN_STALL_MS the scan is dead — most likely its worker was evicted
 * mid-flight — so tear it down instead of leaving the UI stuck on "scanning".
 */
async function watchdogTick() {
  const state = await getScanState();
  if (!state || state.phase === 'done') {
    await chrome.alarms.clear(WATCHDOG_ALARM);
    return;
  }

  const age = Date.now() - Math.max(state.updatedAt || 0, state.heartbeat || 0);
  if (age < SCAN_STALL_MS) return;

  console.warn(
    `[JM Scan] Watchdog: no progress for ${Math.round(age / 1000)}s in phase "${state.phase}"`
  );
  await finalizeInterruptedScan(state, 'it stopped responding');
}

// A fresh worker must reconcile alarms and clean up anything the previous one
// left behind mid-scan.
chrome.runtime.onStartup.addListener(async () => {
  await recoverInterruptedScan();
  await setupAlarms();
});

chrome.runtime.onInstalled.addListener(async () => {
  await recoverInterruptedScan();
  await setupAlarms();
});

// Also runs on ordinary worker wake-ups, which is when an interrupted scan is
// most likely to be discovered.
recoverInterruptedScan();
setupAlarms();
