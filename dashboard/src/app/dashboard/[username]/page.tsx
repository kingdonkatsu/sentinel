"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchAccountDetail, confirmCase, type AccountDetail } from "@/lib/api";
import { RiskBadge } from "@/components/risk-badge";
import { ScoreChart } from "@/components/score-chart";
import { OutreachCard } from "@/components/outreach-card";
import { NotesPanel } from "@/components/notes-panel";
import { timeAgo, trendIcon, trendColor } from "@/lib/utils";

export default function AccountDetailPage() {
  const params = useParams();
  const username = params.username as string;

  const [confirmState, setConfirmState] = useState<"idle" | "loading" | "done">("idle");

  const {
    data: account,
    isLoading,
    error,
  } = useQuery<AccountDetail>({
    queryKey: ["account", username],
    queryFn: () => fetchAccountDetail(username),
    refetchInterval: 10000,
  });

  async function handleConfirm() {
    setConfirmState("loading");
    try {
      await confirmCase(username);
      setConfirmState("done");
    } catch {
      setConfirmState("idle");
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-slate-400 animate-pulse">Loading account...</div>
      </div>
    );
  }

  if (error || !account) {
    return (
      <div className="space-y-4">
        <Link
          href="/dashboard"
          className="text-sm text-blue-400 hover:text-blue-300"
        >
          &larr; Back to Priority Queue
        </Link>
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300 text-sm">
          Account not found or data has expired (24h TTL).
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Back link */}
      <Link
        href="/dashboard"
        className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
      >
        &larr; Back to Priority Queue
      </Link>

      {/* Header */}
      <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700/50">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <RiskBadge score={account.max_composite} />
              <span
                className={`text-sm font-medium ${trendColor(account.trend)}`}
              >
                {trendIcon(account.trend)} {account.trend}
              </span>
            </div>
            <h2 className="text-xl font-semibold text-white mb-1">
              @{account.username}
            </h2>
            <p className="text-xs text-slate-500">
              {account.score_count} observations &middot; Last seen{" "}
              {timeAgo(account.last_seen)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <div className="text-right">
              <div className="text-3xl font-bold text-white">
                {account.max_composite}
              </div>
              <div className="text-xs text-slate-500">Max Risk Score</div>
            </div>
            <button
              onClick={handleConfirm}
              disabled={confirmState !== "idle"}
              className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                confirmState === "done"
                  ? "bg-green-700/40 text-green-300 cursor-default"
                  : confirmState === "loading"
                  ? "bg-slate-700 text-slate-400 cursor-wait"
                  : "bg-slate-700 hover:bg-slate-600 text-slate-200 cursor-pointer"
              }`}
            >
              {confirmState === "done"
                ? "Confirmed ✓"
                : confirmState === "loading"
                ? "Confirming…"
                : "Confirm Case"}
            </button>
          </div>
        </div>

        {/* Sub-score Breakdown */}
        <div className="grid grid-cols-3 gap-4 mt-6 pt-4 border-t border-slate-700/50">
          <div className="text-center">
            <div className="text-2xl font-bold text-orange-400">
              {account.latest_composite}
            </div>
            <div className="text-xs text-slate-500 mt-1">Composite</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-400">
              {account.latest_text_score}
            </div>
            <div className="text-xs text-slate-500 mt-1">Text Score</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-purple-400">
              {account.latest_image_score}
            </div>
            <div className="text-xs text-slate-500 mt-1">Image Score</div>
          </div>
        </div>
      </div>

      {/* Score Timeline Chart */}
      <ScoreChart scores={account.scores} />

      {/* AI Outreach Suggestions */}
      <OutreachCard
        compositeScore={account.latest_composite}
        textScore={account.latest_text_score}
        imageScore={account.latest_image_score}
      />

      {/* Case Notes */}
      <NotesPanel token={username} />
    </div>
  );
}
