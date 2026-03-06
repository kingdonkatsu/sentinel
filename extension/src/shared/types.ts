export interface RiskScore {
  composite: number;
  textScore: number;
  imageScore: number;
  timestamp: number;
  username: string;
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
}

export const DEFAULT_CONFIG: StoredSentinelConfig = {
  sentinel_api_url: "http://localhost:8000",
  sentinel_api_key: "sentinel-hackathon-key",
  sentinel_threshold: 70,
  sentinel_weights: { image: 0.5, text: 0.5 },
};
