const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export interface AccountSummary {
  username: string;
  latest_composite: number;
  max_composite: number;
  score_count: number;
  latest_text_score: number | null;
  latest_image_score: number | null;
  last_seen: number;
  trend: string;
}

export interface ScoreDetail {
  composite: number;
  text_score: number | null;
  image_score: number | null;
  timestamp: number;
}

export interface AccountDetail extends AccountSummary {
  scores: ScoreDetail[];
}

export interface OutreachSuggestion {
  opening: string;
  follow_ups: string[];
  tone_note: string;
}

export async function fetchDashboard(limit = 50): Promise<AccountSummary[]> {
  const res = await fetch(`${API_URL}/api/v1/dashboard?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch dashboard");
  return res.json();
}

export async function fetchAccountDetail(
  username: string
): Promise<AccountDetail> {
  const res = await fetch(`${API_URL}/api/v1/dashboard/${username}`);
  if (!res.ok) throw new Error("Failed to fetch account detail");
  return res.json();
}

export async function fetchOutreachSuggestion(
  compositeScore: number,
  textScore: number,
  imageScore: number
): Promise<OutreachSuggestion> {
  const res = await fetch(`${API_URL}/api/v1/outreach/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      composite_score: compositeScore,
      text_score: textScore,
      image_score: imageScore,
    }),
  });
  if (!res.ok) throw new Error("Failed to fetch outreach suggestion");
  return res.json();
}

export async function confirmCase(username: string): Promise<void> {
  const apiKey = process.env.NEXT_PUBLIC_API_KEY || "sentinel-hackathon-key";
  const res = await fetch(`${API_URL}/api/v1/accounts/${username}/confirm`, {
    method: "POST",
    headers: { "X-Sentinel-Key": apiKey },
  });
  if (!res.ok) throw new Error("Failed to confirm case");
}

export function getScoreFeedUrl(): string {
  return `${API_URL}/api/v1/scores/feed`;
}
