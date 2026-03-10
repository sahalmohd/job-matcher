importScripts('lib/tfidf.js', 'lib/matcher.js');

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
const SCAN_TAB_MARKER = '_jm_scan=1';
const SCAN_TIMEOUT_MS = 20000;
const WORK_TYPE_MAP = { remote: '2', onsite: '1', hybrid: '3' };

const DEFAULTS = {
  threshold: 50,
  settings: {
    notificationsEnabled: true,
    emailEnabled: false,
    emailAddress: '',
    serverUrl: 'http://localhost:3456',
    platforms: { linkedin: true, indeed: true, glassdoor: true },
    weights: { tfidf: 0.6, skills: 0.4 },
  },
};

const EMAIL_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// Listen for jobs from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'JOBS_FOUND') {
    // Skip if this is from a scheduled scan tab — handleJobsFoundFromScan handles those
    if (sender.tab && pendingScanTabs.has(sender.tab.id)) {
      sendResponse({ status: 'ok' });
      return;
    }
    handleJobsFound(message.jobs, message.source).then(() => {
      sendResponse({ status: 'ok' });
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
});

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

async function saveMatches(matches) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEYS.MATCHES]: matches }, resolve);
  });
}

async function handleJobsFound(jobs, source) {
  const resumeText = await getResumeText();
  if (!resumeText) return; // No resume uploaded yet

  const { settings, threshold } = await getSettings();

  if (!settings.platforms[source]) return; // Platform disabled

  const jobsWithContent = jobs.filter((j) => {
    const hasDesc = j.description && j.description.length > 20;
    const hasMeta = j.title && j.title.length > 2;
    return hasDesc || hasMeta;
  });
  if (jobsWithContent.length === 0) return;

  const results = JobMatcher.matchJobs(resumeText, jobsWithContent, threshold, settings.weights);
  if (results.length === 0) return;

  const existingMatches = await getStoredMatches();
  const existingUrls = new Set(existingMatches.map((m) => m.job.url));

  const newMatches = results.filter((r) => !existingUrls.has(r.job.url));
  if (newMatches.length === 0) return;

  const timestamped = newMatches.map((m) => ({
    ...m,
    matchedAt: new Date().toISOString(),
  }));

  const allMatches = [...timestamped, ...existingMatches].slice(0, 200); // Cap at 200
  await saveMatches(allMatches);

  // Chrome notifications
  if (settings.notificationsEnabled) {
    for (const match of newMatches.slice(0, 5)) {
      showNotification(match);
    }
    if (newMatches.length > 5) {
      showNotification({
        job: { title: `+${newMatches.length - 5} more matches found` },
        score: newMatches[newMatches.length - 1].score,
      });
    }
  }

  // Email notifications (batched with cooldown)
  if (settings.emailEnabled && settings.emailAddress) {
    queueEmailNotification(newMatches, settings);
  }

  // Persist to backend server if configured
  if (settings.serverUrl) {
    persistToServer(newMatches, settings.serverUrl);
  }

  // Update badge
  chrome.action.setBadgeText({ text: String(newMatches.length) });
  chrome.action.setBadgeBackgroundColor({ color: '#10B981' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10000);
}

async function scoreOneJob(job) {
  const resumeText = await getResumeText();
  if (!resumeText) return { error: 'No resume uploaded' };
  const { settings } = await getSettings();
  return JobMatcher.scoreJob(resumeText, job, settings.weights);
}

function showNotification(match) {
  const category = JobMatcher.getScoreCategory(match.score);
  const icon = category === 'excellent' ? '🟢' : category === 'good' ? '🟡' : '🔴';

  chrome.notifications.create(`match-${Date.now()}-${Math.random()}`, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: `${icon} Job Match: ${match.score}%`,
    message: `${match.job.title}${match.job.company ? ' at ' + match.job.company : ''}`,
    priority: category === 'excellent' ? 2 : 1,
  });
}

// Click notification to open the job URL
chrome.notifications.onClicked.addListener(async (notifId) => {
  const matches = await getStoredMatches();
  if (matches.length > 0 && matches[0].job.url) {
    chrome.tabs.create({ url: matches[0].job.url });
  }
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

  const allPending = [...pending, ...newMatches];

  if (now - lastEmailTime >= EMAIL_COOLDOWN_MS) {
    sendEmailNotification(allPending, settings);
    chrome.storage.local.set({
      [STORAGE_KEYS.LAST_EMAIL_TIME]: now,
      [STORAGE_KEYS.PENDING_EMAIL_MATCHES]: [],
    });
  } else {
    chrome.storage.local.set({
      [STORAGE_KEYS.PENDING_EMAIL_MATCHES]: allPending,
    });
  }
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
          matchedAt: m.matchedAt,
        })),
      }),
    });
  } catch {
    // Server may not be running — fail silently
  }
}

/**
 * Variant of handleJobsFound specifically for scheduled scans.
 * Uses a lower threshold for jobs lacking full descriptions (card-only results),
 * and returns the number of matches saved.
 */
async function handleJobsFoundFromScan(jobs, source) {
  const resumeText = await getResumeText();
  if (!resumeText) return 0;

  const { settings, threshold } = await getSettings();

  const jobsWithContent = jobs.filter((j) => {
    const hasDesc = j.description && j.description.length > 20;
    const hasMeta = j.title && j.title.length > 2;
    return hasDesc || hasMeta;
  });
  if (jobsWithContent.length === 0) return 0;

  // For jobs with only title/company (no full description), use a much lower
  // threshold since TF-IDF on short text produces low scores. We include all
  // of them (threshold 0) and let the user see scores in the dashboard.
  const scanThreshold = 0;
  const results = JobMatcher.matchJobs(resumeText, jobsWithContent, scanThreshold, settings.weights);
  if (results.length === 0) return 0;

  const existingMatches = await getStoredMatches();
  const existingUrls = new Set(existingMatches.map((m) => m.job.url));

  const newMatches = results.filter((r) => !existingUrls.has(r.job.url));
  if (newMatches.length === 0) return 0;

  const timestamped = newMatches.map((m) => ({
    ...m,
    matchedAt: new Date().toISOString(),
    fromScheduledScan: true,
  }));

  const allMatches = [...timestamped, ...existingMatches].slice(0, 200);
  await saveMatches(allMatches);

  // Notifications only for jobs above the user's configured threshold
  const notifiable = newMatches.filter((m) => m.score >= threshold);
  if (settings.notificationsEnabled && notifiable.length > 0) {
    for (const match of notifiable.slice(0, 5)) {
      showNotification(match);
    }
    if (notifiable.length > 5) {
      showNotification({
        job: { title: `+${notifiable.length - 5} more matches found` },
        score: notifiable[notifiable.length - 1].score,
      });
    }
  }

  if (settings.emailEnabled && settings.emailAddress) {
    const emailWorthy = newMatches.filter((m) => m.score >= threshold);
    if (emailWorthy.length > 0) {
      queueEmailNotification(emailWorthy, settings);
    }
  }

  if (settings.serverUrl) {
    persistToServer(newMatches, settings.serverUrl);
  }

  chrome.action.setBadgeText({ text: String(newMatches.length) });
  chrome.action.setBadgeBackgroundColor({ color: '#10B981' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10000);

  return newMatches.length;
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

function buildLinkedInSearchUrl(profile) {
  const params = new URLSearchParams();
  if (profile.keywords) params.set('keywords', profile.keywords);
  if (profile.location) params.set('location', profile.location);
  if (profile.workType && profile.workType !== 'any') {
    const code = WORK_TYPE_MAP[profile.workType];
    if (code) params.set('f_WT', code);
  }
  params.set('sortBy', 'DD');
  params.set(SCAN_TAB_MARKER.split('=')[0], '1');
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

// Track pending scan-tab resolutions so the content script response can resolve them
const pendingScanTabs = new Map();

// Maps tab ID -> profile ID so we can route progress messages
const scanTabToProfile = new Map();

async function runScheduledScan(profileId) {
  const profiles = await getSearchProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return { error: 'Profile not found' };

  const startTime = Date.now();
  await setScanStatus(profileId, {
    state: 'scanning',
    step: 'opening',
    detail: 'Opening LinkedIn search',
    progress: 0,
    startTime,
  });

  const url = buildLinkedInSearchUrl(profile);

  try {
    const tab = await chrome.tabs.create({ url, active: false });
    scanTabToProfile.set(tab.id, profileId);

    await setScanStatus(profileId, {
      state: 'scanning',
      step: 'loading',
      detail: 'Waiting for page to load',
      progress: 10,
      startTime,
    });

    const jobs = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingScanTabs.delete(tab.id);
        scanTabToProfile.delete(tab.id);
        resolve([]);
      }, SCAN_TIMEOUT_MS);

      pendingScanTabs.set(tab.id, { resolve, timeout });
    });

    scanTabToProfile.delete(tab.id);

    await setScanStatus(profileId, {
      state: 'scanning',
      step: 'scoring',
      detail: `Scoring ${jobs.length} jobs against resume`,
      progress: 85,
      startTime,
    });

    try { await chrome.tabs.remove(tab.id); } catch {}

    // Explicitly run scraped jobs through the matching pipeline
    const matchCount = await handleJobsFoundFromScan(jobs, 'linkedin');

    const freshProfiles = await getSearchProfiles();
    const idx = freshProfiles.findIndex((p) => p.id === profileId);
    if (idx !== -1) {
      freshProfiles[idx].lastRun = new Date().toISOString();
      freshProfiles[idx].resultCount = (freshProfiles[idx].resultCount || 0) + jobs.length;
      await saveSearchProfiles(freshProfiles);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    await setScanStatus(profileId, {
      state: 'idle',
      lastRun: new Date().toISOString(),
      jobsFound: jobs.length,
      matchCount,
      progress: 100,
      elapsed,
    });

    return { status: 'ok', jobsFound: jobs.length, matchCount, elapsed };
  } catch (err) {
    await setScanStatus(profileId, { state: 'error', error: err.message, progress: 0 });
    return { error: err.message };
  }
}

// Intercept messages from scan tabs for progress and job results
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab) return;
  const tabId = sender.tab.id;

  // Route progress updates to the correct profile's scan status
  if (message.type === 'SCAN_PROGRESS' && scanTabToProfile.has(tabId)) {
    const profileId = scanTabToProfile.get(tabId);
    const progressPct = 10 + Math.round((message.pass / message.maxPasses) * 75);
    setScanStatus(profileId, {
      state: 'scanning',
      step: message.step,
      detail: message.detail,
      progress: Math.min(progressPct, 85),
      jobsSoFar: message.jobsSoFar,
    });
  }

  // Resolve the pending promise when jobs arrive from scan tab
  if (message.type === 'JOBS_FOUND' && pendingScanTabs.has(tabId)) {
    const pending = pendingScanTabs.get(tabId);
    pendingScanTabs.delete(tabId);
    clearTimeout(pending.timeout);
    pending.resolve(message.jobs || []);
  }
});

// ============================================================
// Chrome Alarms — Scheduling
// ============================================================

async function setupAlarms(profiles) {
  // Clear all existing search alarms
  const allAlarms = await chrome.alarms.getAll();
  for (const alarm of allAlarms) {
    if (alarm.name.startsWith(ALARM_PREFIX)) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  // Create alarms for enabled profiles
  if (!profiles) profiles = await getSearchProfiles();
  for (const profile of profiles) {
    if (profile.enabled) {
      const periodInMinutes = Math.max(profile.interval || 60, 15);
      chrome.alarms.create(ALARM_PREFIX + profile.id, {
        delayInMinutes: periodInMinutes,
        periodInMinutes,
      });
    }
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const profileId = alarm.name.slice(ALARM_PREFIX.length);
  await runScheduledScan(profileId);
});

// Re-setup alarms on service worker startup
setupAlarms();
