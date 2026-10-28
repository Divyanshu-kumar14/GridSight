"use client";

import { useEffect, useState } from "react";
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

// Departure-board marker: solid token fills only (amber = needs attention,
// porcelain = confirmed findings, steel = quiet done, bus = frozen sample).
const statusBlock: Record<Derived, string> = {
  "In progress": "bg-amber",
  "Completed with findings": "bg-porcelain",
  "Completed with items requiring review": "bg-amber",
  "Completed with no confirmed findings": "bg-steel",
  "Failed or interrupted": "bg-amber",
  "Sample / cached": "bg-bus",
};

const statusText: Record<Derived, string> = {
  "In progress": "text-amber",
  "Completed with findings": "text-porcelain",
  "Completed with items requiring review": "text-amber",
  "Completed with no confirmed findings": "text-steel",
  "Failed or interrupted": "text-amber",
  "Sample / cached": "text-steel",
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
    <main className="min-h-screen bg-ink text-porcelain">
      <header className="border-b border-line bg-panel/50">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <button onClick={() => router.push("/")} className="text-sm font-bold tracking-tight text-slate-100 hover:text-white">← GridSight</button>
          <span className="hidden text-slate-600">/</span>
          <span className="text-sm font-semibold text-steel">Dashboard</span>
          <button onClick={() => router.push("/")} className="btn-primary ml-auto !px-3 !py-1.5 text-xs">New inspection</button>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">All inspections</h1>
          <span className="rounded-full border border-line bg-panel px-2.5 py-1 font-mono text-xs text-steel">{rows?.length ?? "—"} inspections</span>
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
          Fleet overview — status is server state, not a defect-count guess. “Items requiring review” means the report flags skipped re-checks, unresolved asset links, or reviewer-marked items. Sample rows are frozen demo data.
        </p>

        {error && (
          <p
            role="alert"
            className="tile mt-4 border-amber px-3 py-2 text-sm text-porcelain"
          >
            {error}
          </p>
        )}
        {rows === null && !error && (
          <p className="mt-4 text-sm text-steel" role="status">Loading sessions…</p>
        )}
        {rows !== null && rows.length === 0 && (
          <div className="tile mt-4 p-6 text-center">
            <p className="text-sm text-steel">No inspections yet — run your first one.</p>
            <button onClick={() => router.push("/")} className="btn-primary mt-4">Start inspection</button>
          </div>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="mt-6 flex flex-col gap-1" aria-label="Inspections departure board">
            {rows.map((r) => {
              const d = label(r);
              return (
                <li key={r.id} className="board-row gap-0 overflow-hidden px-0 transition-colors hover:border-slate-700">
                  <span
                    aria-hidden
                    title={d}
                    className={`w-1.5 shrink-0 self-stretch ${statusBlock[d] ?? "bg-steel"}`}
                  />
                  <div className="min-w-0 flex-1 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="truncate text-sm font-bold text-porcelain">
                        {r.substationName}
                      </span>
                      {r.isSample && (
                        <span className="rounded border border-line px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-steel">
                          Sample — no inference
                        </span>
                      )}
                    </div>
                    <p className={`mt-0.5 text-sm font-semibold ${statusText[d] ?? "text-steel"}`}>
                      {d}
                    </p>
                    <p className="mt-0.5 truncate text-sm text-steel">
                      <span>{r.inspectorName}</span>
                      <span className="tabular"> · {r.totalTracked} assets · {r.totalDefects} defects</span>
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-steel/80" title={r.id}>
                      {r.date} · {r.id}
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center gap-2 self-center pr-4 text-sm">
                    <button
                      onClick={() => router.push(`/inspection/${r.id}`)}
                      className="rounded-md border border-line bg-ink px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-slate-500"
                    >
                      Workspace
                    </button>
                    <button
                      onClick={() => router.push(`/inspection/${r.id}/report`)}
                      className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400"
                    >
                      Report
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
