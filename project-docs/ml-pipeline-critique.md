# Sentinel ML Pipeline — Critical Analysis

**Date:** 2026-03-09
**Analyst:** Claude (Opus 4.6)
**Scope:** All 5 modality analysers, fusion algorithm, calibration loop, model choices, and code correctness

---

## Executive Summary

The pipeline architecture is **well-designed conceptually** — privacy-first in-browser inference, confidence-weighted Bayesian fusion, and a calibration feedback loop are all sound ideas. However, the implementation has **significant accuracy problems** that would undermine real-world deployment for mental health detection, a domain where false negatives can be dangerous and false positives erode trust.

**Verdict:** The models chosen are reasonable given browser constraints (~6.5MB budget), but several are being **used incorrectly or scored with flawed logic**. The biggest risks are in the text and visual analysers — the two highest-weighted modalities.

---

## Part 1: Model Selection Critique

### Text: MiniLM-L6-v2 (35% weight) — GOOD CHOICE, POOR APPLICATION

**Model fit:** MiniLM-L6-v2 is a solid general-purpose sentence embedding model. At ~6MB (ONNX int8), it's one of the best options for in-browser semantic similarity. It captures meaning well enough to distinguish "I want to die" from "I'm dying of laughter" — in theory.

**Problem:** The model is used for **cosine similarity against 50 fixed reference phrases**. This is essentially a nearest-neighbour classifier with 50 anchors. It works for clear-cut distress signals but breaks down for:
- **Ambiguous language:** "I'm done" (tired? suicidal?) — similarity to "I just want it all to stop" might be 0.6, producing a middling score with no clear signal
- **Cultural slang:** "I'm dead" (Gen Z for "that's funny") will match strongly against Tier 1 suicidal ideation phrases
- **Coded language:** Tier 5 phrases like "3am thoughts again" are clever but MiniLM similarity to "I've been cutting myself" would be low — the model can't bridge that semantic gap without fine-tuning

**Better alternative:** A fine-tuned classifier (e.g., DistilBERT trained on crisis text data) would outperform similarity matching. But this would be ~30MB+ and impractical in-browser. Given constraints, MiniLM is the right model — the application method (cosine similarity vs fixed phrases) is the weak link.

---

### Visual: face-api.js TinyFaceDetector + FaceExpressionNet (25% weight) — MEDIOCRE CHOICE

**Model fit:** TinyFaceDetector (~190KB) is fast but **less accurate than modern detectors** (e.g., BlazeFace, MediaPipe Face Detection). FaceExpressionNet classifies 7 emotions trained primarily on **posed, frontal, well-lit adult faces** (FER2013 / AffectNet datasets).

**Critical problems:**
1. **Youth faces:** The model was NOT trained on adolescent expressions. Teens express distress differently from adults — more masked, more subtle. The model has no data on this demographic.
2. **Instagram Stories context:** Stories feature heavy filters, stickers, overlaid text, unusual angles, and lighting effects. FaceExpressionNet was trained on clean portrait photos. Accuracy degrades significantly with:
   - Snapchat/Instagram filters (dog ears, face morphs)
   - Dramatic lighting (neon, flash, backlit)
   - Partial face occlusion (hand over mouth, sunglasses)
   - Non-frontal angles (selfie angles are typically 15-30 degrees off-center)
3. **Expression ≠ Emotion:** A person posting a sad-looking selfie might be doing it ironically. A genuinely distressed person might smile in their Story. Facial expression recognition is a **weak proxy for internal emotional state**, especially in curated social media content.
4. **Cultural bias:** FER2013 is predominantly Western faces. Expression norms vary by culture — what reads as "neutral" in East Asian cultures may score differently than Western "neutral".

**Better alternative:** MediaPipe Face Mesh (available in TF.js, ~2MB) provides 468 landmarks and could detect micro-expressions. But the fundamental issue is that **facial expression is a weak signal for mental health on social media** — the model choice matters less than the modality choice itself.

---

### Temporal: Ring Buffer Heuristics (20% weight) — APPROPRIATE

**Model fit:** No model needed. Simple pattern detection (rising trends, bursts, late-night posting, sustained high scores) is the right approach for temporal signals. Over-engineering with an RNN or time-series model would be unjustified for 20 data points.

**The heuristics are reasonable but the scoring thresholds are arbitrary** (see Part 2).

---

### Video: 3-Frame Sampling via Visual Analyser (15% weight) — QUESTIONABLE

**Model fit:** Reuses the face expression model on 3 sampled frames. This is architecturally efficient but inherits all visual analyser weaknesses plus:
- **3 frames from a 15-second Story is extreme undersampling** — captures 0.2% of visual content
- **Max-score strategy** (take the worst frame) is biased toward false positives — a single frame of a neutral face being mis-classified as "sad" drives the entire video score
- Video Stories often contain rapid transitions, text overlays, and effects that confuse static-image models

**Better alternative:** For the 15% weight and browser constraint, a simple motion/activity heuristic (frame differencing to detect agitation vs. stillness) would be more informative than running a flawed expression model 3 times.

---

### Metadata: DOM Scraping (5% weight) — APPROPRIATE BUT FRAGILE

**Model fit:** Correct approach — DOM signals don't need ML. Close-friends status, disabled replies, and late-night posting are genuine contextual signals.

**Problem:** Implementation relies on hardcoded CSS selectors and color values (`rgb(74, 230, 140)` for close-friends ring) that Instagram changes regularly. This modality will **silently break** when Instagram updates their frontend.

---

## Part 2: Implementation Bugs & Logic Flaws

### CRITICAL Issues

#### 1. Keyword Analyser Uses Substring Matching
**File:** `extension/src/content/text-analyser.ts`
```typescript
if (lower.includes(keyword)) { totalScore += weight; }
```
`"kill"` matches `"skill"`, `"thankfully"`, `"killer"`. `"die"` matches `"diet"`, `"diesel"`, `"audience"`. For a mental health tool, this produces dangerous false positives and erodes social worker trust.

**Fix:** Use word-boundary regex (`/\bkill\b/i`) instead of `includes()`.

---

#### 2. No Negation Handling
**Files:** `extension/src/content/text-analyser.ts`, `extension/src/content/analysers/semantic-text-analyser.ts`

"I'm NOT going to hurt myself" and "I'm going to hurt myself" produce nearly identical scores in both the keyword path (matches "hurt") and the semantic path (MiniLM embeddings don't reliably separate negated vs. non-negated intent). This is a **fundamental accuracy failure** for the highest-weighted modality.

**Fix:** Add a negation detection step — check for "not/no/never/don't/won't" within N words before distress keywords. Reduce score by 30-50% when negation is detected.

---

#### 3. Multi-Face Blending Weights Are Inverted
**File:** `extension/src/content/analysers/visual-emotion-analyser.ts`
```typescript
const mlWeight = mlResult.faceCount >= 2 ? 0.5 : 0.7;
```
With 2+ faces detected, the code trusts the ML model LESS (50%) and the colour histogram MORE (50%). This is backwards — more faces = more evidence = higher ML trust. The heuristic should be the fallback, not an equal partner.

**Fix:** Swap the weights: `mlResult.faceCount >= 2 ? 0.7 : 0.5` (or even `0.8 : 0.6`).

---

#### 4. Video Analyser Captures Frames Redundantly
**File:** `extension/src/content/analysers/video-analyser.ts`

The code draws a video frame to a canvas, then calls `visualAnalyser.analyse(viewer)`, which **re-captures from the video element** rather than using the already-drawn canvas. The drawn canvas is wasted. This doubles the capture work and may capture a different frame than intended (race condition if video is playing).

**Fix:** Pass the already-captured ImageData or canvas directly to the visual analyser instead of having it re-capture.

---

### HIGH Issues

#### 5. Face Area Weighting Is Unbounded
**File:** `extension/src/content/analysers/visual-emotion-analyser.ts`
```typescript
const faceWeight = Math.max(1, box.width * box.height) * detection.detection.score;
```
A face covering 50% of the frame gets ~1000x the weight of a small face in the background. In group photos, one large face completely dominates all others.

**Fix:** Normalize by total image area or cap the face weight ratio (e.g., max 10x between largest and smallest face).

---

#### 6. Similarity-to-Score Mapping Is Arbitrary
**File:** `extension/src/content/analysers/semantic-text-analyser.ts`
```typescript
const semanticScore = Math.round(Math.max(0, Math.min(100, (maxSimilarity - 0.3) / 0.55 * 100)));
```
Maps cosine similarity [0.3, 0.85] → score [0, 100]. The bounds 0.3 and 0.85 have **no stated justification**. Different embedding models produce different similarity distributions. Without calibrating these thresholds against labeled data, the scoring could be systematically too high or too low.

**Fix:** Document the rationale, or better yet, run the embedding model against a labeled test set and calibrate the mapping empirically.

---

#### 7. Confidence Calculation Is Too Coarse
**File:** `extension/src/content/analysers/semantic-text-analyser.ts`

Three discrete buckets (0.5, 0.7, 0.9) with sharp boundaries. Similarity of 0.699 gets confidence 0.7; similarity of 0.700 gets 0.9 — a 28% jump from a 0.001 difference.

**Fix:** Use a continuous function: `confidence = 0.5 + 0.4 * Math.min(1, (similarity - 0.3) / 0.5)`.

---

#### 8. Late-Night Detection Uses Current Time, Not Story Time
**Files:** `extension/src/content/analysers/metadata-analyser.ts`, `extension/src/content/analysers/temporal-analyser.ts`
```typescript
const hour = new Date().getHours();
return hour >= 0 && hour < 5;
```
If a social worker reviews Stories at 3 AM, ALL stories get the late-night bonus (+12 in metadata, +12 in temporal). The detection should use the story's timestamp, not the viewing time.

**Fix:** Extract the story's posting time from Instagram's DOM or API data, or remove the late-night signal if posting time is unavailable.

---

#### 9. Expression Risk Weights Lack Evidence Base
**File:** `extension/src/content/analysers/visual-emotion-analyser.ts`

`sad = 0.90`, `fearful = 0.85`, `angry = 0.70` — these are hand-tuned with no reference to clinical literature. In youth mental health, **anger often masks depression** and should arguably weight higher than 0.70. The relative ordering and magnitude matter enormously for a detection system and should be validated against clinical data.

**Fix:** Cite clinical literature for weight rationale, or acknowledge these are heuristic and adjust based on calibration feedback.

---

#### 10. Max-Frame Strategy for Video
**File:** `extension/src/content/analysers/video-analyser.ts`

Taking the maximum risk score from 3 frames means a single mis-classified frame drives the entire video score. A 15-second happy video with one ambiguous frame could score as high-risk.

**Fix:** Use median score, or require 2/3 frames to agree (majority vote), or use 75th percentile.

---

### MEDIUM Issues

#### 11. Composite Scorer Availability Handling
**File:** `extension/src/content/scoring/composite-scorer.ts`

The `fuse()` method filters `available` modalities (line 41), but `unavailableResult()` returns `confidence: 0`, which means unavailable modalities get zero effective weight through the confidence multiplication. **This works by accident** — the availability flag should be explicitly checked in the weight calculation for clarity and correctness.

---

#### 12. Metadata Confidence Is Fixed at 0.5
**File:** `extension/src/content/analysers/metadata-analyser.ts`

Whether 0 or 5 signals fire, confidence is always 0.5. A story with close-friends + reply-disabled + late-night + emoji-only (4 strong signals) should have higher confidence than a story with no signals detected.

**Fix:** Scale confidence with signal count: `confidence = 0.3 + (signalCount * 0.1)`, capped at 0.8.

---

#### 13. Keyword Score Multiplier Penalizes Repetition
**File:** `extension/src/content/text-analyser.ts`

`score = 50 - totalScore * 3` means mentioning "suicide" three times produces a score of 95 vs. 65 for one mention. Repetition doesn't triple the risk — it's the same signal repeated.

**Fix:** Count unique keywords or use diminishing returns: `score = 50 - totalScore * 3 / Math.sqrt(matchCount)`.

---

#### 14. Sarcasm and Irony Are Unhandled

"I'm literally dying" (Gen Z humor) and "I want to die" (genuine distress) will score similarly in both keyword and semantic paths. MiniLM-L6-v2 doesn't distinguish pragmatic intent. This is an inherent limitation but particularly dangerous for a tool targeting youth, who use ironic language heavily.

**Mitigation:** Add a sarcasm indicator list (e.g., "literally dying", "I can't even", "I'm dead") that reduces score when matched alongside humor signals (emoji like 😂, "lmao", "lol").

---

#### 15. Urgency Regex Patterns Are Over-Broad
**File:** `extension/src/content/analysers/distress-phrases.ts`
```typescript
/today\b.*(?:end|stop|done)/i
```
Matches "today I'm done with my homework" as urgent. The patterns need tighter contextual anchoring to avoid false alarms in the highest-severity category.

**Fix:** Add distress-context requirements: `/today\b.*(?:end it|stop the pain|done with (?:life|everything|this world))/i`.

---

## Part 3: Architectural Concerns

### The Fundamental Tension: Privacy vs. Accuracy

The core design decision — score in-browser, discard content, send only numbers — is excellent for privacy but creates a **one-way door for accuracy debugging**. When a social worker sees a score of 82, there's no way to understand why. The modality breakdown helps, but without the original content, you can't:
- Debug why the text analyser scored 90 on a benign Story
- Validate whether the visual analyser correctly detected a sad face vs. misread a filter
- Build a labeled dataset for model improvement

This is a deliberate and defensible tradeoff, but it means **the pipeline can never be systematically improved** without a separate labeled evaluation set.

### Calibration Loop Is Weak

The weight calibrator only adjusts modality weights by ±5% based on whether a social worker confirms a case. This is:
1. **Too coarse:** It adjusts weights, not thresholds or scoring curves. If the text analyser consistently over-scores by 20 points, nudging its weight from 35% to 33% barely helps.
2. **Biased toward confirmed cases:** Social workers only confirm cases they think are real. There's no "false positive" feedback — stories that scored high but were actually fine are never recorded.
3. **Session-scoped:** Calibration resets on browser restart and hard-resets every 7 days. Learnings are never persisted long-term.

### No Ground Truth, No Evaluation

There is **zero testing infrastructure for ML accuracy**. No labeled dataset, no precision/recall metrics, no A/B testing framework. The pipeline produces scores but there's no way to know if those scores are correct. For a mental health detection system, this is a significant gap.

### Fusion Algorithm Is Reasonable but Untested

The 5-step Bayesian fusion (effective weights → normalize → weighted sum → confidence dampening → critical override) is a sensible approach. But the specific parameters (dampening formula, critical threshold of 90/0.8, floor of 75) are all hand-tuned with no validation. Small changes to these parameters could dramatically shift the system's sensitivity vs. specificity tradeoff.

---

## Part 4: Summary Scorecard

| Component | Model Choice | Implementation | Overall |
|-----------|-------------|----------------|---------|
| **Text (Semantic)** | Good (MiniLM is best option given constraints) | Poor (substring matching, no negation, arbitrary thresholds) | **Needs Work** |
| **Text (Keyword fallback)** | N/A (heuristic) | Poor (substring matching, no word boundaries) | **Critical Fix Needed** |
| **Visual (Emotion)** | Mediocre (not trained on youth/social media) | Poor (inverted face weights, unbounded area, coarse confidence) | **Needs Work** |
| **Temporal** | Good (heuristics appropriate) | Fair (arbitrary thresholds, wrong timestamp source) | **Acceptable** |
| **Video** | Questionable (inherits visual flaws) | Poor (redundant capture, max-frame bias) | **Needs Rethink** |
| **Metadata** | Good (DOM scraping appropriate) | Fair (fragile selectors, fixed confidence) | **Acceptable** |
| **Fusion** | Good (Bayesian weighted approach) | Fair (availability not explicit, untested parameters) | **Acceptable** |
| **Calibration** | Good (feedback loop concept) | Fair (too coarse, no negative feedback, session-scoped) | **Acceptable** |

---

## Part 5: Recommended Fixes (Priority Order)

### Must-Fix (Critical for Accuracy)
1. **Fix keyword matching** — use word-boundary regex instead of `includes()` in `text-analyser.ts`
2. **Add basic negation detection** — check for "not/no/never/don't/won't" before distress keywords in both `text-analyser.ts` and `semantic-text-analyser.ts`
3. **Fix multi-face blending** — trust ML more (not less) with multiple face detections in `visual-emotion-analyser.ts`
4. **Use median/agreement for video** — don't let one outlier frame drive the score in `video-analyser.ts`
5. **Use story timestamp for late-night** — not the current viewing time in `metadata-analyser.ts` and `temporal-analyser.ts`

### Should-Fix (Improves Reliability)
6. **Fix video frame redundant capture** — pass captured canvas to visual analyser directly
7. **Cap face area weight ratio** — prevent one large face from dominating group photos
8. **Make confidence continuous** — replace discrete buckets with smooth functions
9. **Scale metadata confidence** — by number of signals detected
10. **Tighten urgency regex** — add distress-context requirements to prevent false alarms

### Nice-to-Have (Production Hardening)
11. **Add sarcasm/irony detection** — reduce scores when humor signals co-occur with distress keywords
12. **Add "false positive" feedback** — let social workers dismiss cases, feeding negative calibration signal
13. **Persist calibration** — use `chrome.storage.local` instead of session-scoped storage
14. **Create labeled evaluation set** — even 50-100 labeled examples would enable precision/recall measurement
15. **Document all magic numbers** — every threshold, weight, and mapping bound should have a rationale comment

---

## Files Referenced

| File | Role |
|------|------|
| `extension/src/content/analysers/semantic-text-analyser.ts` | MiniLM embedding + cosine similarity scoring |
| `extension/src/content/analysers/visual-emotion-analyser.ts` | face-api.js face detection + expression classification |
| `extension/src/content/analysers/temporal-analyser.ts` | Ring buffer pattern detection |
| `extension/src/content/analysers/video-analyser.ts` | 3-frame video sampling |
| `extension/src/content/analysers/metadata-analyser.ts` | DOM signal scraping |
| `extension/src/content/analysers/distress-phrases.ts` | 50 reference phrases (5 tiers) + urgency patterns |
| `extension/src/content/text-analyser.ts` | Keyword fallback (AFINN-style) |
| `extension/src/content/image-analyser.ts` | Colour histogram heuristic |
| `extension/src/content/scoring/composite-scorer.ts` | Bayesian fusion engine |
| `extension/src/content/scoring/weight-calibrator.ts` | Feedback loop weight adjustment |
| `extension/src/content/models/model-manager.ts` | TF.js + Transformers.js lifecycle |
| `extension/src/content/analysis-pipeline.ts` | Pipeline orchestrator |
