"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import Link from "next/link";
import { fetchDashboard, type AccountSummary } from "@/lib/api";
import { RiskBadge } from "./risk-badge";
import { useScoreEvents } from "./sse-provider";
import {
  timeAgo,
  trendIcon,
  trendColor,
  riskBorderColor,
  modalityHint,
} from "@/lib/utils";

export function PriorityTable() {
  const {
    data: accounts,
    isLoading,
    error,
    refetch,
  } = useQuery<AccountSummary[]>({
    queryKey: ["dashboard"],
    queryFn: () => fetchDashboard(),
    refetchInterval: 10000,
  });

  const { events, connected } = useScoreEvents();

  // Refetch when new SSE events arrive
  useEffect(() => {
    if (events.length > 0) {
      refetch();
    }
  }, [events.length, refetch]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-slate-400 animate-pulse">
          Loading priority queue...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300 text-sm">
        Failed to connect to Sentinel API. Ensure the backend is running.
      </div>
    );
  }

  if (!accounts || accounts.length === 0) {
    return (
      <div className="bg-slate-800/50 rounded-lg p-8 text-center">
        <p className="text-slate-400 text-lg mb-2">No flagged accounts yet</p>
        <p className="text-slate-500 text-sm">
          Scores will appear here as the extension analyses Instagram Stories.
        </p>
      </div>
    );
  }

  function renderScore(score: number | null) {
    return score ?? "\u2014";
  }

  return (
    <div className="space-y-3">
      {accounts.map((account, index) => {
        const hint = modalityHint(account.latest_modality_scores);

        return (
          <Link
            key={account.username}
            href={`/dashboard/${account.username}`}
            className={`flex items-center justify-between p-6 bg-white border border-border-light rounded-xl hover:border-primary/20 transition-all duration-200 orange-glow group ring-1 ring-transparent hover:ring-primary/5`}
          >
            <div className="flex items-center gap-6">
              {/* Rank/User */}
              <div className="flex flex-col min-w-[120px]">
                <span className="text-sm font-bold mono-text text-black">
                  @{account.username}
                </span>
                <span className="text-[10px] text-slate-500 mono-text uppercase mt-1 opacity-60">
                  Rank #{index + 1}
                </span>
              </div>

              {/* Risk Badge */}
              <RiskBadge score={account.max_composite} />

              {/* Stats */}
              <div className="flex items-center gap-12">
                <div className="flex flex-col">
                  <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider opacity-60">Observations</span>
                  <span className="text-sm font-bold mono-text text-black">{account.score_count}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider opacity-60">Trend</span>
                  <span className={`text-sm font-bold mono-text ${trendColor(account.trend)}`}>
                    {trendIcon(account.trend)} {account.trend.toUpperCase()}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-12">
              {/* Modality Scores */}
              <div className="flex gap-6">
                {account.latest_text_score !== null && (
                  <div className="text-right">
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider opacity-60">Text</p>
                    <p className="text-sm font-bold mono-text text-black">{account.latest_text_score}</p>
                  </div>
                )}
                {account.latest_image_score !== null && (
                  <div className="text-right">
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider opacity-60">Image</p>
                    <p className="text-sm font-bold mono-text text-black">{account.latest_image_score}</p>
                  </div>
                )}
              </div>

              {/* Action */}
              <button className="px-6 py-2 border border-primary text-primary text-[11px] font-bold rounded hover:bg-primary hover:text-white transition-all orange-glow">
                Review Account
              </button>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
