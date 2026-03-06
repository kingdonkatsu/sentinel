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
    <div className="bg-slate-800/50 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-slate-300 mb-4">
        Score Timeline (Last 24h)
      </h3>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="time" stroke="#64748b" fontSize={11} />
          <YAxis domain={[0, 100]} stroke="#64748b" fontSize={11} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1e293b",
              border: "1px solid #334155",
              borderRadius: "8px",
              fontSize: "12px",
            }}
            labelStyle={{ color: "#94a3b8" }}
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
