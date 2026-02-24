"use client";

import { PriorityTable } from "@/components/priority-table";
import { SSEProvider, useScoreEvents } from "@/components/sse-provider";

function DashboardHeader() {
  const { connected } = useScoreEvents();

  return (
    <div className="flex items-center justify-between mb-8">
      <div>
        <h2 className="text-2xl font-bold text-white">Priority Queue</h2>
        <p className="text-sm text-slate-400 mt-1">
          Flagged accounts ranked by risk severity. Updated in real time.
        </p>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <div
          className={`w-2 h-2 rounded-full ${connected ? "bg-green-500 animate-pulse" : "bg-red-500"}`}
        />
        <span className="text-slate-400">
          {connected ? "Live" : "Disconnected"}
        </span>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <SSEProvider>
      <DashboardHeader />
      <PriorityTable />
    </SSEProvider>
  );
}
