# Sentinel v2 — Implementation Plan

## Context

Sentinel's scoring pipeline is mostly heuristics: image risk = darkness/desaturation/red, text risk = keyword substring matching, and DOM scraping returns empty for most Instagram Stories (text is baked into pixels). Composite scores collapse to similar values. This plan upgrades the pipeline to produce meaningful, confidence-aware, explainable triage output — while preserving the privacy invariant (zero raw content stored or transmitted).

---

## Rollout Timeline

### Phase 1a — Foundation: Cleanup + Confidence + Instrumentation
- P1.1: Remove heuristic fallback fabrication
- P1.5: Confidence / abstain behavior + `status` and `tags` type changes
- Instrumentation: add structured console logging for modality results so we can observe real distributions before tuning

### Phase 1b — OCR: Feasibility Spike, Then Full Integration
- Spike: minimal Tesseract.js proof-of-concept in-extension — confirm it loads, captures, and returns text on a real Instagram Story
- If spike passes: full P1.2 integration (ocr-manager, ocr-capture, merge into semantic analyser)

### Phase 1c — Text Quality + Tags + Dedup
- P1.3: Text context filter (negation, quote, meme heuristics)
- P1.6: Evidence tags in all analysers + backend storage + dashboard display
- P1.4: Story-level deduplication (extension fingerprint + backend dedup)

### Phase 2a — CLIP in Shadow Mode
- P2.1: Replace face-api.js with CLIP ViT-B/32
- **Shadow mode only:** CLIP emits scores and tags to console/logs, but does NOT drive composite scoring or queue assignment
- Observe CLIP score distributions on real stories before trusting it

### Phase 2b — Gated Fusion + Queue Assignment
- P2.2: Gated multimodal fusion — only after seeing real CLIP distributions from 2a
- P2.3: Backend ranking redesign with triage queues (urgent / watchlist / review)

---

# PHASE 1a — Foundation

## P1.1: Remove Heuristic Fallback Fabrication

**Problem:** When face detection fails (no face / model absent), `visual-emotion-analyser.ts:129-133` returns the colour histogram score with confidence 0.3 — a bad proxy that causes false positives on dark-but-benign content.

**Fix:** Return `{ available: false, status: "missing" }` instead of fabricating a score. The fusion algorithm already handles unavailable modalities via confidence weighting.

### Files
| File | Change |
|------|--------|
| `extension/src/content/analysers/visual-emotion-analyser.ts` | When face-api.js returns no detections AND image capture succeeded: return `available: false` instead of histogram score. Keep histogram ONLY as debug data, not as a scored result. |
| `extension/src/content/image-analyser.ts` | No change — `analyseImage()` stays for potential future use, just not called as fallback score. |

---

## P1.5: Confidence and Abstain Behavior

**Problem:** Pipeline always outputs a score, even when evidence is weak. This overstates certainty.

### Type Changes
| File | Change |
|------|--------|
| `extension/src/shared/types.ts` | Add `status?: "ok" \| "missing" \| "uncertain"` and `tags?: string[]` to `ModalityResult`. Add `status` to `FusionResult`. Add `status` and `overallConfidence` to `AnalysisResult`. |

### Abstain Logic
| File | Change |
|------|--------|
| `extension/src/content/scoring/composite-scorer.ts` | Add abstention logic to `fuse()`: if `overallConfidence < 0.3` AND no modality has confidence > 0.5 → return `status: "uncertain"`. If only 1 modality available with confidence < 0.4 → `status: "uncertain"`. Include `status` in `FusionResult`. |
| `extension/src/content/analysis-pipeline.ts` | Propagate `status` from fusion into `AnalysisResult`. If status is `"uncertain"`, still transmit but with `status` field so backend can route differently. |
| `extension/src/content/score-transmitter.ts` | Include `status` and `overall_confidence` in payload. |
| `backend/app/models.py` | Add `status: Optional[str]` and `overall_confidence: Optional[float]` to `ScorePayload`. Add same fields to `AccountSummary` and `ScoreDetail`. |
| `backend/app/services/score_service.py` | Store `status` and `confidence` in Redis hash. Expose in dashboard/detail responses. |

## Instrumentation

Add structured logging to `analysis-pipeline.ts` after fusion:

```
[Sentinel:v2] {
  username, composite, status, overallConfidence,
  modalities: { text: {score, confidence, status, tags}, visual: {...}, ... },
  fusionWeights: { text: 0.42, visual: 0, ... },
  ocrAvailable: bool, ocrLatencyMs: number
}
```

This logging is critical — it gives us real distribution data before we tune fusion gates in Phase 2b.

---

# PHASE 1b — OCR

## OCR Feasibility Spike

Before full integration, validate in-extension:
1. `npm install tesseract.js` — does it bundle with Vite + CRXJS without errors?
2. Can `createWorker` load `eng.traineddata` from `chrome.runtime.getURL()`?
3. Does `captureForOcr()` at 1080x1920 succeed on an Instagram Story image (or hit CORS)?
4. What latency and word accuracy do we see on a real styled IG text overlay?

If spike fails on Vite/CRXJS worker bundling: fallback to loading Tesseract.js directly in content script (its internal worker handles threading). If CORS blocks capture: existing `FETCH_MEDIA_BYTES` bypass should handle it.

## P1.2: Full OCR Integration

### New Files
| File | Purpose |
|------|---------|
| `extension/src/content/ocr/ocr-manager.ts` | Tesseract.js worker lifecycle: `init()`, `recognizeText(imageData): Promise<string \| null>` with 3s timeout, `dispose()`. Uses Tesseract.js v5 built-in `createWorker`. Filters low-confidence words (<60%). Auto-terminates after 60s inactivity. Loads `eng.traineddata` from `chrome.runtime.getURL('models/tesseract/eng.traineddata')`. |
| `extension/src/content/ocr/ocr-capture.ts` | `captureForOcr(viewer): Promise<ImageData \| null>` — captures at native resolution capped 1080x1920 (not 224x224). Reuses `findPrimaryStoryMedia()` from `image-analyser.ts`. Same CORS bypass via `FETCH_MEDIA_BYTES`. |
| `extension/public/models/tesseract/eng.traineddata` | Bundled English language data (~4MB). Not fetched from CDN. |

### Modified Files
| File | Change |
|------|--------|
| `extension/src/content/text-analyser.ts` | Add `mergeTexts(domText, ocrText): string` — applies `UI_TEXT_PATTERNS` filter to OCR text, deduplicates overlapping strings, concatenates remainder. |
| `extension/src/content/analysers/semantic-text-analyser.ts` | Core integration. `analyse()` launches OCR in parallel with keyword pre-check. If strong DOM signal + long text: skip OCR await. Otherwise: await OCR (3s timeout) → `mergeTexts()` → MiniLM on merged text. `isAvailable()` returns `true` always (OCR may find text when DOM is empty). Cleanup: `releaseString()` + `zeroImageData()`. |
| `extension/src/content/privacy/memory-monitor.ts` | Add `onPressure(callback)` registration. OCR manager registers its `dispose()`. |
| `extension/package.json` | Add `"tesseract.js": "^5.1.0"` |
| `extension/src/content/models/model-hashes.ts` | Add SHA-256 for `eng.traineddata` |
| `extension/public/models/README.md` | Add Tesseract download instructions |

### Data Flow
```
analyse(viewer):
  domText = extractText(viewer)              [~0ms]
  ocrPromise = captureForOcr → recognizeText [async, up to 3s]
  keywordScore = analyseText(domText)        [~1ms]
  if strong keyword + domText.length > 50: return early
  ocrText = await ocrPromise
  merged = mergeTexts(domText, ocrText)
  MiniLM inference on merged                 [~50ms]
  releaseString all + zeroImageData
```

### OCR Accuracy Mitigations
Tesseract.js accuracy on styled Instagram text is 20-50%. Mitigations:
1. **Pre-processing in worker**: grayscale conversion + contrast enhancement before recognition
2. **Per-word confidence threshold**: discard words below 60% confidence
3. **Minimum output length**: if filtered OCR text < 5 chars, treat as no text
4. **Key insight**: partial extraction like "can't... anymore" is enough for MiniLM cosine similarity to match distress phrases. The semantic model handles noisy input.

### Privacy
- Tesseract runs entirely in-browser (WASM), no network calls
- `eng.traineddata` bundled at build time, not fetched from CDN
- High-res ImageData zeroed after OCR: `imageData.data.fill(0)`
- OCR text string released via `releaseString()` after scoring
- No text, pixels, or embeddings transmitted — only numerical scores + tags

---

# PHASE 1c — Text Quality + Tags + Dedup

## P1.3: Text Context Filter — Negation, Quote, and Meme Heuristics

**Problem:** Keyword matching breaks on negation ("I'm NOT sad"), lyrics/quotes, sarcasm, and context.

**Fix:** Add heuristic layers between keyword pre-filter and MiniLM scoring. Not sarcasm detection (infeasible in-browser), but targeted false-positive reduction.

### New File
| File | Purpose |
|------|---------|
| `extension/src/content/analysers/text-context-filter.ts` | Pre-scoring context analysis that returns adjustment signals. |

**Context filter logic:**
```
analyseContext(text: string): ContextSignals {
  negated:       boolean   // "not sad", "don't want to die", "never felt hopeless"
  quoteLike:     boolean   // quotation marks, "—author", "lyrics:", song title patterns
  memeIsh:       boolean   // excessive caps, repeated letters "LMAOOO", emoji density
  personalDisclosure: boolean  // "I feel", "I'm", "today I", first-person + emotion
}
```

**Rules:**
- `negated` → dampen keyword score by 50%, reduce confidence by 0.2
- `quoteLike` → dampen score by 30%, add tag `quote_like_text`
- `memeIsh` → dampen score by 40%, add tag `meme_like_tone`
- `personalDisclosure` → boost confidence by 0.15, add tag `personal_disclosure`

### Modified Files
| File | Change |
|------|--------|
| `extension/src/content/analysers/semantic-text-analyser.ts` | After keyword pre-filter, run `analyseContext()`. Apply dampening/boosting before MiniLM. Attach context tags to result. |

---

## P1.6: Evidence Tags and Explainability

**Problem:** Workers see only numbers. For sensitive triage, need evidence context without exposing raw content.

### Extension Changes
| File | Change |
|------|--------|
| `extension/src/content/analysers/semantic-text-analyser.ts` | Emit tags: `hopelessness_language`, `self_harm_reference`, `urgency_signal`, `quote_like_text`, `meme_like_tone`, `personal_disclosure`, `ambiguous_negative_affect`. |
| `extension/src/content/analysers/visual-emotion-analyser.ts` | Emit tags: `face_detected`, `sad_expression`, `fearful_expression`, `no_face_detected`. |
| `extension/src/content/analysers/metadata-analyser.ts` | Emit tags: `close_friends_story`, `reply_disabled`, `late_night_post`. |
| `extension/src/content/analysers/temporal-analyser.ts` | Emit tags: `rising_trend`, `burst_posting`, `sustained_high`. |
| `extension/src/content/score-transmitter.ts` | Aggregate all modality tags into payload: `evidence_tags: string[]`. |

### Backend Changes
| File | Change |
|------|--------|
| `backend/app/models.py` | Add `evidence_tags: Optional[list[str]]` to `ScorePayload`, `ScoreDetail`, `AccountSummary`. |
| `backend/app/services/score_service.py` | Store `evidence_tags` JSON in score hash and account hash. Expose in API responses. |

### Dashboard Changes
| File | Change |
|------|--------|
| `dashboard/src/lib/api.ts` | Extend `AccountSummary` and `ScoreDetail` types with `evidence_tags`, `status`, `overall_confidence`, `modality_scores`. |
| `dashboard/src/components/priority-table.tsx` | Show confidence badge next to risk score. Show top 2-3 evidence tags as small chips below score. Show `uncertain` status as distinct visual treatment (e.g., grey border instead of red/orange). |
| `dashboard/src/app/dashboard/[username]/page.tsx` | Add evidence tags section below sub-scores. Show modality availability (which modalities fired). Show confidence per-modality if available. |
| `dashboard/src/lib/utils.ts` | Add `tagLabel(tag)` helper for human-readable tag display. Add `confidenceLabel(confidence)` helper. |

---

## P1.4: Story-Level Deduplication

**Problem:** Same story reprocessed on DOM mutations, creating duplicate score events and inflating trends.

**Current state:** `story-detector.ts` already has signature-based dedup (username + media source + text, 10s window, 120s TTL). This is decent but misses OCR text.

### Modified Files
| File | Change |
|------|--------|
| `extension/src/content/story-detector.ts` | Add `storyFingerprint` to signature: hash of (username + media URL + first 200 chars of merged text). Extend `DUPLICATE_WINDOW_MS` from 10s → 30s. Add `fingerprint` field to score payload for backend dedup. |
| `extension/src/content/score-transmitter.ts` | Include `fingerprint` in transmitted payload. |
| `backend/app/models.py` | Add `fingerprint: Optional[str]` to `ScorePayload`. |
| `backend/app/services/score_service.py` | In `ingest_score()`: if fingerprint provided, check Redis `SET fingerprint:{hash}` with 60s TTL. Skip ingestion if already exists. |

---

## Phase 1 Verification

1. **Build:** `cd extension && npm run build` — no errors, `dist/` size reasonable
2. **Backend tests:** `cd backend && pytest tests -q` — existing 13 tests still pass
3. **OCR:** Load extension → open Instagram Story with text overlay → console shows extracted OCR text → text modality returns non-neutral score
4. **Fallback removal:** Story with no face → visual modality returns `available: false` (not histogram score)
5. **Context filter:** Text "I'm NOT sad today" → lower score than "I'm sad today"
6. **Dedup:** Same story re-triggered by DOM mutation → only 1 score event in backend
7. **Abstain:** Story with missing image + no text → status `uncertain` in pipeline output
8. **Evidence tags:** Dashboard account detail shows tags like `urgency_signal`, `personal_disclosure`
9. **Privacy:** Network tab shows no OCR-related outbound requests. No raw text in payload — only scores + tags.

---

# PHASE 2a — CLIP in Shadow Mode

## P2.1: Replace face-api.js with CLIP ViT-B/32

**Problem:** face-api.js only detects faces (~30% of stories have usable faces). With P1.1 removing the histogram fallback, visual modality becomes `unavailable` on ~70% of stories.

**Fix:** CLIP ViT-B/32 zero-shot classification via Transformers.js — understands full scenes, not just faces. ~87MB INT8 vision encoder.

**Shadow mode constraint:** CLIP scores and tags are logged and transmitted as metadata, but the composite scorer continues to use the existing visual modality result (which will be `available: false` for faceless stories). This lets us observe CLIP's real distribution before it drives triage decisions.

### New Files
| File | Purpose |
|------|---------|
| `extension/scripts/precompute-clip-embeddings.ts` | Build-time script: loads full CLIP model in Node.js, encodes classification prompts → outputs `clip-text-embeddings.json` (~40KB). |
| `extension/public/models/clip-text-embeddings.json` | Pre-computed 512-dim embeddings for 10 classification prompts (7 distress + 3 negative anchors). |

### Classification Prompts
**Distress (positive signal):**
1. "a person in emotional distress or crying"
2. "dark, gloomy, and depressing imagery"
3. "self-harm or self-destructive behaviour"
4. "loneliness and isolation"
5. "anger, rage, or violent imagery"
6. "anxiety and panic"
7. "hopelessness and despair"

**Negative anchors (suppress score):**
8. "a happy, positive, and cheerful scene"
9. "a neutral everyday scene"
10. "friends having fun together"

### Story Type Classification
Same CLIP model classifies story type via additional prompts:
- "selfie or portrait photo"
- "scenery or landscape"
- "text on image or quote card"
- "meme or screenshot"
- "group photo"

### Scoring Logic
1. Run 224x224 ImageData through CLIP vision encoder → 512-dim embedding
2. Cosine similarity against pre-computed prompt embeddings
3. Softmax → per-prompt probabilities
4. Risk score = weighted sum of distress probabilities (prompts 1-7), scaled 0-100
5. Confidence = 1.0 minus max negative-anchor probability

### Shadow Mode Implementation
| File | Change |
|------|--------|
| `extension/src/content/analysers/visual-emotion-analyser.ts` | Full rewrite: remove face-api.js, implement CLIP zero-shot scoring. Load vision encoder via `@xenova/transformers`. Emit tags: `distress_imagery`, `isolation_scene`, `dark_aesthetic`, `story_type:*`. **Add `shadow: boolean` flag** — when true, result is logged and included in `evidence_tags` but `available` is set to `false` so composite scorer ignores it. |
| `extension/src/content/analysis-pipeline.ts` | Log shadow CLIP result alongside regular pipeline output. Include CLIP score/tags in transmitted metadata for backend observation. |
| `extension/src/content/models/model-manager.ts` | Add CLIP model loading/unloading, WebGPU detection, inactivity timer. |
| `extension/src/content/models/model-hashes.ts` | Remove face-api hashes, add CLIP vision encoder SHA-256. |
| `extension/package.json` | Remove `@vladmandic/face-api`. Evaluate if `@tensorflow/tfjs` still needed (likely removable). Add `precompute-embeddings` script. |
| `extension/public/models/faceapi/` | Delete directory. |
| `extension/public/models/Xenova/all-MiniLM-L6-v2/onnx/` | Delete 7 unused ONNX variants (keep only `model_quantized.onnx`). Saves ~306MB. |
| `extension/public/models/README.md` | Update with CLIP download instructions. |

### Performance
| Metric | Target |
|--------|--------|
| CLIP inference (WebGPU) | <100ms per frame |
| CLIP inference (WebGL fallback) | <300ms per frame |
| Model first load | ~8s (one-time, cached IndexedDB) |
| Memory | ~120MB with all models loaded |
| Bundle size | ~115MB (down from 334MB) |

### Fallback
- WebGPU unavailable → return `available: false` (no fabrication, per P1.1)
- Model missing/corrupt → same
- 500MB heap guard → unload CLIP, degrade gracefully

### Phase 2a Verification
1. CLIP loads, scores, and emits tags in console — but composite score is unchanged from Phase 1
2. Backend receives CLIP scores/tags as metadata for observation
3. Bundle size drops to ~115MB (from 334MB)
4. No face-api.js references remain in compiled output

---

# PHASE 2b — Gated Fusion + Queue Assignment

**Prerequisite:** Observe CLIP score distributions from Phase 2a on real stories. Only proceed once we understand CLIP's accuracy, false positive patterns, and score range on actual Instagram content.

## P2.2: Gated Multimodal Fusion

**Problem:** Current fusion is arithmetic weighted average. Doesn't encode decision logic like "text-heavy story with low visual signal → text dominates" or "dark aesthetic + no distress text → suppress risk."

**Fix:** Add decision gates before the weighted average in `composite-scorer.ts`. Remove shadow flag from CLIP — let it drive scoring.

### Modified Files
| File | Change |
|------|--------|
| `extension/src/content/analysers/visual-emotion-analyser.ts` | Remove `shadow` flag — CLIP now returns `available: true` and contributes to composite. |
| `extension/src/content/scoring/composite-scorer.ts` | Add `applyGates(results)` step before weighted average. |

### Gate Logic
```
Gate 1 — Text dominance:
  if text.available AND text.confidence > 0.6
     AND visual.status in ["missing", "uncertain"]
  → text.weight *= 1.5, visual.weight = 0

Gate 2 — Dark aesthetic suppression:
  if visual has tag "dark_aesthetic" or "story_type:scenery"
     AND text.score < 50 (no distress text)
  → visual.score = min(visual.score, 45), visual.confidence *= 0.5

Gate 3 — Quote/lyric suppression:
  if text has tag "quote_like_text"
  → text.confidence *= 0.5

Gate 4 — OCR-image corroboration:
  if text.score > 70 AND visual.score > 70
     AND both confidence > 0.5
  → overall_confidence *= 1.3 (capped at 1.0)

Gate 5 — Missing modality degradation:
  if modality.status == "missing"
  → do NOT substitute neutral score
  → exclude from fusion entirely
  → reduce overall_confidence proportionally
```

---

## P2.3: Backend Ranking Redesign

**Problem:** Backend ranks by `max_composite` only. One spike dominates. No confidence-aware sorting.

### Modified Files
| File | Change |
|------|--------|
| `backend/app/models.py` | Add `queue: Optional[str]` to `AccountSummary` (values: `"urgent"`, `"watchlist"`, `"review"`). |
| `backend/app/services/score_service.py` | Add `assign_queue(account_data)` logic. Ranking signal = `composite * confidence * recency_decay * repeat_factor`. |

### Queue Assignment
```
urgent:    composite >= 75 AND confidence >= 0.6 AND status == "ok"
watchlist: composite >= 55 AND confidence >= 0.4 AND status == "ok"
           OR composite >= 75 AND status == "uncertain"
review:    everything else with at least 1 score event
```

### Ranking Within Queue
```
rank_score = composite
           * confidence
           * recency_decay(hours_since_last_seen)
           * (1 + 0.1 * min(score_count, 10))
```
Where `recency_decay = max(0.3, 1.0 - hours/24)`.

### Dashboard Changes
| File | Change |
|------|--------|
| `dashboard/src/components/priority-table.tsx` | Group accounts by queue with section headers: "Urgent Now", "Watchlist", "Review / Uncertain". Different visual treatment per queue. |
| `dashboard/src/app/dashboard/page.tsx` | Add queue filter tabs or sections. |

### Phase 2b Verification
1. **CLIP active:** Scenery story (no face) → visual modality `available: true` with meaningful score
2. **Gated fusion:** Dark scenery + neutral text → composite < 50. Distress text + matching visual → composite boosted.
3. **Backend queues:** Accounts appear in correct queue based on composite + confidence.
4. **Dashboard:** Queue sections visible. Uncertain accounts shown with reduced visual prominence.
5. **Backend tests:** All existing + new tests pass.

---

# Items NOT in this plan (and why)

| Item | Reason |
|------|--------|
| Sarcasm detection | Unsolved NLP problem; no small model handles it. Infeasible in-browser. |
| Singlish/Malay/Mandarin text scoring | MiniLM-L6-v2 is English-only. Multilingual models are 130-470MB. Can add OCR language packs later (Tesseract supports `chi_sim`, `msa`) but semantic scoring won't understand them. |
| ASR (audio/video speech) | Instagram CORS blocks audio streams. Double-blocked by model size (~150MB Whisper-tiny). |
| Fine-tuned classifiers | Need labeled training data that doesn't exist yet. Revisit after eval set is built. |
| Labeled eval set + calibration | Labor-intensive content curation (not code). Recommended as Phase 3 after pipeline is improved. |
| Product framing/claims | Documentation-only changes, trivially done anytime. |
