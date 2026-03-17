"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchOutreachSuggestion, type OutreachSuggestion } from "@/lib/api";

interface OutreachCardProps {
  compositeScore: number;
  textScore: number;
  imageScore: number;
}

export function OutreachCard({
  compositeScore,
  textScore,
  imageScore,
}: OutreachCardProps) {
  const {
    data: suggestion,
    isLoading,
    error,
  } = useQuery<OutreachSuggestion>({
    queryKey: ["outreach", compositeScore, textScore, imageScore],
    queryFn: () =>
      fetchOutreachSuggestion(compositeScore, textScore, imageScore),
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  if (isLoading) {
    return (
      <div className="bg-slate-800/50 rounded-xl p-5 animate-pulse">
        <div className="h-4 bg-slate-700 rounded w-48 mb-3"></div>
        <div className="h-3 bg-slate-700 rounded w-full mb-2"></div>
        <div className="h-3 bg-slate-700 rounded w-3/4"></div>
      </div>
    );
  }

  if (error || !suggestion) {
    return (
      <div className="bg-slate-800/50 rounded-xl p-5 text-slate-400 text-sm">
        Unable to generate outreach suggestions at this time.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
      <h3 className="text-sm font-semibold text-purple-400 mb-4 flex items-center gap-2">
        <span className="w-5 h-5 bg-purple-500/20 rounded flex items-center justify-center text-xs">
          &#9993;
        </span>
        Suggested Conversation Starters
      </h3>

      {/* Opening */}
      <div className="mb-4">
        <p className="text-xs text-slate-400 mb-1">Opening</p>
        <p className="text-sm text-slate-800 bg-purple-50 rounded-lg px-4 py-3 border-l-2 border-primary">
          &ldquo;{suggestion.opening}&rdquo;
        </p>
      </div>

      {/* Follow-ups */}
      <div className="mb-4">
        <p className="text-xs text-slate-400 mb-2">Follow-ups</p>
        <ul className="space-y-2">
          {suggestion.follow_ups.map((followUp, i) => (
            <li
              key={i}
              className="text-sm text-slate-700 bg-slate-50 rounded-lg px-4 py-2 border border-slate-100"
            >
              &ldquo;{followUp}&rdquo;
            </li>
          ))}
        </ul>
      </div>

      {/* Tone Note */}
      <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
        <p className="text-xs text-blue-600 font-semibold mb-1">
          Approach Guidance
        </p>
        <p className="text-xs text-blue-800/70">{suggestion.tone_note}</p>
      </div>
    </div>
  );
}
