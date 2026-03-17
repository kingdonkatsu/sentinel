"use client";

import { PriorityTable } from "@/components/priority-table";
import { SSEProvider, useScoreEvents } from "@/components/sse-provider";

function DashboardHeader() {
  const { connected } = useScoreEvents();

  return (
    <header className="flex justify-between items-center mb-12">
      <div>
        <h2 className="logo-text text-2xl font-bold text-black">Priority Queue</h2>
        <p className="text-slate-600">Flagged accounts ranked by risk severity</p>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-border-light rounded-lg">
          <div
            className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`}
          />
          <span className="text-[10px] font-bold mono-text text-slate-600 uppercase tracking-wider">
            {connected ? "Realtime sync on" : "Disconnected"}
          </span>
        </div>
      </div>
    </header>
  );
}

export default function DashboardPage() {
  return (
    <SSEProvider>
      <DashboardHeader />
      <div className="border border-border-light rounded-xl overflow-hidden bg-white">
        <PriorityTable />
      </div>
    </SSEProvider>
  );
}
