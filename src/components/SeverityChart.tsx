"use client";

import type { ReportStatistics } from "@/lib/types";

// Contract: horizontal segmented severity bar (no chart lib).
// Normal: segments proportional to counts. Empty (all zero): hint text.
export default function SeverityChart({ stats }: { stats: ReportStatistics }) {
  const rows = [
    { label: "CRITICAL", count: stats.critical, color: "#ef4444", text: "text-red-400" },
    { label: "HIGH", count: stats.high, color: "#f97316", text: "text-orange-400" },
    { label: "MEDIUM", count: stats.medium, color: "#eab308", text: "text-yellow-400" },
    { label: "LOW", count: stats.low, color: "#22c55e", text: "text-green-400" },
  ];
  const total = rows.reduce((n, r) => n + r.count, 0);
  if (total === 0) return <p className="text-xs text-slate-500">No defects recorded.</p>;
  return (
    <div role="img" aria-label={`Defects: ${total} total — ${rows.map((r) => `${r.label} ${r.count}`).join(", ")}`}>
      <div className="flex h-3 w-full overflow-hidden rounded bg-slate-900">
        {rows.map(
          (r) =>
            r.count > 0 && (
              <div key={r.label} style={{ width: `${(r.count / total) * 100}%`, background: r.color }} title={`${r.label} ${r.count}`} />
            ),
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
        {rows.map((r) => (
          <span key={r.label} className={r.text}>
            {r.label} {r.count}
          </span>
        ))}
      </div>
    </div>
  );
}
