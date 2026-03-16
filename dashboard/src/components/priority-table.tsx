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
            className={`flex items-center gap-4 p-4 rounded-xl bg-slate-800/50 border-l-4 ${riskBorderColor(account.max_composite)} hover:bg-slate-800 transition-all duration-200 group`}
          >
            {/* Rank */}
            <div className="text-slate-500 text-sm font-mono w-6 text-right">
              #{index + 1}
            </div>

            {/* Risk Badge */}
            <RiskBadge score={account.max_composite} />

            {/* Account Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-200">
                  @{account.username}
                </span>
                <span
                  className={`text-sm font-medium ${trendColor(account.trend)}`}
                >
                  {trendIcon(account.trend)}
                </span>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {account.score_count} observation
                {account.score_count !== 1 ? "s" : ""} &middot;{" "}
                {timeAgo(account.last_seen)}
              </div>
              {hint ? (
                <div className="text-[11px] text-slate-400 mt-1">
                  {hint}
                </div>
              ) : null}
            </div>

            {/* Sub-scores */}
            <div className="hidden sm:flex items-center gap-4 text-xs">
              <div className="text-center">
                <div className="text-slate-500 mb-0.5">Text</div>
                <div className="font-semibold text-slate-300">
                  {renderScore(account.latest_text_score)}
                </div>
              </div>
              <div className="text-center">
                <div className="text-slate-500 mb-0.5">Image</div>
                <div className="font-semibold text-slate-300">
                  {renderScore(account.latest_image_score)}
                </div>
              </div>
            </div>

            {/* Arrow */}
            <div className="text-slate-600 group-hover:text-slate-400 transition-colors">
              &#8250;
            </div>
          </Link>
        );
      })}
    </div>
  );
}
