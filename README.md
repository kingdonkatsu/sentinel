# Sentinel

Sentinel is a privacy-first triage platform for youth workers monitoring Instagram Stories. The system runs analysis in the browser, sends only scores and account identifiers to the backend, and surfaces a live priority queue in a worker dashboard.

This repository is no longer just a hackathon prototype. It contains a working three-part product:

- `extension/`: Chrome extension with OCR, semantic text scoring, visual scoring, temporal heuristics, video sampling, and metadata signals.
- `backend/`: FastAPI + Redis API for score ingestion, prioritisation, confirmations, and outreach suggestions.
- `dashboard/`: Next.js dashboard for the live queue, account drill-down, score history, notes, and confirmation workflow.

## Status

As of March 17, 2026, the implemented system is suitable for demo, internal validation, and controlled pilot work.

- Backend API is implemented and covered by 15 Redis-backed integration tests.
- Extension analysis modules are implemented and covered by 28 unit tests.
- Dashboard is implemented and wired to the backend over REST and SSE.
- Local model assets for face detection, facial expression analysis, semantic text embeddings, and OCR are present in the repo.

The system is not ready for an unrestricted production rollout without hardening. The largest remaining gaps are live Instagram validation, stronger auth, tighter CORS, and removal of hackathon-safe defaults.

## What The Product Does Today

### Browser extension

- Detects Instagram Story viewer changes from the active page.
- Runs analysis locally in the browser.
- Uses OCR to extract on-screen text from Stories.
- Scores text with keyword logic plus MiniLM sentence embeddings.
- Scores visuals with face-api.js plus heuristic context cues.
- Tracks temporal patterns and simple metadata cues.
- Samples video Stories across multiple frames.
- Shows an on-screen risk overlay for high-scoring Stories.
- Sends only numeric scores, timestamps, and the Instagram username to the backend.
- Polls the backend for confirmed cases so modality weights can be nudged over time.

### Backend API

- Accepts score payloads over `POST /api/v1/scores`.
- Stores per-score and per-account data in Redis with 24-hour expiry.
- Maintains a ranked priority index by max observed composite score.
- Streams live score events over Server-Sent Events.
- Exposes account summaries and detail views for the dashboard.
- Records worker confirmations for calibration feedback.
- Generates outreach suggestions with OpenAI when configured, or a deterministic fallback when it is not.

### Dashboard

- Shows a priority queue ordered by highest observed risk.
- Refreshes automatically and listens to the live score stream.
- Provides account detail pages with a timeline and modality breakdown.
- Lets a worker confirm a case.
- Requests outreach suggestions from the backend.
- Stores notes locally in the browser for the selected account.

## Architecture

```text
Instagram Story in worker browser
        |
        v
Chrome extension
  - OCR
  - semantic text scoring
  - visual scoring
  - temporal and metadata scoring
  - video frame sampling
        |
        | scores only
        v
FastAPI API
  - score ingest
  - Redis storage with 24h TTL
  - priority index
  - confirmations
  - outreach suggestion service
  - SSE feed
        |
        v
Next.js dashboard
  - priority queue
  - account detail
  - charts
  - notes
  - confirm case
```

## Repository Layout

```text
sentinel/
├── backend/        FastAPI API, Redis-backed services, tests
├── dashboard/      Next.js dashboard
├── extension/      Chrome extension and in-browser models
├── project-docs/   Archived product and planning docs
├── CLAUDE.md       Engineering handoff and maintainer notes
└── docker-compose.yml
```

## Quick Start

### Prerequisites

- Docker Desktop
- Python 3.12+
- Node.js 20+
- npm
- Google Chrome

### 1. Configure secrets

Create `backend/.env` for local development:

```env
REDIS_URL=redis://localhost:6379/0
API_KEY=replace-this-before-any-shared-environment
DASHBOARD_URL=http://localhost:3000
OPENAI_API_KEY=
```

For the dashboard, set:

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_API_KEY=replace-this-before-any-shared-environment
```

`NEXT_PUBLIC_API_KEY` is only required for the client-side confirm action. Do not reuse the hackathon default outside local development.

### 2. Start the backend dependencies

```bash
docker compose up -d redis
```

### 3. Run the API

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

API docs: `http://localhost:8000/docs`

### 4. Run the dashboard

```bash
cd dashboard
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 \
NEXT_PUBLIC_API_KEY=replace-this-before-any-shared-environment \
npm run dev
```

Dashboard: `http://localhost:3000/dashboard`

### 5. Build and load the extension

```bash
cd extension
npm install
npm run build
```

Then load `extension/dist` in `chrome://extensions` with Developer Mode enabled. In the extension popup, set:

- API URL: `http://localhost:8000`
- API key: the same `API_KEY` used by the backend
- Threshold and image/text weighting as needed

## Docker Compose

`docker-compose.yml` builds and runs:

- `redis` on `:6379`
- `api` on `:8000`
- `dashboard` on `:3000`

To run the packaged backend and dashboard together:

```bash
docker compose up --build
```

The extension is still loaded separately into Chrome.

## API Surface

| Method | Endpoint | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/scores` | `X-Sentinel-Key` | Submit a score from the extension |
| `GET` | `/api/v1/dashboard` | None | Get ranked accounts |
| `GET` | `/api/v1/dashboard/{username}` | None | Get account detail and score history |
| `GET` | `/api/v1/scores/feed` | None | Subscribe to live score events |
| `POST` | `/api/v1/outreach/suggest` | None | Get outreach suggestions |
| `POST` | `/api/v1/accounts/{username}/confirm` | `X-Sentinel-Key` | Confirm a case |
| `GET` | `/api/v1/confirmations` | `X-Sentinel-Key` | Poll confirmations for calibration |
| `GET` | `/api/v1/health` | None | Health check |

## Testing

Start Redis first:

```bash
docker compose up -d redis
```

Backend integration tests:

```bash
cd backend
pytest tests -q -p no:cacheprovider
```

Extension unit tests:

```bash
cd extension
npm run test:unit
```

Dashboard production build:

```bash
cd dashboard
npm run build
```

## Production Hardening Required

These items should be treated as release blockers for any real deployment:

- Replace `sentinel-hackathon-key` everywhere. It is still the code default in multiple places.
- Lock down CORS in [`backend/app/main.py`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/backend/app/main.py). The API currently allows all origins, methods, and headers.
- Replace shared API-key auth with a real service-to-service and user auth model.
- Remove client exposure of privileged keys. The dashboard currently uses `NEXT_PUBLIC_API_KEY` for the confirm action.
- Decide on identifier handling. The backend stores raw Instagram usernames, not hashed pseudonyms.
- Validate the extension end-to-end on live Instagram and monitor score quality before trusting triage decisions.
- Review and remove the Redis flush hook in the extension build pipeline before using CI or shared environments.

## Operational Warnings

- `extension/package.json` runs `node ./scripts/flush-redis.mjs` as part of `npm run build`. That script issues `FLUSHDB` against the Redis DB configured by `REDIS_URL` or `backend/.env`. Do not run it against shared or production Redis.
- The backend uses Redis expiry for data lifecycle. A Redis outage or misconfiguration directly affects queue freshness and retention behaviour.
- Outreach suggestions are generated from scores only. They do not include message content or image context and should remain worker-assist output, not autonomous action.

## Known Gaps

- The extension compiles and its analysis modules are tested, but live Instagram DOM stability still needs field validation.
- Visual scoring still relies partly on heuristics when facial inference is weak or unavailable.
- There is no user management, audit trail, tenancy model, or role-based access control.
- There is no deployment automation or secret management beyond environment variables.

## Additional Documentation

- [CLAUDE.md](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/CLAUDE.md)
- [SENTINEL_V2_PLAN.md](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/SENTINEL_V2_PLAN.md)
- [extension/public/models/README.md](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/extension/public/models/README.md)
