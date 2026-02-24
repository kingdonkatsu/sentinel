"use client";

import { riskColor, riskLabel } from "@/lib/utils";

export function RiskBadge({ score }: { score: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${riskColor(score)}`}
    >
      {score}
      <span className="opacity-75 text-[10px]">{riskLabel(score)}</span>
    </span>
  );
}
