"use client";

import { motion } from "framer-motion";
import { Check, X } from "lucide-react";

// Contract: 48px mission-control HUD bar bound to pipeline status.
// Input: ordered steps with status. Output: horizontal chips joined by lines;
// active pulses amber, complete is a solid green check, pending is ghost.
export interface PipeStep {
  key: string;
  label: string;
  status: "pending" | "running" | "complete" | "error" | "skipped" | "needs-attention";
  error?: string;
}

const chip: Record<PipeStep["status"], string> = {
  pending: "border-slate-800 text-slate-600",
  running: "border-amber-500 text-amber-300",
  complete: "border-green-600 text-green-300",
  error: "border-red-600 text-red-300",
  skipped: "border-slate-700 text-slate-500",
  "needs-attention": "border-amber-600 text-amber-200",
};

export default function PipelineProgress({ steps }: { steps: PipeStep[] }) {
  if (steps.length === 0) return <p className="text-sm text-slate-500">No pipeline activity yet.</p>;
  return (
    <ol className="flex h-12 items-center gap-0 overflow-x-auto rounded-md border border-line bg-panel px-3" aria-label="Pipeline progress">
      {steps.map((s, i) => {
        const prevComplete = i > 0 && steps[i - 1]?.status === "complete";
        const isRunning = s.status === "running";
        return (
        <motion.li
          key={s.key}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.18, delay: i * 0.07 }}
          className="flex min-w-0 items-center"
        >
          {i > 0 && (
            <motion.span
              className="mx-2 h-px w-6 shrink-0 origin-left sm:w-10"
              style={{ background: prevComplete ? "#16a34a" : "rgba(148,163,184,0.16)" }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.3, delay: i * 0.07 + 0.1 }}
              aria-hidden
            />
          )}
          <motion.span
            key={`${s.key}-${s.status}`}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-bold tracking-wider ${chip[s.status]}`}
            initial={{ scale: s.status === "complete" ? 1.18 : 1 }}
            animate={isRunning ? { scale: 1, opacity: [1, 0.5, 1] } : { scale: 1 }}
            transition={isRunning ? { duration: 1.1, repeat: Infinity, ease: "easeInOut" } : { type: "spring", stiffness: 500, damping: 18 }}
          >
            {s.status === "complete" && <Check className="h-3 w-3 text-green-400" strokeWidth={3} aria-hidden />}
            {s.status === "error" && <X className="h-3 w-3 text-red-400" strokeWidth={3} aria-hidden />}
            {s.label}
          </motion.span>
          {s.status === "error" && s.error && (
            <span role="alert" className="ml-1 truncate text-xs text-red-400">({s.error})</span>
          )}
        </motion.li>
        );
      })}
    </ol>
  );
}
