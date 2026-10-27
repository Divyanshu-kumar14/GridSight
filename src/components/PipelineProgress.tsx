"use client";

import { Check, X } from "lucide-react";

// Contract: 48px mission-control HUD bar bound to pipeline status.
// Input: ordered steps with status. Output: horizontal chips joined by lines;
// active pulses amber, complete is a solid green check, pending is ghost.
export interface PipeStep {
  key: string;
  label: string;
  status: "pending" | "running" | "complete" | "error" | "skipped";
  error?: string;
}

const chip: Record<PipeStep["status"], string> = {
  pending: "border-slate-800 text-slate-600",
  running: "border-amber-500 text-amber-300 animate-pulse",
  complete: "border-green-600 text-green-300",
  error: "border-red-600 text-red-300",
  skipped: "border-slate-700 text-slate-500",
};

export default function PipelineProgress({ steps }: { steps: PipeStep[] }) {
  if (steps.length === 0) return <p className="text-sm text-slate-500">No pipeline activity yet.</p>;
  return (
    <ol className="flex h-12 items-center gap-0 overflow-x-auto rounded-md border border-line bg-panel px-3" aria-label="Pipeline progress">
      {steps.map((s, i) => (
        <li key={s.key} className="flex min-w-0 items-center">
          {i > 0 && <span aria-hidden className="mx-2 h-px w-6 shrink-0 bg-slate-700 sm:w-10" />}
          <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-bold tracking-wider ${chip[s.status]}`}>
            {s.status === "complete" && <Check className="h-3 w-3 text-green-400" strokeWidth={3} aria-hidden />}
            {s.status === "error" && <X className="h-3 w-3 text-red-400" strokeWidth={3} aria-hidden />}
            {s.label}
          </span>
          {s.status === "error" && s.error && (
            <span role="alert" className="ml-1 truncate text-xs text-red-400">({s.error})</span>
          )}
        </li>
      ))}
    </ol>
  );
}
