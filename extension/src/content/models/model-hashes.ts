/**
 * Expected SHA-256 hashes for bundled model files.
 * Update these after downloading/updating model weights.
 * Verification runs once on first model load.
 *
 * To generate (bash):
 *   sha256sum public/models/faceapi/tiny_face_detector_model-shard1
 *   sha256sum public/models/faceapi/face_expression_model-shard1
 */
export const MODEL_HASHES: Record<string, string> = {
  "models/faceapi/tiny_face_detector_model-shard1": "b7503ce7df31039b1c43316a9b865cab6a70dd748cc602d3fa28b551503c3871",
  "models/faceapi/face_expression_model-shard1": "9a9840f2cf1f4c7eab95f197512569345c00d2426754d4608b92af30e0300f3d",
};

/**
 * Returns true if hash verification should be skipped for a given path.
 * A blank expected hash means the model hasn't been bundled yet.
 */
export function shouldVerify(modelPath: string): boolean {
  return (MODEL_HASHES[modelPath] ?? "").length > 0;
}
