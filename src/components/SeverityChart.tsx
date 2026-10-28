"use client";

import type { ReportStatistics } from "@/lib/types";

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
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-900">
        {rows.map(
          (r) =>
            r.count > 0 && (
              <div
                key={r.label}
                style={{ width: `${(r.count / total) * 100}%`, background: r.color }}
                className="h-full first:rounded-l-full last:rounded-r-full"
                title={`${r.label} ${r.count}`}
              />
            ),
        )}
      </div>
      <div className="tabular mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold">
        {rows.map((r) => (
          <span key={r.label} className={r.text}>
            {r.label} <span className="text-slate-500">{r.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
