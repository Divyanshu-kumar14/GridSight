"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, FolderOpen } from "lucide-react";
import { useRouter } from "next/navigation";

// Dashboard: every session with honest status — never inferred from defect
// count alone. Review flags come from server-computed evidenceCoverage.
interface Row {
  id: string;
  substationName: string;
  inspectorName: string;
  date: string;
  status: string;
  totalTracked: number;
  totalDefects: number;
  updatedAt: string;
  isSample?: boolean;
}

type Derived =
  | "In progress"
  | "Completed with findings"
  | "Completed with items requiring review"
  | "Completed with no confirmed findings"
  | "Failed or interrupted"
  | "Sample / cached";

const statusColor: Record<Derived, string> = {
  "In progress": "bg-amber-500",
  "Completed with findings": "bg-green-500",
  "Completed with items requiring review": "bg-amber-400",
  "Completed with no confirmed findings": "bg-slate-400",
  "Failed or interrupted": "bg-red-500",
  "Sample / cached": "bg-sky-500",
};

function deriveBase(r: Row): Derived {
  if (r.isSample) return "Sample / cached";
  if (r.status === "error") return "Failed or interrupted";
  if (r.status !== "complete") return "In progress";
  if (r.totalDefects > 0) return "Completed with findings";
  return "Completed with no confirmed findings";
}

export default function DashboardPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewIds, setReviewIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/sessions")
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error?.message ?? "Failed to load sessions.");
        const list = (json.sessions as Row[]) ?? [];
        setRows(list);
        // Best-effort review flags: server-computed coverage per complete report.
        // Failures here never change the base status — review badge is additive.
        const complete = list.filter((r) => r.status === "complete" && !r.isSample);
        void Promise.all(
          complete.map(async (r) => {
            try {
              const rr = await fetch(`/api/generate-report?sessionId=${encodeURIComponent(r.id)}`);
              if (!rr.ok) return null;
              const jj = await rr.json().catch(() => null);
              const cov = jj?.report?.evidenceCoverage as
                | { needsReview?: number; verificationSkipped?: number; unresolvedAssociations?: number }
                | undefined;
              const defects = Array.isArray(jj?.report?.defects) ? jj.report.defects : [];
              const needs =
                (cov?.needsReview ?? 0) > 0 ||
                (cov?.verificationSkipped ?? 0) > 0 ||
                (cov?.unresolvedAssociations ?? 0) > 0 ||
                defects.some(
                  (d: { humanReview?: { status?: string } }) => d?.humanReview?.status === "needs-inspection",
                );
              return needs ? r.id : null;
            } catch {
              return null;
            }
          }),
        ).then((ids) => {
          const s = new Set<string>();
          for (const id of ids) if (id) s.add(id);
          setReviewIds(s);
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load sessions."));
  }, []);

  const label = (r: Row): Derived => {
    const base = deriveBase(r);
    if (base === "Completed with findings" && reviewIds.has(r.id))
      return "Completed with items requiring review";
    return base;
  };

  return (
    <main className="min-h-screen bg-ink text-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <button onClick={() => router.push("/")} className="inline-flex items-center gap-1 text-sm text-amber-400 underline">
          <ArrowLeft className="h-4 w-4" /> New inspection
        </button>
        <span className="micro-label mt-4 block">Fleet overview</span>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">All inspections</h1>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-500">
          Status is server state, not a defect-count guess. “Items requiring review” means the
          report itself flags skipped re-checks, unresolved asset links, or reviewer-marked items.
          Sample rows are frozen demo data — reopen them without spending inference.
        </p>

        {error && (
          <p role="alert" className="mt-4 rounded-md border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">{error}</p>
        )}
        {rows === null && !error && (
          <p className="mt-4 text-sm text-slate-500" role="status">Loading sessions…</p>
        )}
        {rows !== null && rows.length === 0 && (
          <div className="panel mt-4 p-6 text-center">
            <FolderOpen className="mx-auto h-6 w-6 text-slate-500" />
            <p className="mt-2 text-sm text-slate-400">No inspections yet — run your first one.</p>
            <button onClick={() => router.push("/")} className="btn-primary mt-4">Start inspection</button>
          </div>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="mt-6 space-y-3">
            {rows.map((r) => {
              const d = label(r);
              return (
                <li key={r.id} className="panel p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusColor[d] ?? "bg-slate-500"}`} aria-hidden />
                    <span className="font-bold">{r.substationName}</span>
                    <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-slate-300">
                      {d.toUpperCase()}
                    </span>
                    {r.isSample && (
                      <span className="rounded border border-sky-600 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-sky-300">
                        SAMPLE — NO INFERENCE
                      </span>
                    )}
                    <span className="w-full font-mono text-xs text-slate-500 sm:w-auto">
                      {r.inspectorName} · {r.totalTracked} assets · {r.totalDefects} defects
                    </span>
                    <span className="ml-auto flex gap-3 text-sm">
                      <button onClick={() => router.push(`/inspection/${r.id}`)} className="text-amber-400 underline">
                        Workspace
                      </button>
                      <button onClick={() => router.push(`/inspection/${r.id}/report`)} className="text-amber-400 underline">
                        Report
                      </button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
