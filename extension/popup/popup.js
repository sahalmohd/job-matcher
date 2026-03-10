document.addEventListener('DOMContentLoaded', init);

function init() {
  setupTabs();
  setupResume();
  setupSettings();
  loadMatches();
  loadSettings();
  loadResume();
}

// --- Tab Navigation ---

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

// --- Matches Dashboard ---

function loadMatches() {
  chrome.runtime.sendMessage({ type: 'GET_MATCHES' }, (response) => {
    if (chrome.runtime.lastError) return;
    renderMatches(response?.matches || []);
  });
}

function renderMatches(matches) {
  const list = document.getElementById('matchesList');
  const countEl = document.getElementById('matchCount');
  const emptyEl = document.getElementById('emptyState');

  countEl.textContent = `${matches.length} match${matches.length !== 1 ? 'es' : ''}`;

  if (matches.length === 0) {
    list.innerHTML = '';
    list.appendChild(emptyEl);
    emptyEl.style.display = 'flex';
    return;
  }

  emptyEl.style.display = 'none';
  list.innerHTML = '';

  for (const match of matches) {
    const card = createMatchCard(match);
    list.appendChild(card);
  }
}

function createMatchCard(match) {
  const card = document.createElement('div');
  card.className = 'match-card';
  card.addEventListener('click', () => {
    if (match.job.url) {
      chrome.tabs.create({ url: match.job.url });
    }
  });

  const category = getScoreCategory(match.score);
  const timeAgo = formatTimeAgo(match.matchedAt);

  const matchedTags = (match.matchedSkills || [])
    .slice(0, 5)
    .map((s) => `<span class="skill-tag skill-matched">${escapeHtml(s)}</span>`)
    .join('');

  const missingTags = (match.missingSkills || [])
    .slice(0, 3)
    .map((s) => `<span class="skill-tag skill-missing">${escapeHtml(s)}</span>`)
    .join('');

  card.innerHTML = `
    <div class="match-card-header">
      <span class="match-title">${escapeHtml(match.job.title || 'Untitled')}</span>
      <span class="match-score score-${category}">${match.score}%</span>
    </div>
    <div class="match-company">${escapeHtml(match.job.company || 'Unknown Company')}${match.job.location ? ' · ' + escapeHtml(match.job.location) : ''}</div>
    ${matchedTags || missingTags ? `<div class="match-skills">${matchedTags}${missingTags}</div>` : ''}
    <div class="match-meta">
      <span class="platform-badge">${escapeHtml(match.job.platform || 'unknown')}</span>
      <span>${timeAgo}</span>
    </div>
  `;

  return card;
}

document.getElementById('clearMatches').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_MATCHES' }, () => {
    loadMatches();
  });
});

// --- Resume Upload ---

function setupResume() {
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');
  const textarea = document.getElementById('resumeText');
  const saveBtn = document.getElementById('saveResume');
  const clearBtn = document.getElementById('clearResume');

  uploadArea.addEventListener('click', () => fileInput.click());

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  saveBtn.addEventListener('click', () => {
    const text = textarea.value.trim();
    if (!text) {
      showResumeStatus('Please upload a file or paste text', 'error');
      return;
    }
    saveResumeText(text);
  });

  clearBtn.addEventListener('click', () => {
    textarea.value = '';
    chrome.runtime.sendMessage({ type: 'SAVE_RESUME', text: '' }, () => {
      showResumeStatus('Resume cleared', 'success');
      updateStatus('');
    });
  });
}

async function handleFile(file) {
  const statusEl = document.getElementById('resumeStatus');
  const textarea = document.getElementById('resumeText');

  try {
    showResumeStatus('Parsing...', 'success');
    const text = await ResumeParser.parse(file);
    textarea.value = text;
    saveResumeText(text);
  } catch (err) {
    showResumeStatus(`Error: ${err.message}`, 'error');
  }
}

function saveResumeText(text) {
  chrome.runtime.sendMessage({ type: 'SAVE_RESUME', text }, () => {
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    showResumeStatus(`Resume saved (${wordCount} words)`, 'success');
    updateStatus('Resume loaded');
  });
}

function loadResume() {
  chrome.runtime.sendMessage({ type: 'GET_RESUME' }, (response) => {
    if (chrome.runtime.lastError) return;
    const text = response?.text || '';
    document.getElementById('resumeText').value = text;
    if (text) {
      updateStatus('Resume loaded');
    }
  });
}

function showResumeStatus(msg, type) {
  const el = document.getElementById('resumeStatus');
  el.textContent = msg;
  el.className = `resume-status ${type}`;
}

// --- Settings ---

function setupSettings() {
  const thresholdSlider = document.getElementById('thresholdSlider');
  const thresholdValue = document.getElementById('thresholdValue');
  const tfidfWeight = document.getElementById('tfidfWeight');
  const skillWeight = document.getElementById('skillWeight');
  const tfidfWeightValue = document.getElementById('tfidfWeightValue');
  const skillWeightValue = document.getElementById('skillWeightValue');
  const emailToggle = document.getElementById('emailEnabled');
  const emailConfig = document.getElementById('emailConfig');

  thresholdSlider.addEventListener('input', () => {
    thresholdValue.textContent = thresholdSlider.value;
  });

  tfidfWeight.addEventListener('input', () => {
    const val = parseInt(tfidfWeight.value);
    skillWeight.value = 100 - val;
    tfidfWeightValue.textContent = `${val}%`;
    skillWeightValue.textContent = `${100 - val}%`;
  });

  skillWeight.addEventListener('input', () => {
    const val = parseInt(skillWeight.value);
    tfidfWeight.value = 100 - val;
    skillWeightValue.textContent = `${val}%`;
    tfidfWeightValue.textContent = `${100 - val}%`;
  });

  emailToggle.addEventListener('change', () => {
    emailConfig.style.display = emailToggle.checked ? 'flex' : 'none';
  });

  document.getElementById('saveSettings').addEventListener('click', saveSettings);
}

function loadSettings() {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
    if (chrome.runtime.lastError || !response) return;

    const { settings, threshold } = response;

    document.getElementById('thresholdSlider').value = threshold;
    document.getElementById('thresholdValue').textContent = threshold;

    const tfidfPct = Math.round((settings.weights?.tfidf || 0.6) * 100);
    document.getElementById('tfidfWeight').value = tfidfPct;
    document.getElementById('tfidfWeightValue').textContent = `${tfidfPct}%`;
    document.getElementById('skillWeight').value = 100 - tfidfPct;
    document.getElementById('skillWeightValue').textContent = `${100 - tfidfPct}%`;

    document.getElementById('platformLinkedin').checked = settings.platforms?.linkedin !== false;
    document.getElementById('platformIndeed').checked = settings.platforms?.indeed !== false;
    document.getElementById('platformGlassdoor').checked = settings.platforms?.glassdoor !== false;

    document.getElementById('notificationsEnabled').checked = settings.notificationsEnabled !== false;
    document.getElementById('emailEnabled').checked = settings.emailEnabled === true;
    document.getElementById('emailAddress').value = settings.emailAddress || '';
    document.getElementById('serverUrl').value = settings.serverUrl || 'http://localhost:3456';

    if (settings.emailEnabled) {
      document.getElementById('emailConfig').style.display = 'flex';
    }
  });
}

function saveSettings() {
  const tfidfPct = parseInt(document.getElementById('tfidfWeight').value);
  const threshold = parseInt(document.getElementById('thresholdSlider').value);

  const settings = {
    notificationsEnabled: document.getElementById('notificationsEnabled').checked,
    emailEnabled: document.getElementById('emailEnabled').checked,
    emailAddress: document.getElementById('emailAddress').value.trim(),
    serverUrl: document.getElementById('serverUrl').value.trim(),
    platforms: {
      linkedin: document.getElementById('platformLinkedin').checked,
      indeed: document.getElementById('platformIndeed').checked,
      glassdoor: document.getElementById('platformGlassdoor').checked,
    },
    weights: {
      tfidf: tfidfPct / 100,
      skills: (100 - tfidfPct) / 100,
    },
  };

  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  chrome.runtime.sendMessage({ type: 'SAVE_THRESHOLD', threshold });

  const btn = document.getElementById('saveSettings');
  btn.textContent = 'Saved!';
  btn.style.background = '#10B981';
  setTimeout(() => {
    btn.textContent = 'Save Settings';
    btn.style.background = '';
  }, 1500);
}

// --- Helpers ---

function updateStatus(text) {
  document.getElementById('status').textContent = text;
}

function getScoreCategory(score) {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  return 'low';
}

function formatTimeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
