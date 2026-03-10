importScripts('lib/tfidf.js', 'lib/matcher.js');

const STORAGE_KEYS = {
  RESUME_TEXT: 'resumeText',
  THRESHOLD: 'threshold',
  MATCHES: 'matches',
  SETTINGS: 'settings',
  LAST_EMAIL_TIME: 'lastEmailTime',
  PENDING_EMAIL_MATCHES: 'pendingEmailMatches',
};

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
