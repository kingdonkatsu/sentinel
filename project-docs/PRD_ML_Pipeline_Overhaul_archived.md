# PRD: Sentinel ML Pipeline Overhaul

**Version:** 1.0
**Date:** 14 March 2026
**Author:** Claude (Opus 4.6)
**Status:** Draft
**Stakeholders:** Senior Software Engineer, Social Workers (end users)

---

## 1. Problem Statement

Sentinel's in-browser ML pipeline — designed to score Instagram Stories for emotional distress — has two critical blind spots that render scoring unreliable:

### 1.1 Visual Modality Is Face-Only

The current visual analyser uses face-api.js (TinyFaceDetector + FaceExpressionNet) to detect faces and classify 7 facial expressions. This fails on the majority of Instagram Stories because:

- Most stories do not contain prominent, forward-facing faces
- Stories with scenery, objects, text-on-background, selfies at unusual angles, or group shots at a distance produce **no face detections**
- When face detection fails, the pipeline falls back to a **colour histogram heuristic** (darkness + desaturation + red intensity) with a fixed confidence of 0.3 — essentially a coin flip weighted toward dark images
- Result: the visual modality (25% base weight) contributes near-zero useful signal for ~70% of stories

### 1.2 Text Modality Is Starved of Input

The semantic text analyser (MiniLM-L6-v2) computes cosine similarity between story text and 50 distress phrases. However, text is sourced exclusively from DOM scraping (`span[dir="auto"], div[dir="auto"]`). This fails because:

- Instagram bakes most story text into the image/video as rendered pixels — it does not exist in the DOM
- The only DOM-accessible text is interactive elements (sticker text, mentions, hashtags) which the current selectors largely miss
- Result: the text modality (35% base weight) — the highest-weighted modality — runs on empty input for most stories, defaulting to neutral (50, 0.0 confidence)

### 1.3 Cascading Effect

With the two highest-weighted modalities (60% combined) producing near-zero signal, the composite score is dominated by temporal patterns (20%), video (15%, which reuses the broken visual model), and metadata (5%). Scores collapse to similar values across different stories because the pipeline is effectively scoring posting patterns and DOM metadata rather than actual story content.

---

## 2. Goals

| # | Goal | Success Metric |
|---|------|---------------|
| G1 | Visual model scores **any** image content, not just faces | Visual modality returns confidence > 0.5 on >80% of stories (up from ~30%) |
| G2 | Text pipeline receives input from DOM elements currently being missed | `extractText()` returns non-empty string for >50% of stories with interactive text elements |
| G3 | Scores differentiate meaningfully between distress and non-distress content | Standard deviation of composite scores across a diverse story set is >15 (currently <8) |
| G4 | Total pipeline latency remains under 500ms for image stories | P95 latency < 500ms on WebGPU-equipped device |
| G5 | Extension bundle size is reduced from current 329MB bloat | Total `dist/` size < 130MB |
| G6 | Privacy invariant is preserved | Zero raw content (pixels, text, embeddings) leaves the browser or persists to disk |

### Non-Goals

- Full OCR of text baked into story images (rejected — see Section 5.1)
- Chrome Web Store distribution readiness (developer-loaded only)
- Audio modality (Instagram CORS blocks audio streams)
- Retraining or fine-tuning any model (no ML engineering step required)

---

## 3. Background & Prior Analysis

### 3.1 Current Architecture

| Modality | Model | Size | Base Weight | Problem |
|----------|-------|------|-------------|---------|
| Text (semantic) | MiniLM-L6-v2 (ONNX int8) | ~22MB | 35% | Starved — DOM scraping returns nothing |
| Visual (emotion) | face-api.js TinyFaceDetector + FaceExpressionNet | ~0.5MB | 25% | Face-only — misses ~70% of stories |
| Temporal (patterns) | Ring buffer heuristics | 0MB | 20% | Works correctly |
| Video (frames) | 3-frame sampling via face-api.js | 0MB (reuses visual) | 15% | Inherits visual model's blindness |
| Metadata (context) | DOM scraping | 0MB | 5% | Works correctly |

**Total model bundle:** 329MB (due to 7 unused MiniLM ONNX variants accidentally included)
**Actual models used:** ~23MB

### 3.2 Evaluated Alternatives

| Approach | Verdict | Reason |
|----------|---------|--------|
| Tesseract.js OCR | **Rejected** | 800-2000ms latency; 20-50% accuracy on styled IG text; 8-14MB added for unreliable output |
| CLIP ViT-B/32 (zero-shot) | **Accepted** | 40-100ms on WebGPU; scene-level understanding; no face required; ~87MB INT8 |
| SmolVLM2-500M | **Rejected** | Not available in ONNX for Transformers.js; 250MB+; decoder-based = 2-10s inference |
| Fine-tuned MobileNetV3 | **Deferred** | ~3-5MB, great latency, but requires ML training step out of current scope |

### 3.3 Model Budget Reassessment

The 30MB soft target in CLAUDE.md was a design-time estimate. Actual constraints for a developer-loaded extension:

| Constraint | Limit | Status |
|-----------|-------|--------|
| Chrome Web Store .zip | 500MB | N/A (developer-loaded) |
| Practical download/install | ~120MB comfortable | Within bounds |
| Runtime memory | 500MB JS heap guard | CLIP (87MB) + MiniLM (22MB) + overhead = ~200-300MB. 200-300MB headroom. |
| Disk footprint | No hard limit | ~110MB is acceptable |

**Decision:** Raise model budget to 120MB. Current 329MB bloat is a bug, not a feature.

---

## 4. Solution Overview

### 4.1 High-Level Changes

```
BEFORE                              AFTER
──────                              ─────
Visual: face-api.js (face-only)  →  CLIP ViT-B/32 (full scene, zero-shot)
Video:  3× face-api.js           →  3× CLIP ViT-B/32
Text:   DOM scrape (narrow)      →  DOM scrape (broadened selectors)
Fallback: crude histogram        →  enhanced histogram (contrast, edges, colour clusters)
Bundle: 329MB (7 unused models)  →  ~110MB (cleaned up + CLIP added)
```

### 4.2 What Stays Unchanged

- **MiniLM-L6-v2** text embedding pipeline (model stays, just gets better input)
- **Temporal ring buffer** analyser (no model, works correctly)
- **Metadata DOM scraper** (works correctly)
- **Composite scorer** Bayesian fusion algorithm
- **Weight calibration** feedback loop
- **Privacy architecture** (zero content storage, pixel zeroing, tensor disposal)
- **Score transmitter** and backend API contract
- **Overlay renderer** and modality chip display

---

## 5. Detailed Requirements

### 5.1 R1: Replace face-api.js with CLIP ViT-B/32

**Priority:** P0 (Critical)

#### 5.1.1 Model Selection

- **Model:** `Xenova/clip-vit-base-patch32` via Transformers.js / ONNX Runtime Web
- **Quantization:** INT8 (~87MB vision encoder)
- **Text encoder:** NOT bundled at runtime. Text embeddings for classification prompts are pre-computed at build time and shipped as a ~40KB JSON file.

#### 5.1.2 Zero-Shot Classification Prompts

Define 10 classification prompts covering the distress spectrum and negative anchors:

**Distress prompts (positive signal):**
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

Prompts should be tunable without retraining — changing a prompt only requires re-running the build-time embedding script and rebuilding.

#### 5.1.3 Scoring Logic

1. Run story image (224×224 ImageData) through CLIP vision encoder → 512-dim embedding
2. Compute cosine similarity against each of the 10 pre-computed prompt embeddings
3. Apply softmax normalization across all 10 similarities → per-prompt probabilities
4. **Risk score** = weighted sum of distress prompt probabilities (prompts 1-7), scaled to 0-100
5. **Confidence** = 1.0 minus the max negative-anchor probability (if the strongest match is "happy scene", confidence drops)
6. Clamp score to [0, 100], confidence to [0.0, 1.0]

#### 5.1.4 Implicit Text-in-Image Benefit

CLIP's training data included 400M image-text pairs, many containing text within images. CLIP can partially "read" prominent text in images (e.g., large text overlays saying "I give up"). This does not replace OCR but provides a supplementary signal for text baked into story images — partially addressing Problem 1.2 without the latency cost of Tesseract.js.

#### 5.1.5 Performance Requirements

| Metric | Target |
|--------|--------|
| Inference time (WebGPU) | < 100ms per frame |
| Inference time (WebGL) | < 300ms per frame (acceptable for image stories only) |
| Model load time (first use) | < 8 seconds (one-time, cached in IndexedDB) |
| Memory footprint | < 120MB including all loaded models |

#### 5.1.6 Fallback Behaviour

- **WebGPU unavailable:** Fall back to enhanced colour histogram (R3)
- **Model file missing/corrupt:** Fall back to enhanced colour histogram (R3)
- **500MB heap guard triggered:** Unload CLIP, fall back to enhanced colour histogram (R3)
- **Inference error:** Return neutral score (50, confidence 0.1) and log error

#### 5.1.7 Files Affected

| File | Change |
|------|--------|
| `extension/src/content/analysers/visual-emotion-analyser.ts` | **Full rewrite** — remove all face-api.js logic, implement CLIP zero-shot scoring |
| `extension/src/content/models/model-manager.ts` | Add CLIP model loading/unloading lifecycle, inactivity timer, WebGPU detection |
| `extension/src/content/models/model-hashes.ts` | Remove face-api hashes, add CLIP vision encoder SHA-256 |
| `extension/package.json` | Remove `@vladmandic/face-api`, evaluate if `@tensorflow/tfjs` is still needed |
| `extension/public/manifest.json` | No change needed (`/models/*` already in `web_accessible_resources`) |

---

### 5.2 R2: Pre-Computed CLIP Text Embeddings

**Priority:** P0 (Critical — blocks R1)

#### 5.2.1 Build-Time Script

Create `extension/scripts/precompute-clip-embeddings.ts`:

1. Load full CLIP model (text + vision) in Node.js via Transformers.js
2. Encode the 10 classification prompts from R1 → array of 512-dim Float32Arrays
3. Output to `extension/public/models/clip-text-embeddings.json`
4. Format: `{ prompts: string[], embeddings: number[][] }` (~40KB)

#### 5.2.2 Runtime Loading

- Load `clip-text-embeddings.json` on first analysis (alongside CLIP vision encoder)
- Cache in memory (tiny footprint — 10 × 512 × 4 bytes = 20KB)
- No text encoder loaded at runtime

#### 5.2.3 Prompt Tuning Workflow

To adjust detection sensitivity:
1. Edit prompt list in the build script
2. Run `npm run precompute-embeddings`
3. Rebuild extension (`npm run build`)
4. Reload in Chrome

#### 5.2.4 Files Affected

| File | Change |
|------|--------|
| `extension/scripts/precompute-clip-embeddings.ts` | **New file** |
| `extension/public/models/clip-text-embeddings.json` | **New file** (generated) |
| `extension/package.json` | Add `precompute-embeddings` script |

---

### 5.3 R3: Enhanced Colour Histogram Fallback

**Priority:** P1 (Required — provides fallback when CLIP/WebGPU unavailable)

#### 5.3.1 Current State

`image-analyser.ts` computes: 50% darkness + 30% desaturation + 20% red intensity. Confidence fixed at 0.3.

#### 5.3.2 Enhancements

Add three new metrics to the existing histogram analysis:

1. **Contrast analysis:** Standard deviation of per-pixel brightness. Low contrast (flat, muted) correlates with depressive imagery. High contrast (sharp edges, stark lighting) can correlate with intense/disturbing content.

2. **Edge density:** Simple 3×3 Sobel approximation on brightness channel. High edge density in small regions may indicate text overlays or graphic content. Compute as percentage of pixels exceeding a gradient threshold.

3. **Dominant colour clustering:** k-means (k=3) on sampled RGB pixels. Detect monochromatic palettes (all-black, all-grey, red-dominated) which correlate with distress content. Diversity of palette reduces risk signal.

#### 5.3.3 Revised Scoring Formula

```
darknessScore      = (1 - avgBrightness) × 100                    (existing)
desaturationScore  = (1 - avgSaturation) × 100                    (existing)
redScore           = redRatio × 100                                (existing)
contrastScore      = map(stdBrightness, [low→high], [60→30])      (new)
edgeDensityScore   = map(edgeRatio, [0→0.3], [30→70])             (new)
monochromeScore    = (1 - colourDiversity) × 100                   (new)

final = 0.30 × darkness + 0.15 × desaturation + 0.10 × red
      + 0.20 × contrast + 0.15 × edgeDensity + 0.10 × monochrome
```

Confidence remains low (0.3-0.4) since this is still a heuristic, but the signal is richer.

#### 5.3.4 Files Affected

| File | Change |
|------|--------|
| `extension/src/content/image-analyser.ts` | Add contrast, edge density, colour clustering metrics; revise scoring formula |

---

### 5.4 R4: Update Video Analyser

**Priority:** P0 (Critical — video stories are common)

#### 5.4.1 Changes

- Replace `visualAnalyser.scoreCapturedFrame(imageData)` calls with the new CLIP-based `visualAnalyser.analyse(imageData)`
- 3-frame sampling strategy (offsets [0s, 0.5s, 1.5s]) stays unchanged
- Median aggregation stays unchanged
- Seek timeout (300ms per frame) stays unchanged

#### 5.4.2 Timing Budget

- 3 frames × ~80ms CLIP inference (WebGPU) = ~240ms
- Plus seek overhead: ~300ms worst case
- Total: ~540ms — borderline for 500ms target but acceptable (P95, not P50)
- WebGL fallback: 3 × ~250ms = 750ms — exceeds target, consider reducing to 2 frames on WebGL

#### 5.4.3 Files Affected

| File | Change |
|------|--------|
| `extension/src/content/analysers/video-analyser.ts` | Update model reference and interface call |

---

### 5.5 R5: Broaden DOM Text Selectors

**Priority:** P1 (Required — free improvement to text modality)

#### 5.5.1 Current Selectors

```typescript
viewer.querySelectorAll('span[dir="auto"], div[dir="auto"]')
```

This misses interactive text elements that Instagram does render in DOM.

#### 5.5.2 Additional Selectors

Broaden `extractText()` in `text-analyser.ts` to also capture:

- **Sticker text containers:** `div[data-testid*="sticker"]`, elements with sticker-related aria-labels
- **Music/song title overlays:** elements containing music metadata (artist, song title)
- **Location tag text:** location sticker text content
- **Poll/question sticker text:** interactive sticker content
- **Hashtag and mention text:** `a[href*="/explore/tags/"]`, `a[href*="/"]` within story context
- **aria-label attributes:** Some story elements carry descriptive labels (e.g., "Photo by username")

#### 5.5.3 Exclusion List Update

Ensure the existing UI text filter (sponsored, learn more, shop now, etc.) still applies to new selectors to avoid false signal from Instagram chrome.

#### 5.5.4 Files Affected

| File | Change |
|------|--------|
| `extension/src/content/text-analyser.ts` | Broaden `extractText()` with additional DOM selectors |

---

### 5.6 R6: Clean Up Model Bundle Bloat

**Priority:** P0 (Critical — immediate 306MB saving)

#### 5.6.1 Current State

`extension/public/models/Xenova/all-MiniLM-L6-v2/onnx/` contains 8 ONNX variants (329MB total). Only `model_quantized.onnx` (22MB) is loaded by Transformers.js.

#### 5.6.2 Action

Delete from `extension/public/models/Xenova/all-MiniLM-L6-v2/onnx/`:
- `model.onnx` (90MB) — FP32
- `model_bnb4.onnx` (54MB) — BNB4 quantized
- `model_fp16.onnx` (45MB) — FP16
- `model_int8.onnx` (23MB) — INT8 (duplicate of quantized)
- `model_q4.onnx` (55MB) — Q4
- `model_q4f16.onnx` (30MB) — Q4F16
- `model_uint8.onnx` (23MB) — UINT8

Keep only: `model_quantized.onnx` (22MB)

#### 5.6.3 Remove face-api.js Model Files

After CLIP replaces face-api.js:
- Delete `extension/public/models/faceapi/` directory (~0.5MB)
- Remove face-api SHA-256 hashes from `model-hashes.ts`

#### 5.6.4 Add CLIP Model Files

- Download CLIP ViT-B/32 INT8 vision encoder ONNX to `extension/public/models/Xenova/clip-vit-base-patch32/`
- Generate SHA-256 hash, add to `model-hashes.ts`

#### 5.6.5 Files Affected

| File | Change |
|------|--------|
| `extension/public/models/Xenova/all-MiniLM-L6-v2/onnx/` | Delete 7 files |
| `extension/public/models/faceapi/` | Delete directory |
| `extension/public/models/Xenova/clip-vit-base-patch32/` | **New directory** — CLIP model files |
| `extension/public/models/clip-text-embeddings.json` | **New file** — pre-computed embeddings |
| `extension/public/models/README.md` | Update download instructions |

---

### 5.7 R7: Update Documentation

**Priority:** P2 (Cleanup)

Update `CLAUDE.md` to reflect:
- Corrected model sizes (22MB MiniLM, not "6.5MB")
- New model table (CLIP replaces face-api.js)
- Updated tech stack table
- Revised model budget (120MB)
- Updated analysis pipeline description
- Updated known issues (remove face-api limitations, add WebGPU requirement)
- Updated testing checklist

---

## 6. Architecture: Revised Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│ Story Detection (unchanged)                                      │
│ → MutationObserver detects story viewer → extract viewer element │
└────────────────┬────────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────────┐
│ Parallel Modality Analysis                                       │
│                                                                  │
│  TEXT (35% base weight) — IMPROVED INPUT                         │
│  ├─ extractText() with broadened DOM selectors (R5)              │
│  ├─ Keyword fast-path (< 2ms, unchanged)                        │
│  └─ MiniLM-L6-v2 cosine similarity (unchanged model)            │
│                                                                  │
│  VISUAL (25% base weight) — NEW MODEL                           │
│  ├─ CLIP ViT-B/32 zero-shot vs 10 prompts (40-100ms, WebGPU)   │
│  └─ Fallback: enhanced colour histogram (R3)                    │
│                                                                  │
│  TEMPORAL (20% base weight) — UNCHANGED                         │
│  └─ Ring buffer: rising trends, bursts, sustained highs         │
│                                                                  │
│  VIDEO (15% base weight) — UPDATED MODEL REF                    │
│  └─ 3-frame CLIP sampling, median aggregation                   │
│                                                                  │
│  METADATA (5% base weight) — UNCHANGED                          │
│  └─ DOM scraping: close-friends, reply-disabled, etc.           │
└────────────────┬────────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────────┐
│ Fusion & Scoring (unchanged algorithm)                           │
│ → Bayesian confidence-weighted composite (0-100)                 │
│ → Weight calibration via social worker confirmation loop         │
│ → Critical signal override (score ≥90, confidence ≥0.8 → ≥75)  │
└────────────────┬────────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────────┐
│ Privacy Cleanup (unchanged)                                      │
│ → Zero pixel buffers, dispose tensors, release strings           │
└────────────────┬────────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────────┐
│ Output (unchanged)                                               │
│ → Overlay if score ≥ threshold                                   │
│ → Transmit {composite, modality_scores, username, timestamp}     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Privacy & Security

### 7.1 Privacy Invariant (Unchanged)

The core privacy guarantee is preserved:

- CLIP inference runs **entirely in-browser** using bundled ONNX weights
- No image, video, text, or embedding data leaves the device
- Canvas pixel buffers are zeroed after each inference (`imageData.data.fill(0)`)
- CLIP output is a 512-dim embedding — but this embedding is **never transmitted or stored**. Only the derived numerical risk score (0-100) is kept.
- Pre-computed prompt embeddings are static constants (not user data)

### 7.2 Model Security

- CLIP model files are bundled at build time (no runtime CDN downloads)
- SHA-256 hash verification on first load (existing mechanism)
- Inference-only: no training, no gradient computation
- CSP remains `'self' 'wasm-unsafe-eval'` — no changes needed

### 7.3 New Consideration: WebGPU

CLIP requires WebGPU for acceptable performance. WebGPU is available in Chrome 113+ (stable since March 2023). Security implications:

- WebGPU runs shader code on the GPU — this is standard browser behaviour, not a new attack surface
- Model weights in GPU memory are isolated by the browser's GPU process sandbox
- No additional permissions required in `manifest.json`

---

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CLIP false positives on dark aesthetics, horror content, moody photography | High | Medium — social workers see false alerts | Negative anchor prompts (happy, neutral, fun) in zero-shot set. Confidence-weighted fusion dampens low-confidence visual scores. Social workers can dismiss false positives; calibration loop will adjust weights over time. |
| WebGPU unavailable on target devices | Low | High — CLIP unusable | Enhanced histogram fallback (R3) provides degraded-but-functional visual scoring. Log WebGPU availability to monitor fleet. |
| 87MB CLIP model causes memory pressure on low-RAM devices | Medium | Medium — 500MB guard triggers model unload | Memory monitor already polls every 30s and unloads models. CLIP unloads gracefully; histogram fallback activates. Consider reducing video frames from 3→2 to lower peak memory. |
| Transformers.js `zero-shot-image-classification` pipeline loads both CLIP encoders despite pre-computed embeddings | Medium | High — doubles model memory to ~170MB | Research during implementation: may need to load CLIP vision encoder directly via ONNX Runtime Web instead of Transformers.js pipeline API. Fallback: use pipeline API but accept the memory cost. |
| CLIP ONNX model not available in INT8 for `Xenova/clip-vit-base-patch32` | Low | Medium — FP32 model is ~340MB | Check HuggingFace model hub during implementation. Alternatives: `Xenova/openclip-vit-base-patch32`, or quantize FP32→INT8 using `optimum` CLI. |
| Instagram DOM changes break broadened text selectors | High | Low — text reverts to current (near-empty) behaviour | Selectors are additive (R5 adds to, not replaces, existing selectors). Worst case is no regression from current state. |

---

## 9. Estimated Bundle Size

| Component | Before | After |
|-----------|--------|-------|
| MiniLM-L6-v2 (all variants) | 329MB | 22MB (1 variant) |
| face-api.js models | 0.5MB | 0MB (removed) |
| CLIP ViT-B/32 vision encoder (INT8) | 0MB | ~87MB (new) |
| Pre-computed text embeddings | 0MB | ~40KB (new) |
| **Total models** | **329MB** | **~110MB** |
| Other extension code + assets | ~5MB | ~5MB |
| **Total extension** | **~334MB** | **~115MB** |

Net change: **-219MB** (65% reduction despite adding a larger model).

---

## 10. Performance Targets

| Metric | Current | Target | Notes |
|--------|---------|--------|-------|
| Image story pipeline | 100-300ms | 110-340ms | Slight increase acceptable for vastly better coverage |
| Video story pipeline | 200-600ms | 230-540ms | Comparable; CLIP is faster per-frame than face-api on WebGPU |
| Model first-load | ~2s (MiniLM) | ~8s (MiniLM + CLIP) | One-time cost, cached in IndexedDB |
| Memory (models loaded) | ~25MB | ~120MB | Within 500MB guard headroom |
| Bundle size | 329MB | ~115MB | 65% reduction |

---

## 11. Implementation Sequence

| Order | Requirement | Depends On | Effort |
|-------|------------|------------|--------|
| 1 | R6: Clean up model bloat | None | Small — delete files |
| 2 | R2: Pre-compute CLIP text embeddings script | None | Small — build script |
| 3 | R1: Replace face-api with CLIP in visual analyser | R2, R6 | Large — full rewrite |
| 4 | R4: Update video analyser | R1 | Small — interface swap |
| 5 | R3: Enhanced colour histogram fallback | None | Medium — add 3 metrics |
| 6 | R5: Broaden DOM text selectors | None | Small — add selectors |
| 7 | R7: Update documentation | R1-R6 | Small — text updates |

R3, R5, and R6 can be done in parallel with R1/R2.

---

## 12. Verification & Testing

### 12.1 Build Verification
- `cd extension && npm run build` compiles without errors
- `dist/` directory size is < 130MB
- No face-api references remain in compiled output

### 12.2 Model Loading
- Load extension in Chrome with DevTools open
- Console shows "CLIP vision encoder loaded" (not face-api)
- Check `performance.memory.usedJSHeapSize` stays under 400MB with both models loaded
- Verify WebGPU backend selected (console log)

### 12.3 Scoring Quality
Test with representative images:
- **Dark/gloomy scene** (no faces) → expect score > 60 (currently ~45 from histogram)
- **Person crying** → expect score > 70 (currently may miss if face angle is off)
- **Happy group photo** → expect score < 40 (currently unreliable)
- **Text overlay "I can't do this anymore"** → CLIP may partially detect; combined with any DOM text available, expect score > 55
- **Neutral selfie** → expect score 35-50
- **Same story scored twice** → expect same score (deterministic)

### 12.4 Fallback Behaviour
- Disable WebGPU in Chrome flags → verify enhanced histogram runs with confidence 0.3-0.4
- Trigger 500MB memory guard → verify models unload and scoring continues via histogram

### 12.5 Video Stories
- Open video story → verify 3 frames captured and scored via CLIP
- Check total pipeline time in Performance tab → target < 600ms on WebGPU

### 12.6 Privacy Audit
- Set breakpoint after `analyse()` completes → verify no ImageData, tensor, or embedding references survive in memory
- Check network tab → verify no outbound requests besides score transmission to localhost:8000

### 12.7 Text Selector Improvement
- Open story with visible sticker text/hashtags/mentions → verify `extractText()` returns content
- Verify UI text exclusion (sponsored, learn more) still filters correctly

---

## 13. Future Considerations (Out of Scope)

| Item | Why Deferred |
|------|-------------|
| Fine-tuned MobileNetV3 (~3-5MB, same accuracy as CLIP zero-shot) | Requires ML training infrastructure; revisit when scoring data is available |
| EAST text detector for text-region presence signals | Additive improvement; can layer on top of CLIP later |
| SigLIP or MobileCLIP variants | Wait for Transformers.js ONNX export maturity; may enable smaller models |
| Prompt tuning based on confirmed case data | Needs sufficient confirmation volume; calibration loop provides partial benefit now |
| Chrome Web Store distribution | Requires model hosting/CDN strategy for 87MB+ models |

---

## 14. False Positive Prompt Training (Future)

**Status:** Not in scope for this overhaul. Documented here for planning when sufficient field data is available.

### 14.1 Problem

CLIP zero-shot classification uses a fixed set of 10 prompts (Section 5.1.2). These prompts are designed generically and will produce systematic false positives for content categories that are visually similar to distress but contextually benign in youth social media. Examples:

- **Dark aesthetic / lo-fi photography** — intentionally moody but not distressing
- **Horror/thriller fan content** — fandom engagement, not personal crisis
- **Late-night party photos** — dark + red lighting matches histogram heuristics
- **Artistic grief expression** — processing past events, not active crisis
- **Promotional content with dark themes** — music, gaming, film

Over time, social workers will encounter recurring false positive patterns that waste their triage time and erode trust in the tool.

### 14.2 Proposed Approach

#### 14.2.1 False Positive Signal Collection

Extend the existing calibration feedback loop (backend `/api/v1/accounts/{username}/confirm`) to capture **negative** feedback:

- Add a **"Not a concern"** button alongside the existing **"Confirm Case"** button on the dashboard
- When a social worker dismisses a case, record: `{ username, dismissed_at, score_snapshot, modality_scores }`
- Treat this as a false positive signal; store in `dismissals` Redis sorted set (same 24h TTL)
- Expose via `GET /api/v1/dismissals?since={ms_epoch}` (API key protected, same pattern as confirmations)

#### 14.2.2 Prompt Refinement Workflow

When enough dismissal data accumulates (suggested threshold: 50+ dismissals), a prompt engineer or ML engineer should:

1. **Export dismissal metadata** — composite score snapshots and modality breakdown for dismissed cases
2. **Identify systematic patterns** — cluster dismissed cases by score signature (e.g. high visual, low text, low temporal = aesthetic photography)
3. **Add targeted negative anchor prompts** — examples:
   - `"dark moody aesthetic photography with no distress"`
   - `"horror or gothic fan art"`
   - `"concert or festival photography with low lighting"`
   - `"artistic black-and-white portrait"`
4. **Re-run `npm run precompute-embeddings`** with the updated prompt list
5. **Rebuild and reload extension** — no model retraining required, prompt changes take effect immediately

#### 14.2.3 Prompt Governance

| Rule | Rationale |
|------|-----------|
| Distress prompts require consensus from ≥2 social workers before removal | Avoid over-suppressing genuine risk signals |
| Negative anchor prompts can be added freely | Only reduce false positives; cannot suppress confirmed-distress content |
| Maximum prompt set size: 20 (10 distress + 10 anchors) | Softmax over larger sets dilutes per-prompt probability; diminishing returns |
| Prompts must be reviewed every 6 months | Social media aesthetics evolve; prompts need to stay current |
| All prompt changes version-controlled in `precompute-clip-embeddings.ts` | Audit trail for clinical/ethical review |

#### 14.2.4 Automated Calibration vs. Prompt Training

The existing weight calibration loop (Section 5.2 of CLAUDE.md, `weight-calibrator.ts`) adjusts **per-modality weights** based on social worker confirmations. This is a distinct and complementary mechanism:

| Mechanism | What it adjusts | Timescale | Requires |
|-----------|----------------|-----------|---------|
| Weight calibration | Modality trust (visual vs text vs temporal) | Real-time, per confirmation | Nothing — already implemented |
| Prompt training | CLIP classification prompts (what "distress" looks like) | Manual, when data accumulates | Build step + reload |

Weight calibration can suppress the visual modality if it is consistently unreliable for a social worker's caseload. Prompt training targets specific systematic CLIP misclassifications that calibration alone cannot fix (e.g., all dark aesthetic photos score high, regardless of weight).

#### 14.2.5 Trigger Criteria

Begin the prompt training process when **any** of the following are observed:

- ≥50 dismissed cases within a 30-day window where visual modality was the top contributor (modality_scores.visual > 70, composite dismissed)
- Social workers report a recognisable false positive pattern verbally (e.g., "it keeps flagging band photos")
- Composite score standard deviation drops below 12 after initial deployment (indicates CLIP is still scoring too many stories into a narrow range)

### 14.3 Files Affected (When Implemented)

| File | Change |
|------|--------|
| `backend/app/main.py` | Add `POST /api/v1/accounts/{username}/dismiss` and `GET /api/v1/dismissals` endpoints |
| `backend/app/models.py` | Add `DismissalEntry` Pydantic schema |
| `dashboard/src/app/` | Add "Not a concern" button alongside "Confirm Case" |
| `dashboard/src/lib/` | Add `dismissCase()` API client method |
| `extension/scripts/precompute-clip-embeddings.ts` | Extend prompt list when new anchors are added |
| `extension/public/models/clip-text-embeddings.json` | Regenerated output |
