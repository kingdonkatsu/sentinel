export function riskColor(score: number): string {
  if (score >= 85) return "bg-red-600 text-white";
  if (score >= 70) return "bg-orange-500 text-white";
  if (score >= 50) return "bg-yellow-500 text-black";
  return "bg-slate-600 text-slate-200";
}

export function riskLabel(score: number): string {
  if (score >= 85) return "CRITICAL";
  if (score >= 70) return "HIGH";
  if (score >= 50) return "MODERATE";
  return "LOW";
}

export function riskBorderColor(score: number): string {
  if (score >= 85) return "border-red-600";
  if (score >= 70) return "border-orange-500";
  if (score >= 50) return "border-yellow-500";
  return "border-slate-600";
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
  if (trend === "rising") return "text-red-400";
  if (trend === "declining") return "text-green-400";
  return "text-slate-400";
}
