export interface RiskScore {
  composite: number;
  textScore: number;
  imageScore: number;
  timestamp: number;
  username: string;
  reasoning?: ScoreReasoning;
}

export interface SentinelWeights {
  image: number;
  text: number;
}

export interface StoredSentinelConfig {
  sentinel_api_url: string;
  sentinel_api_key: string;
  sentinel_threshold: number;
  sentinel_weights: SentinelWeights;
}

export interface TransmissionResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface AnalysisResult {
  score: RiskScore;
  imageCaptured: boolean;
  textLength: number;
  transmitted: boolean;
  transmissionError?: string;
  modalityResults?: ModalityResult[];
}

export const DEFAULT_CONFIG: StoredSentinelConfig = {
  sentinel_api_url: "http://localhost:8000",
  sentinel_api_key: "sentinel-hackathon-key",
  sentinel_threshold: 70,
  sentinel_weights: { image: 0.5, text: 0.5 },
};

// ─── Multi-modal analysis types ─────────────────────────────────────────────

export type ModalityType =
  | "visual"
  | "text"
  | "temporal"
  | "video"
  | "audio"
  | "metadata";

export interface ScoreReasoningDriver {
  modality: ModalityType;
  score: number;
  confidence: number;
  weight: number;
  impact: number;
}

export interface ScoreReasoning {
  summary: string;
  confidenceBand: "low" | "medium" | "high";
  topDrivers: ScoreReasoningDriver[];
  caveats: string[];
}

export interface ModalityResult {
  modality: ModalityType;
  /** Risk score 0-100 */
  score: number;
  /** Confidence in the score, 0.0-1.0 */
  confidence: number;
  /** False if the modality had no content to analyse (e.g. no text present) */
  available: boolean;
  inferenceTimeMs: number;
}

/** Common interface all analysers must implement */
export interface Analyser {
  readonly modality: ModalityType;
  analyse(viewer: HTMLElement): Promise<ModalityResult>;
  /** Returns false if this modality is structurally unavailable for the given viewer */
  isAvailable(viewer: HTMLElement): boolean;
  /** Release any loaded models / tensors */
  dispose(): void;
}

/** Extended score sent to backend (backward-compatible with RiskScore) */
export interface RiskScoreV2 extends RiskScore {
  version: 2;
  modalityScores?: Partial<Record<ModalityType, number>>;
  overallConfidence?: number;
}

/** Persisted across stories in chrome.storage.session for weight nudging */
export interface CalibrationState {
  modalityAccuracy: Partial<
    Record<ModalityType, { hits: number; total: number }>
  >;
  /** Unix timestamp of last calibration reset */
  lastCalibrated: number;
  /** Adjusted base weights (deviations from defaults) */
  adjustedWeights?: Partial<Record<ModalityType, number>>;
}
