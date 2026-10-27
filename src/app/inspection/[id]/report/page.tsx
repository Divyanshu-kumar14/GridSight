"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import DefectCard from "@/components/DefectCard";
import RawJsonPanel from "@/components/RawJsonPanel";
import ReportBreadcrumb from "@/components/ReportBreadcrumb";
import SeverityChart from "@/components/SeverityChart";
import { buildReportCsv, reportCsvFilename } from "@/lib/export";
import type { DefectReport } from "@/lib/types";

// /inspection/[id]/report — styled defect report (PRD §9).
// Data: GET /api/generate-report?sessionId=. CSV export client-side.
// PDF export deferred (support feature, time-boxed) — noted in UI, not silently missing.
export default function ReportPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const sessionId = params.id;
  const [report, setReport] = useState<DefectReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/generate-report?sessionId=${encodeURIComponent(sessionId)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error?.message ?? `Report unavailable (${res.status}).`);
        setReport(json.report as DefectReport);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Report unavailable."));
  }, [sessionId]);

  const downloadCsv = () => {
    if (!report) return;
    const blob = new Blob([buildReportCsv(report)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = reportCsvFilename(sessionId);
    a.click();
    URL.revokeObjectURL(url);
  };

  if (error) {
    return (
      <main className="min-h-screen bg-ink px-4 py-12 text-slate-100">
        <div className="mx-auto max-w-3xl">
          <p role="alert" className="rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">{error}</p>
          <button onClick={() => router.push(`/inspection/${sessionId}`)} className="mt-3 text-sm text-amber-400 underline">
            ← Back to workspace
          </button>
        </div>
      </main>
    );
  }

  if (!report) {
    return (
      <main className="min-h-screen bg-ink px-4 py-12 text-slate-100">
        <div className="mx-auto max-w-3xl text-sm text-slate-400">Loading report…</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-ink px-4 py-6 text-slate-100">
      <div className="mx-auto max-w-3xl space-y-4">
        <ReportBreadcrumb sessionId={sessionId} substationName={report.inspection.substationName} current="REPORT" />
        <header className="panel p-4">
          <span className="micro-label">GridSight defect report</span>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{report.inspection.substationName}</h1>
          <p className="mt-1 font-mono text-xs text-slate-400">
            {report.inspection.date} · {report.inspection.inspector} · {report.inspection.totalAssetsTracked} assets tracked · {report.inspection.coveragePercent}% coverage
          </p>
          {report.modelRun && (
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
              {report.modelRun.model} · {report.modelRun.provider}
            </p>
          )}
          <p className="mt-2 text-sm text-slate-300">{report.summary}</p>
          <div className="mt-3">
            <SeverityChart stats={report.statistics} />
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={downloadCsv} className="rounded bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-950">
              Export CSV
            </button>
            <span title="Support feature — time-boxed out of the hackathon build" className="cursor-help rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-500">
              PDF export (coming soon)
            </span>
          </div>
        </header>
        {report.defects.map((d) => (
          <DefectCard
            key={d.id}
            defect={d}
            onSeek={(t) => router.push(`/inspection/${sessionId}?t=${Math.floor(t)}`)}
          />
        ))}
        <RawJsonPanel json={JSON.stringify(report, null, 2)} />
      </div>
    </main>
  );
}
