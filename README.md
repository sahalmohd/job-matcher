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

| Score | Category |
|-------|----------|
| 75–100 | Excellent |
| 55–74 | Good |
| 35–54 | Fair |
| 0–34 | Low |

A job whose description could not be fetched is reported as **unknown**, not as
a 0% match — the two mean different things.

## Configuration

All settings are available in the extension popup under the **Settings** tab:

| Setting | Default | Description |
|---------|---------|-------------|
| Score Threshold | 50 | Minimum score to trigger notifications |
| Text Similarity Weight | 55% | Weight for the lexical similarity component |
| Skill Weight | 45% | Weight for skill keyword matching |
| Hybrid LLM Scoring | Off | Use the local Ollama two-stage scorer (needs the backend) |
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
| `POST` | `/api/score` | **Two-stage scoring**: embedding similarity for every job, then an LLM judgement on the top N. Pass `stage2: false` for embeddings only. |
| `GET` | `/api/score/status` | Ollama reachability and whether both models are pulled |
| `POST` | `/api/llm/score` | Judge a single job with the LLM |
| `POST` | `/api/llm/score-batch` | Judge up to 10 jobs |
| `GET` | `/api/llm/status` | Chat-model health |

CORS is restricted to `chrome-extension://` origins. If you need to allow
another origin, set `JM_ALLOWED_ORIGINS` to a comma-separated list.

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
│   │   ├── vocab.js           # Skill vocabulary (single source of truth)
│   │   ├── tfidf.js           # Lexical similarity (IDF-weighted coverage)
│   │   ├── matcher.js         # Job scoring engine
│   │   ├── parser.js          # Resume file parser (PDF/DOCX/text)
│   │   └── pdf.min.js         # Vendored pdf.js
│   └── icons/
│       ├── icon-16.png
│       ├── icon-48.png
│       └── icon-128.png
├── server/
│   ├── index.js               # Express server entry point
│   ├── db.js                  # SQLite database layer
│   ├── email.js               # Nodemailer email service
│   ├── package.json
│   ├── llm.js                 # Ollama chat client (LLM judge)
│   ├── embeddings.js          # Ollama embeddings, chunking, max-sim, cache
│   └── routes/
│       ├── matches.js         # Match CRUD endpoints
│       ├── notify.js          # Email notification endpoint
│       ├── llm.js             # LLM scoring endpoints
│       └── score.js           # Two-stage scoring endpoint
├── eval/                      # Scorer evaluation harness
│   ├── run.js                 # Compare scorer variants on a labelled set
│   ├── seed.js                # Build a golden set from your own scraped jobs
│   ├── metrics.js             # precision@k, NDCG@k, Spearman
│   └── fixtures/              # Synthetic golden set (ships with the repo)
├── test/                      # node:test suites
└── README.md
```

## Scoring

Scoring runs in two places.

**Locally, in the extension** (always available, no server needed):
1. *Lexical* — IDF-weighted coverage: what fraction of the posting's weighted
   term mass appears in the resume. IDF is built across every job in the scan,
   not per job-pair.
2. *Skills* — coverage of the posting's named skills, damped when the posting
   names too few to be confident.
3. *Role fit* — penalties for mismatches the text cannot show: a recruiting or
   sales posting that quotes the whole engineering stack, a large seniority gap.

**On the backend** (when hybrid scoring is enabled and Ollama is running):
1. *Stage 1* — every job is chunked and embedded with `nomic-embed-text`, then
   scored by max-sim pooling against the resume's chunks. Vectors are cached in
   SQLite, so a rescore is nearly free.
2. *Stage 2* — the top N go to the chat model for a judged score with a
   rationale. That score is the one displayed.

If the backend or Ollama is unavailable, the local scores stand and the match is
labelled `local` so it is never mistaken for a model-judged result.

## Development

```bash
npm test          # run all test suites
npm run eval      # compare scorer variants on the golden set
```

The eval harness is the gate for scoring changes. The bundled golden set is
synthetic; for numbers that reflect your own search, build one from your
scraped jobs:

```bash
node eval/seed.js --help
```

To enable the embedding variants:

```bash
ollama serve
ollama pull nomic-embed-text
ollama pull llama3.1:8b
```

## Tech Stack

- **Extension**: Manifest V3, vanilla JavaScript, Chrome Storage API
- **NLP**: Pure JS TF-IDF with cosine similarity (zero external dependencies)
- **Backend**: Node.js, Express, better-sqlite3, Nodemailer
- **UI**: Custom dark theme, responsive popup design

## License

MIT
