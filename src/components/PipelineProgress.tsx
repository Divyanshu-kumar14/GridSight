"use client";

import { ChevronRight } from "lucide-react";

// Contract: step indicator bound to pipeline status.
// Input: ordered steps with status. Output: visual stepper; failed step shows error.
export interface PipeStep {
  key: string;
  label: string;
  status: "pending" | "running" | "complete" | "error" | "skipped";
  error?: string;
}

const dot: Record<PipeStep["status"], string> = {
  pending: "bg-slate-700",
  running: "bg-amber-500 animate-pulse",
  complete: "bg-green-500",
  error: "bg-red-500",
  skipped: "bg-slate-600",
};

export default function PipelineProgress({ steps }: { steps: PipeStep[] }) {
  if (steps.length === 0) return <p className="text-sm text-slate-500">No pipeline activity yet.</p>;
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Pipeline progress">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          {i > 0 && <ChevronRight className="h-3 w-3 text-slate-600" aria-hidden />}
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot[s.status]}`} />
          <span className="text-xs text-slate-300">{s.label}</span>
          {s.status === "error" && s.error && (
            <span role="alert" className="text-xs text-red-400">({s.error})</span>
          )}
        </li>
      ))}
    </ol>
  );
}
