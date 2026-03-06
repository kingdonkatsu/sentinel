# Sentinel Model Files

Models are loaded lazily on first analysis and fall back to heuristics if absent.

---

## Status

| Model | Files | Size | Status |
|-------|-------|------|--------|
| face-api.js TinyFaceDetector | `faceapi/tiny_face_detector_model-*` | ~190 KB | ✅ Downloaded |
| face-api.js FaceExpression | `faceapi/face_expression_model-*` | ~330 KB | ✅ Downloaded |
| MiniLM-L6-v2 (text embeddings) | `Xenova/all-MiniLM-L6-v2/` | ~6 MB (int8) | ✅ Downloaded |

---

## Re-downloading

### face-api.js models (~520 KB total)

```bash
cd extension/public/models/faceapi
BASE="https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights"
for f in \
  tiny_face_detector_model-weights_manifest.json \
  tiny_face_detector_model-shard1 \
  face_expression_model-weights_manifest.json \
  face_expression_model-shard1; do
  curl -fsSL "$BASE/$f" -o "$f"
done
```

### MiniLM-L6-v2 (~6 MB)

```bash
pip install huggingface_hub
python -c "
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id='Xenova/all-MiniLM-L6-v2',
    local_dir='extension/public/models/Xenova/all-MiniLM-L6-v2',
    ignore_patterns=['*.msgpack', '*.h5', 'flax_model*', 'tf_model*', 'pytorch_model*']
)
"
```

---

## After Updating Models

Re-generate SHA-256 hashes and update `src/content/models/model-hashes.ts`:

```bash
sha256sum public/models/faceapi/tiny_face_detector_model-shard1
sha256sum public/models/faceapi/face_expression_model-shard1
```
