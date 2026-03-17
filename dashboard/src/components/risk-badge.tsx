"use client";

import { riskColor, riskLabel } from "@/lib/utils";

export function RiskBadge({ score }: { score: number }) {
  return (
    <span
      className={`px-3 py-1 text-[10px] font-bold rounded mono-text whitespace-nowrap ${riskColor(score)}`}
    >
      {score} ({riskLabel(score)})
    </span>
  );
}
