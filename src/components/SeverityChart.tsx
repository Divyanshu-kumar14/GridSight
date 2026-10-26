"use client";

import type { ReportStatistics } from "@/lib/types";

// Contract: SVG severity distribution (no chart lib).
// Normal: bars scaled to max count. Empty (all zero): hint text.
export default function SeverityChart({ stats }: { stats: ReportStatistics }) {
  const rows = [
    { label: "CRITICAL", count: stats.critical, color: "#ef4444" },
    { label: "HIGH", count: stats.high, color: "#f97316" },
    { label: "MEDIUM", count: stats.medium, color: "#eab308" },
    { label: "LOW", count: stats.low, color: "#22c55e" },
  ];
  const max = Math.max(1, ...rows.map((r) => r.count));
  const total = rows.reduce((n, r) => n + r.count, 0);
  if (total === 0) return <p className="text-xs text-slate-500">No defects recorded.</p>;
  return (
    <div role="img" aria-label={`Defects: ${total} total`} className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-xs">
          <span className="w-20 font-mono text-slate-400">{r.label}</span>
          <svg width="160" height="14" className="rounded bg-ink" aria-hidden>
            <rect x="0" y="0" width={(r.count / max) * 160} height="14" fill={r.color} rx="3" />
          </svg>
          <span className="font-mono text-slate-200">{r.count}</span>
        </div>
      ))}
    </div>
  );
}
