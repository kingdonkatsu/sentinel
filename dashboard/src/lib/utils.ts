export function riskColor(score: number): string {
  if (score >= 85) return "bg-red-500 text-white border border-red-600 shadow-sm shadow-red-200";
  if (score >= 70) return "bg-red-50 text-red-600 border border-red-200";
  if (score >= 50) return "bg-slate-50 text-slate-600 border border-slate-200";
  return "bg-slate-50 text-slate-400 border border-slate-100";
}

export function riskLabel(score: number): string {
  if (score >= 85) return "CRITICAL";
  if (score >= 70) return "HIGH";
  if (score >= 50) return "MODERATE";
  return "LOW";
}

export function riskBorderColor(score: number): string {
  if (score >= 85) return "border-red-500/30";
  if (score >= 70) return "border-red-300/20";
  if (score >= 50) return "border-slate-200";
  return "border-slate-100";
}

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function trendIcon(trend: string): string {
  if (trend === "rising") return "\u2191";
  if (trend === "declining") return "\u2193";
  return "\u2192";
}

export function trendColor(trend: string): string {
  if (trend === "rising") return "text-red-500";
  if (trend === "declining") return "text-emerald-500";
  return "text-slate-500";
}

const MODALITY_ORDER = ["text", "visual", "video", "temporal", "metadata"];

export function modalityLabel(modality: string): string {
  if (modality === "text") return "Text";
  if (modality === "visual") return "Visual";
  if (modality === "video") return "Video";
  if (modality === "temporal") return "Temporal";
  if (modality === "metadata") return "Metadata";
  return modality;
}

export function orderedModalityEntries(
  modalityScores: Record<string, number> | null | undefined
): Array<[string, number]> {
  if (!modalityScores) return [];

  return Object.entries(modalityScores).sort(([left], [right]) => {
    const leftIndex = MODALITY_ORDER.indexOf(left);
    const rightIndex = MODALITY_ORDER.indexOf(right);
    const safeLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const safeRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return safeLeft - safeRight || left.localeCompare(right);
  });
}

export function modalityHint(
  modalityScores: Record<string, number> | null | undefined,
  limit = 3
): string | null {
  const entries = orderedModalityEntries(modalityScores).slice(0, limit);
  if (entries.length === 0) return null;

  return entries.map(([modality, score]) => `${modality} ${score}`).join(" \u00b7 ");
}
