export interface RiskScore {
  composite: number;
  textScore: number;
  imageScore: number;
  timestamp: number;
  username: string;
}

export interface SentinelConfig {
  apiUrl: string;
  apiKey: string;
  threshold: number;
  weights: {
    image: number;
    text: number;
  };
}

export const DEFAULT_CONFIG: SentinelConfig = {
  apiUrl: "http://localhost:8000",
  apiKey: "sentinel-hackathon-key",
  threshold: 70,
  weights: { image: 0.5, text: 0.5 },
};
