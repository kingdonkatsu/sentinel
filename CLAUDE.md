# Sentinel - Development Notes

**Last Updated:** March 6, 2026
**Status:** Live - Multi-modal AI pipeline implemented (Phases 1-3 complete), all models downloaded
**Built By:** Claude (Opus 4.6) with Senior Software Engineer at Singapore Social Enterprise

---

## What Is Sentinel?

A privacy-first mental health detection tool for youth social workers. Monitors Instagram Stories in real-time via Chrome extension, scores content for emotional distress using in-browser ML inference, and surfaces prioritized cases on a worker dashboard.

**Core Innovation:** Story content (images, text, video) is scored in-browser and immediately discarded. Only numerical scores + Instagram usernames are sent to backend. Zero raw content storage.

---

## Architecture Overview

### Three Components

1. **Chrome Extension** (TypeScript, Manifest V3)
   - Detects Instagram Stories via MutationObserver
   - Runs 5-modality ML analysis pipeline entirely in-browser
   - Shows HIGH RISK overlay with modality breakdown on concerning Stories
   - Sends only: username + scores + timestamp + per-modality scores to backend
   - Polls backend for confirmed cases to calibrate analysis weights

2. **Backend API** (Python FastAPI + Redis)
   - Receives anonymized scores (including optional per-modality breakdown)
   - Ranks accounts by severity in Redis sorted set
   - Auto-purges all data after 24h (GDPR compliant)
   - Generates AI conversation starters via OpenAI
   - Streams real-time updates via SSE
   - Stores confirmation events for calibration feedback loop

3. **Worker Dashboard** (Next.js 14 + Tailwind)
   - Priority queue ranked by max risk score
   - Real-time updates via Server-Sent Events
   - Account detail with score timeline charts
   - AI-suggested outreach messages
   - Local-only case notes
   - Confirm Case button to feed calibration signal back to extension

---

## Current Status

### ✅ Fully Working
- Backend API (13 integration tests passing; live OpenAI still requires `OPENAI_API_KEY` for manual verification)
- Redis data storage with 24h TTL
- Worker dashboard with real-time updates and Confirm Case button
- AI outreach generation (OpenAI + offline fallback)
- Multi-modal analysis pipeline (code complete)
- Calibration feedback loop (extension ↔ backend ↔ dashboard)

### ⚠️ Requires Setup
- Chrome extension (compiles cleanly, not tested on Instagram)
- Instagram Story detection (DOM selectors may need adjustment)
- Image/video capture (likely blocked by CORS — visual emotion falls back to colour histogram)
- Story scoring still needs debugging; results are inconsistent and can collapse to the same score across different stories or users

### 🔴 Known Limitations
- Extension won't work on Instagram without testing/debugging DOM selectors
- Scoring is not production-ready yet; repeated identical composites still appear after the first analysed story in some runs
- ML models not bundled (must be downloaded separately — ~13MB)
- Audio modality intentionally skipped (Instagram CORS blocks audio streams; visual catches same signals)
- Simple API key auth (not JWT)

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Extension | TypeScript + Vite + Manifest V3 |
| Visual Scoring | face-api.js TinyFaceDetector + FaceExpressionNet (vladmandic fork) |
| Text Scoring | MiniLM-L6-v2 sentence embeddings via Transformers.js (ONNX int8) |
| Temporal Scoring | Ring buffer heuristics (no model) |
| Video Scoring | Multi-frame sampling via visual emotion model |
| Metadata Scoring | DOM scraping (no model) |
| Score Fusion | Confidence-weighted Bayesian fusion with critical signal override |
| Weight Calibration | Social worker confirmation feedback loop |
| Backend | FastAPI (Python 3.12) + Redis 7 |
| Dashboard | Next.js 14 + Tailwind + shadcn/ui |
| Real-time | Server-Sent Events (SSE) |
| AI Outreach | OpenAI GPT-4o-mini |
| Infrastructure | Docker Compose |

---

## ML Models

All models run **entirely in-browser** (TF.js + Transformers.js). No content leaves the device for inference.

| Model | File Location | Size | Status |
|-------|--------------|------|--------|
| face-api.js TinyFaceDetector | `extension/public/models/faceapi/tiny_face_detector_model-*` | ~190KB | ✅ Downloaded |
| face-api.js FaceExpressionNet | `extension/public/models/faceapi/face_expression_model-*` | ~330KB | ✅ Downloaded |
| MiniLM-L6-v2 (ONNX int8) | `extension/public/models/Xenova/all-MiniLM-L6-v2/` | ~6MB | ✅ Downloaded |
| Distress phrase vectors | Auto-computed on first load | ~300KB cached | ✅ Auto |

**Total model size: ~6.5MB** (well under 30MB budget)

### Notes
- SHA-256 hashes for face-api.js shards are stored in `extension/src/content/models/model-hashes.ts`
- To re-download, follow `extension/public/models/README.md`

### Backend Selection (Auto)
Extension tries: **WebGPU → WebGL → WASM → CPU** (fastest available on user's device)

### Loading Strategy
- Lazy-loaded on first analysis (not on install)
- Cached in extension-origin IndexedDB
- Unloaded after 60s inactivity
- Force-unloaded if JS heap > 500MB

---

## Analysis Pipeline

### 5 Active Modalities (each produces score 0-100 + confidence 0.0-1.0)

| Modality | Model | Fallback | Base Weight |
|----------|-------|---------|-------------|
| **Text** (semantic) | MiniLM-L6 cosine similarity vs 50 distress phrases | Keyword matching (60+ terms) | 35% |
| **Visual** (emotion) | face-api.js TinyFaceDetector + FaceExpressionNet 7-class | Colour histogram | 25% |
| **Temporal** (patterns) | Ring buffer heuristics | Always available | 20% |
| **Video** (frames) | 3-frame sampling via visual model | Single frame | 15% |
| **Metadata** (context) | DOM scraping (close-friends, reply-disabled, late-night) | N/A | 5% |

*Audio modality (YAMNet) intentionally excluded — Instagram CORS blocks streams; visual covers same signals.*

### Fusion Algorithm
1. **Effective weight** = base_weight × confidence × availability
2. **Normalize** weights to sum to 1.0
3. **Weighted composite** = Σ(score × norm_weight)
4. **Confidence dampening:** if overall_confidence < 0.5 → pull toward midpoint
5. **Critical override:** if any modality has score ≥ 90 AND confidence ≥ 0.8 → floor composite at 75

### Weight Calibration
- When a social worker confirms a case on dashboard → signal flows to extension
- Extension nudges modality weights: `w_i = w_i × (1 + 0.1 × (accuracy_i - 0.5))` (max ±5%)
- Stored in `chrome.storage.session`; resets every 7 days

---

## How to Run (Development)

### Prerequisites
- Docker Desktop (for Redis)
- Python 3.12 + pip
- Node.js 20 + npm
- Chrome browser (for extension testing)
- ML model files (see [Models section](#ml-models))

### Quick Start

```bash
# 1. Start Redis
docker compose up -d redis

# 2. Start Backend (local dev mode)
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload

# 3. Start Dashboard
cd ../dashboard
npm install
npm run dev

# 4. Load Extension in Chrome
cd ../extension
npm install
npm run build
# Load dist/ folder in chrome://extensions (Developer Mode)
# Set API URL to http://localhost:8000 and API Key to value in backend/.env
```

**Access:**
- Backend API: http://localhost:8000/docs (Swagger UI)
- Dashboard: http://localhost:3000/dashboard

---

## Project Structure

```
sentinel/
├── extension/              # Chrome Extension (Manifest V3)
│   ├── src/
│   │   ├── content/
│   │   │   ├── analysers/            # Per-modality analysers
│   │   │   │   ├── visual-emotion-analyser.ts   (BlazeFace + MobileNetV2)
│   │   │   │   ├── semantic-text-analyser.ts    (MiniLM + cosine similarity)
│   │   │   │   ├── temporal-analyser.ts         (ring buffer patterns)
│   │   │   │   ├── video-analyser.ts            (3-frame sampling)
│   │   │   │   ├── metadata-analyser.ts         (DOM scraping)
│   │   │   │   └── distress-phrases.ts          (50 reference phrases, 5 tiers)
│   │   │   ├── models/
│   │   │   │   ├── model-manager.ts             (TF.js + Transformers.js lifecycle)
│   │   │   │   └── model-hashes.ts              (SHA-256 integrity constants)
│   │   │   ├── scoring/
│   │   │   │   ├── composite-scorer.ts          (Bayesian fusion engine)
│   │   │   │   └── weight-calibrator.ts         (feedback loop weights)
│   │   │   ├── privacy/
│   │   │   │   ├── secure-cleanup.ts            (pixel zeroing, tensor disposal)
│   │   │   │   └── memory-monitor.ts            (500MB heap guard)
│   │   │   ├── analysis-pipeline.ts             (orchestrates all modalities)
│   │   │   ├── story-detector.ts
│   │   │   ├── image-analyser.ts                (colour histogram fallback)
│   │   │   ├── text-analyser.ts                 (keyword fast-path)
│   │   │   ├── overlay-renderer.ts              (risk overlay + modality chips)
│   │   │   └── score-transmitter.ts
│   │   ├── background/
│   │   │   └── service-worker.ts                (chrome.alarms, confirmation polling)
│   │   ├── popup/         # Extension config UI
│   │   └── shared/
│   │       └── types.ts   # ModalityType, ModalityResult, RiskScoreV2, etc.
│   └── public/
│       ├── manifest.json
│       └── models/        # ML model files (download separately)
│           └── README.md  # Download instructions
│
├── backend/               # FastAPI Backend
│   ├── app/
│   │   ├── main.py       # API routes + SSE endpoint
│   │   ├── models.py     # Pydantic schemas (incl. ConfirmationEntry)
│   │   ├── services/     # Score + outreach services
│   │   └── tasks/        # Background cleanup
│   └── scripts/
│       └── # Removed demo seeding scripts
│
├── dashboard/             # Next.js Dashboard
│   ├── src/
│   │   ├── app/          # App Router pages (incl. Confirm Case button)
│   │   ├── components/   # Priority table, charts, outreach cards
│   │   └── lib/          # API client (incl. confirmCase())
│   └── public/
│
└── docker-compose.yml     # Redis + API + Dashboard orchestration
```

---

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/v1/scores` | API key | Submit score from extension (incl. optional modality_scores) |
| GET | `/api/v1/dashboard` | None | Get prioritized account list |
| GET | `/api/v1/dashboard/{username}` | None | Get account detail + score history |
| GET | `/api/v1/scores/feed` | None | SSE stream for real-time updates |
| POST | `/api/v1/outreach/suggest` | None | Generate AI conversation starters (`X-Sentinel-Outreach-Provider: openai|fallback`) |
| POST | `/api/v1/accounts/{username}/confirm` | API key | Record social worker confirmation (calibration) |
| GET | `/api/v1/confirmations` | API key | Get confirmations since timestamp (?since=ms_epoch) |
| GET | `/api/v1/health` | None | Health check |

---

## Data Model (Redis)

```
# Individual scores (auto-expire 24h)
score:{username}:{timestamp} → Hash {composite, text, image, timestamp,
                                      modality_scores (JSON, optional)}

# Score history per account
scores_list:{username} → Sorted Set (timestamp → timestamp)

# Account summary
account:{username} → Hash {username, latest_composite, latest_text,
                           latest_image, last_seen, score_count,
                           latest_modality_scores (JSON, optional)}

# Priority ranking
priority_index → Sorted Set (username → max_composite)

# Real-time stream
stream:scores → Redis Stream (maxlen 1000)

# Confirmed cases index
confirmations → Sorted Set (username:timestamp → timestamp_ms)

# Individual confirmation records
confirmation:{username}:{timestamp_ms} → Hash {username, modality_scores (JSON), timestamp}
```

All keys have 24-hour TTL. `priority_index` cleaned by background task.

---

## Privacy Architecture

### Content Lifecycle (Core Invariant)
```
DOM element detected → Canvas draws frame (temp <canvas>) → ImageData extracted (JS heap)
→ Model inference (tensor created, scored, disposed) → Canvas removed → ImageData zeroed
→ ONLY numerical scores remain → Scores sent to backend
```

### Explicit Cleanup After Every Analysis
```typescript
imageData.data.fill(0);   // Zero pixel buffer
tensor.dispose();         // Free GPU/CPU tensor memory
text = null;              // Release string reference
canvas.remove();          // Remove DOM element
```

### What Is Stored in Backend
- Instagram username
- Numerical risk scores (0-100)
- Per-modality score breakdown (integers only)
- Timestamps
- TTL: 24 hours

### What Is NEVER Stored Anywhere
- Story images, videos, or pixels
- Story text content
- Model embeddings or feature vectors
- Raw audio

### Model Security
- All models bundled at build time (no runtime CDN downloads)
- SHA-256 hash verification on first load
- Inference-only: no `tf.train`, no gradient computation
- CSP restricts to `'self' 'wasm-unsafe-eval'`

---

## Testing Checklist

### Backend
- [x] API health check
- [x] Submit score payload
- [x] Submit score with modality_scores
- [x] Retrieve dashboard data
- [x] Account detail view
- [x] SSE stream connects
- [x] AI outreach generation
- [x] Outreach provider header (`openai|fallback`)
- [x] 24h TTL purge (Redis EXPIRE)
- [x] Confirm case endpoint
- [x] Get confirmations endpoint

### Dashboard
- [x] Priority queue displays
- [x] Real-time updates work
- [x] Account detail loads
- [x] Charts render correctly
- [x] Outreach card generates
- [x] Case notes save locally
- [x] Confirm Case button

### Extension
- [ ] Loads in Chrome
- [ ] Detects Instagram Stories
- [ ] ML models load (face-api.js + MiniLM downloaded)
- [ ] Scores content correctly
- [ ] Overlay appears with modality breakdown
- [ ] Backend receives scores + modality breakdown
- [ ] Calibration confirmation polling works

---

## AI Backend Verification

### Automated
- Start Redis with `docker compose up -d redis`
- Run backend tests with `cd backend && pytest tests -q -p no:cacheprovider`
- Current automated coverage includes score ingestion, dashboard/detail retrieval, SSE, confirm flow, confirmation polling, fallback outreach, mocked OpenAI success, and OpenAI failure fallback logging

### Manual Fallback Check
- Leave `OPENAI_API_KEY` blank in `backend/.env`
- Start the backend and call `POST /api/v1/outreach/suggest`
- Expect the response header `X-Sentinel-Outreach-Provider: fallback`

### Manual Live OpenAI Check
- Set `OPENAI_API_KEY=sk-...` in `backend/.env`
- Restart `uvicorn`
- Call `POST /api/v1/outreach/suggest`
- Expect the response header `X-Sentinel-Outreach-Provider: openai`
- Hard-refresh the dashboard account page before re-checking outreach suggestions because the card caches for 5 minutes

---

## Important Configuration

### Extension Popup Settings
- API URL: `http://localhost:8000`
- API Key: `sentinel-hackathon-key` (default)
- Risk Threshold: 70 (adjustable 30-95)
- Base weights: text=35% / visual=25% / temporal=20% / video=15% / metadata=5% (auto-calibrated)

### Environment Variables

**Backend (.env):**
```
REDIS_URL=redis://localhost:6379/0
API_KEY=sentinel-hackathon-key
OPENAI_API_KEY=sk-your-key-here
DASHBOARD_URL=http://localhost:3000
```

If `OPENAI_API_KEY` is blank, the outreach endpoint still works but returns the offline fallback copy and `X-Sentinel-Outreach-Provider: fallback`.

**Dashboard (.env.local):**
```
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_API_KEY=sentinel-hackathon-key
```

---

## Known Issues & Workarounds

### Issue: ML Model Files Missing
**Why:** ~13MB of model binaries not committed to git
**Fix:** Follow `extension/public/models/README.md` to download BlazeFace, MobileNetV2, and MiniLM-L6 files
**Fallback:** Pipeline falls back to colour histogram + keyword matching automatically

### Issue: Instagram Story Detection May Fail
**Why:** Instagram frequently changes DOM structure
**Fix:** Use Demo Mode as fallback; inspect current DOM and update selectors in `story-detector.ts`

### Issue: CORS Blocks Image/Video Capture
**Why:** Instagram serves media from CDN with CORS protection
**Workaround:** Visual emotion analyser falls back to colour histogram (confidence=0.3); temporal + metadata analysers still run unaffected

### Issue: Extension Manifest Warnings
**Why:** Chrome MV3 deprecation warnings
**Impact:** None - extension still works

---

## Deployment Notes (Future)

For production deployment:
- Use JWT instead of API keys
- Deploy Redis to AWS ElastiCache
- Host backend on AWS ECS/Fargate
- Deploy dashboard to Vercel
- Update extension manifest with production API URL
- Add rate limiting to API
- Implement proper logging (not console.log)
- Add monitoring (Sentry, DataDog)
- Consider Chrome Web Store listing for easier deployment to workers

---

## References

- PRD: `Sentinel_PRD.docx`
- Original Architecture Plan: `.claude/plans/melodic-discovering-mountain.md`
- Multi-Modal AI Plan: `.claude/plans/replicated-stirring-axolotl.md`
- API Docs: http://localhost:8000/docs (when running)

---

## What's Next

### Critical (Must-Have)

1. **Test Extension on Instagram**
   - Load extension in Chrome
   - Open Instagram Stories
   - Debug Story detection (likely needs selector updates in `story-detector.ts`)
   - Verify modality breakdown appears on overlay
   - Confirm scores + modality data appear in dashboard

3. **Add OpenAI API Key**
   - Edit `backend/.env` and set `OPENAI_API_KEY=sk-...`
   - Required for AI outreach suggestions (offline fallback works without it)

### Nice-to-Have

4. **Performance Profiling**
   - Measure full pipeline on 2-core/4GB system
   - Target: < 500ms total (< 100ms visual, < 80ms text, < 5ms temporal, < 300ms video)

5. **Production Hardening**
   - Change `API_KEY` in `backend/.env` to a strong secret
   - See Deployment Notes section for full production checklist

---

## Contact & Credits

Built by Claude (Opus 4.6) for hackathon submission.
All code in this repository is original work created during this session.

**License:** To be determined by organization
