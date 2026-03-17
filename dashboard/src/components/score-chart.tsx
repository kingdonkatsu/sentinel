"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { ScoreDetail } from "@/lib/api";

interface ScoreChartProps {
  scores: ScoreDetail[];
}

export function ScoreChart({ scores }: ScoreChartProps) {
  if (scores.length === 0) {
    return (
      <div className="bg-slate-800/50 rounded-xl p-8 text-center text-slate-400 text-sm">
        No score history available yet.
      </div>
    );
  }

  const chartData = scores.map((s) => ({
    time: new Date(s.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    composite: s.composite,
    text: s.text_score,
    image: s.image_score,
  }));

  return (
    <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-800 mb-4">
        Score Timeline (Last 24h)
      </h3>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="time" stroke="#94a3b8" fontSize={11} />
          <YAxis domain={[0, 100]} stroke="#94a3b8" fontSize={11} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              fontSize: "12px",
              boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
            }}
            labelStyle={{ color: "#64748b" }}
          />
          <Legend wrapperStyle={{ fontSize: "12px" }} />
          <Line
            type="monotone"
            dataKey="composite"
            stroke="#f97316"
            strokeWidth={2}
            dot={{ r: 3 }}
            name="Composite"
          />
          <Line
            type="monotone"
            dataKey="text"
            stroke="#3b82f6"
            strokeWidth={1.5}
            dot={{ r: 2 }}
            name="Text"
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="image"
            stroke="#a855f7"
            strokeWidth={1.5}
            dot={{ r: 2 }}
            name="Image"
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
