"use client";

import { motion } from "framer-motion";
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
          (r, idx) =>
            r.count > 0 && (
              <motion.div
                key={r.label}
                style={{ background: r.color }}
                className="h-full origin-left"
                title={`${r.label} ${r.count}`}
                initial={{ scaleX: 0, width: `${(r.count / total) * 100}%` }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.7, delay: idx * 0.12, ease: [0.16, 1, 0.3, 1] }}
              />
            ),
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
        {rows.map((r, idx) => (
          <motion.span
            key={r.label}
            className={r.text}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3, delay: 0.5 + idx * 0.1 }}
          >
            {r.label} {r.count}
          </motion.span>
        ))}
      </div>
    </div>
  );
}
