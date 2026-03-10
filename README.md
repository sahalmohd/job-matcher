# Job Matcher

A Chrome extension that automatically scores job listings against your resume using local NLP. Browse LinkedIn, Indeed, or Glassdoor and get real-time match scores with browser and email notifications.

## Features

- **Resume parsing** — Upload PDF, DOCX, or paste plain text
- **Smart scoring** — TF-IDF cosine similarity + skill keyword matching (configurable weights)
- **Multi-platform** — Extracts jobs from LinkedIn, Indeed, and Glassdoor
- **Configurable threshold** — Set your minimum match score (0–100)
- **Chrome notifications** — Instant alerts when high-scoring jobs are found
- **Email notifications** — Digest emails via self-hosted backend (rate-limited to 1 per 30 min)
- **Match history** — Persistent storage with backend API
- **Privacy-first** — All matching runs locally in your browser; resume never leaves your machine

## Architecture

```
Chrome Extension (Manifest V3)
├── Content Scripts     → Extract jobs from LinkedIn / Indeed / Glassdoor
├── Background Worker   → Orchestrate matching, notifications
├── Popup UI            → Dashboard, resume upload, settings
└── Local NLP Engine    → TF-IDF + skill matching (pure JS, no API calls)

Backend Server (optional)
├── Express + SQLite    → Match history persistence
└── Nodemailer          → Email notification delivery
```

## Quick Start

### 1. Install the Extension

```bash
# Clone the repo
git clone https://github.com/<your-username>/job-matcher.git
cd job-matcher
```

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the **`extension/`** subfolder (not the project root!)
   - Path: `job-matcher/extension/`
4. The Job Matcher icon appears in your toolbar

### 2. Upload Your Resume

1. Click the Job Matcher extension icon
2. Go to the **Resume** tab
3. Upload a PDF/DOCX file or paste your resume text
4. Click **Save Resume**

### 3. Browse Jobs

Navigate to any of these sites:
- [LinkedIn Jobs](https://www.linkedin.com/jobs/)
- [Indeed](https://www.indeed.com/)
- [Glassdoor](https://www.glassdoor.com/)

The extension automatically extracts job listings and scores them against your resume. Matches above your threshold trigger notifications.

### 4. (Optional) Start the Backend Server

Required only for email notifications and persistent match history.

```bash
cd server
npm install
```

Configure SMTP for email (create a `.env` file or set environment variables):

```bash
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_USER=your@gmail.com
export SMTP_PASS=your-app-password
```

> For Gmail, use an [App Password](https://support.google.com/accounts/answer/185833) (not your regular password).

Start the server:

```bash
npm start
```

The server runs on `http://localhost:3456` by default.

## Scoring Algorithm

Each job is scored on a 0–100 scale using two components:

| Component | Weight | Method |
|-----------|--------|--------|
| **TF-IDF Similarity** | 60% | Cosine similarity between resume and job description TF-IDF vectors |
| **Skill Match** | 40% | Ratio of your resume skills found in the job posting |

Weights are configurable in the Settings tab.

### Score Categories

| Score | Category | Color |
|-------|----------|-------|
| 80–100 | Excellent | Green |
| 60–79 | Good | Yellow |
| 40–59 | Fair | Blue |
| 0–39 | Low | Red |

## Configuration

All settings are available in the extension popup under the **Settings** tab:

| Setting | Default | Description |
|---------|---------|-------------|
| Score Threshold | 70 | Minimum score to trigger notifications |
| TF-IDF Weight | 60% | Weight for text similarity scoring |
| Skill Weight | 40% | Weight for skill keyword matching |
| Browser Notifications | On | Chrome push notifications for matches |
| Email Notifications | Off | Email alerts (requires backend server) |
| Platforms | All enabled | Toggle LinkedIn, Indeed, Glassdoor |

## API Endpoints

The backend server exposes:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server health check |
| `GET` | `/api/matches` | Retrieve match history (supports `?limit`, `?offset`, `?minScore`, `?platform`) |
| `POST` | `/api/matches` | Store new matches |
| `DELETE` | `/api/matches` | Clear all match history |
| `POST` | `/api/notify` | Send email notification |

## Project Structure

```
job-matcher/
├── extension/
│   ├── manifest.json          # Chrome extension manifest (V3)
│   ├── background.js          # Service worker (matching orchestration)
│   ├── content-scripts/
│   │   ├── linkedin.js        # LinkedIn job extractor
│   │   ├── indeed.js          # Indeed job extractor
│   │   └── glassdoor.js       # Glassdoor job extractor
│   ├── popup/
│   │   ├── popup.html         # Extension popup UI
│   │   ├── popup.css          # Styles (dark theme)
│   │   └── popup.js           # Popup logic
│   ├── options/
│   │   ├── options.html       # Full options page
│   │   └── options.js         # Options logic
│   ├── lib/
│   │   ├── tfidf.js           # TF-IDF vectorizer + cosine similarity
│   │   ├── matcher.js         # Job scoring engine
│   │   └── parser.js          # Resume file parser (PDF/DOCX/text)
│   └── icons/
│       ├── icon-16.png
│       ├── icon-48.png
│       └── icon-128.png
├── server/
│   ├── index.js               # Express server entry point
│   ├── db.js                  # SQLite database layer
│   ├── email.js               # Nodemailer email service
│   ├── package.json
│   └── routes/
│       ├── matches.js         # Match CRUD endpoints
│       └── notify.js          # Email notification endpoint
└── README.md
```

## Tech Stack

- **Extension**: Manifest V3, vanilla JavaScript, Chrome Storage API
- **NLP**: Pure JS TF-IDF with cosine similarity (zero external dependencies)
- **Backend**: Node.js, Express, better-sqlite3, Nodemailer
- **UI**: Custom dark theme, responsive popup design

## License

MIT
