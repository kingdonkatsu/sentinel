# Sentinel Engineering Handoff

Last updated: March 17, 2026

This file is the maintainer-facing reference for the current Sentinel codebase. It replaces the old hackathon notes with an operator and engineering handoff that matches what is actually implemented in the repo.

## System Summary

Sentinel is a three-part product for triaging potentially concerning Instagram Stories viewed by youth workers:

1. A Chrome extension performs in-browser analysis.
2. A FastAPI service ingests and ranks score events in Redis.
3. A Next.js dashboard surfaces the live queue and account detail views.

The privacy model implemented in code is:

- Raw story media is analysed in the browser.
- Numeric scores and the Instagram username are sent to the backend.
- Score records and account summaries expire from Redis after 24 hours.

Important clarification: the backend currently stores raw usernames. The system does not yet hash or pseudonymise them before storage.

## Current Build State

### Verified

- Backend routes for health, score ingest, dashboard views, confirmations, SSE, and outreach suggestions.
- Redis-backed ranking and 24-hour expiry.
- Dashboard queue, account detail, notes panel, outreach card, and confirm workflow.
- Extension scoring pipeline with OCR, semantic text scoring, visual scoring, temporal analysis, metadata analysis, and video sampling.
- 15 backend integration tests and 28 extension unit tests are present in the repo.

### Not yet production-safe

- API auth is a shared header key.
- Dashboard confirm requests use a public browser environment variable.
- CORS is fully open.
- Extension behaviour on live Instagram still needs field validation.
- Build and deployment workflows still contain hackathon shortcuts.

## Architecture

```text
Instagram Story
  -> Chrome extension content script
  -> local modality analysers
  -> composite score + modality scores
  -> FastAPI / Redis
  -> dashboard REST + SSE consumers
```

### Extension

Primary entry points:

- [`extension/src/content/main.ts`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/extension/src/content/main.ts)
- [`extension/src/content/analysis-pipeline.ts`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/extension/src/content/analysis-pipeline.ts)
- [`extension/src/background/service-worker.ts`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/extension/src/background/service-worker.ts)
- [`extension/src/popup/popup.ts`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/extension/src/popup/popup.ts)

Implemented modalities:

- `text`: OCR via story OCR + keyword logic + MiniLM semantic similarity
- `visual`: face-api.js facial expression scoring blended with heuristic image scoring
- `temporal`: per-account short-term pattern analysis
- `video`: multi-frame sampling for video Stories
- `metadata`: DOM-derived platform cues

Key extension behaviours:

- Loads model assets from `extension/public/models`
- Sends only scores and metadata to the backend
- Polls `/api/v1/confirmations` every minute
- Lets the worker configure API URL, API key, threshold, and image/text weighting in the popup

### Backend

Primary entry points:

- [`backend/app/main.py`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/backend/app/main.py)
- [`backend/app/services/score_service.py`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/backend/app/services/score_service.py)
- [`backend/app/services/outreach_service.py`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/backend/app/services/outreach_service.py)
- [`backend/app/models.py`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/backend/app/models.py)

Redis storage model:

- `score:{username}:{timestamp}`: per-score hash
- `scores_list:{username}`: sorted set of timestamps
- `account:{username}`: latest account summary
- `priority_index`: max composite score per username
- `stream:scores`: SSE event stream
- `confirmation:{username}:{timestamp}` and `confirmations`: confirmation storage and index

Expiry policy:

- Scores, account summaries, and confirmations are set to 24 hours.
- Queue ordering is driven by the highest composite score seen for the account.

### Dashboard

Primary entry points:

- [`dashboard/src/app/dashboard/page.tsx`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/dashboard/src/app/dashboard/page.tsx)
- [`dashboard/src/app/dashboard/[username]/page.tsx`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/dashboard/src/app/dashboard/[username]/page.tsx)
- [`dashboard/src/components/priority-table.tsx`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/dashboard/src/components/priority-table.tsx)
- [`dashboard/src/components/outreach-card.tsx`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/dashboard/src/components/outreach-card.tsx)
- [`dashboard/src/lib/api.ts`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/dashboard/src/lib/api.ts)

Implemented UX:

- Queue page with live connectivity indicator
- Account detail page with latest scores and historical observations
- Confirm case action
- Outreach suggestion card
- Local notes panel

## Runtime Configuration

### Backend environment

Defined in [`backend/app/config.py`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/backend/app/config.py):

- `REDIS_URL`
- `API_KEY`
- `DASHBOARD_URL`
- `OPENAI_API_KEY`

Defaults still include hackathon-safe values. Override them in every non-local environment.

### Dashboard environment

- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_API_KEY`

The second variable is used client-side for case confirmation. That is convenient for demos and wrong for a real deployment.

### Extension configuration

Persisted in Chrome storage:

- `sentinel_api_url`
- `sentinel_api_key`
- `sentinel_threshold`
- `sentinel_weights`

The default config still points to `http://localhost:8000` and uses `sentinel-hackathon-key`.

## API Contract

Implemented routes in [`backend/app/main.py`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/backend/app/main.py):

| Method | Endpoint | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/v1/scores` | `X-Sentinel-Key` | Accepts username, composite score, optional text/image scores, timestamp, optional modality map |
| `GET` | `/api/v1/dashboard` | None | Ranked account list |
| `GET` | `/api/v1/dashboard/{username}` | None | Full score history for an account |
| `GET` | `/api/v1/scores/feed` | None | Redis stream exposed as SSE |
| `POST` | `/api/v1/outreach/suggest` | None | Uses OpenAI or fallback suggestions |
| `POST` | `/api/v1/accounts/{username}/confirm` | `X-Sentinel-Key` | Records calibration confirmation |
| `GET` | `/api/v1/confirmations` | `X-Sentinel-Key` | Poll endpoint for the extension |
| `GET` | `/api/v1/health` | None | Basic health check |

## Test And Build Commands

### Backend

```bash
docker compose up -d redis
cd backend
pytest tests -q -p no:cacheprovider
```

### Extension

```bash
cd extension
npm run test:unit
npm run build
```

### Dashboard

```bash
cd dashboard
npm run build
```

## Operational Hazards

### Redis flush during extension build

[`extension/package.json`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/extension/package.json) runs `node ./scripts/flush-redis.mjs` after the raw build. That script executes `FLUSHDB` against the Redis instance defined by `REDIS_URL` or `backend/.env`.

Treat this as local-only behaviour. Do not run it against shared, staging, or production Redis.

### Open CORS

[`backend/app/main.py`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/backend/app/main.py) currently allows:

- all origins
- all methods
- all headers
- credentials enabled

This is acceptable for rapid integration and unacceptable for production.

### Public confirmation key

[`dashboard/src/lib/api.ts`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/dashboard/src/lib/api.ts) sends `NEXT_PUBLIC_API_KEY` from the browser. Any real deployment needs a server-mediated auth path instead.

### Privacy copy drift

Some UI strings still overstate the current privacy posture. The code stores raw usernames and does not yet implement the salted hashing approach described in earlier demo materials.

## Data Handling Reality

### Stored

- Instagram username
- composite score
- text score when available
- image score when available
- modality score map when available
- timestamps
- confirmation events

### Not stored by backend

- raw Story images
- raw OCR output
- raw text content
- embeddings
- video files

The extension logs some diagnostic information to the browser console during analysis. Review those logs before any external pilot if strict operator workstation controls are required.

## Deployment Notes

### Docker

[`docker-compose.yml`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/docker-compose.yml) defines:

- `redis`
- `api`
- `dashboard`

The extension is not containerised and must still be loaded into Chrome manually.

### Container images

- Backend image: [`backend/Dockerfile`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/backend/Dockerfile)
- Dashboard image: [`dashboard/Dockerfile`](/Users/poonj/Library/CloudStorage/OneDrive-Personal/sentinel/dashboard/Dockerfile)

Both are sufficient for local packaging. Neither includes production orchestration, ingress, secret injection, or health-based rollout logic.

## Release Blockers

The repo can support demos and controlled internal pilots, but these should be completed before calling it production:

1. Replace shared API-key auth with real service and user authentication.
2. Remove the Redis flush build hook.
3. Restrict CORS and deploy behind TLS.
4. Decide whether usernames may be stored in plaintext; if not, redesign the identifier flow.
5. Validate extension selectors and analysis quality on live Instagram under realistic workload.
6. Add monitoring, audit logging, and operator access controls.
7. Remove or rewrite any stale UI and documentation claims that imply implemented pseudonymisation.

## Recommended Next Work

If development continues, the next highest-value engineering areas are:

1. Live validation of the extension on real Instagram Stories and selector hardening.
2. Score quality evaluation with labelled examples and false-positive review.
3. Server-side auth redesign for dashboard actions.
4. Packaging and environment-specific deployment automation.
5. Privacy and compliance review based on the code as implemented, not the pitch deck version.
