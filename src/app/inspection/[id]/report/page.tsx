"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Zap } from "lucide-react";
import DefectCard from "@/components/DefectCard";
import RawJsonPanel from "@/components/RawJsonPanel";
import ReportBreadcrumb from "@/components/ReportBreadcrumb";
import SeverityChart from "@/components/SeverityChart";
import { buildReportCsv, reportCsvFilename } from "@/lib/export";
import type { DefectReport } from "@/lib/types";

// Styled defect report. Data: GET /api/generate-report?sessionId=
// CSV export is client-side.
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
      <main className="min-h-screen bg-ink px-4 py-6 text-slate-100" role="status" aria-label="Loading report">
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="panel flex items-center justify-between p-4">
            <div className="h-5 w-40 animate-pulse rounded bg-slate-800" />
            <div className="h-5 w-32 animate-pulse rounded bg-amber-900/60" />
          </div>
          <div className="h-8 w-2/3 animate-pulse rounded bg-slate-800" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="panel h-20 animate-pulse bg-slate-900/60" />
            ))}
          </div>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="panel h-36 animate-pulse bg-slate-900/60" />
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-ink px-4 py-6 text-slate-100">
      <div className="mx-auto max-w-3xl space-y-4">
        <ReportBreadcrumb sessionId={sessionId} substationName={report.inspection.substationName} current="REPORT" />
        <header className="panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <Zap className="h-6 w-6 text-amber-500" strokeWidth={2.5} aria-hidden />
              <div>
                <p className="text-base font-bold tracking-tight">GridSight</p>
                <p className="micro-label">Field Inspection Report</p>
              </div>
            </div>
            <div className="text-right font-mono text-xs text-slate-400">
              <p>{report.inspection.date}</p>
              <p className="mt-0.5">{report.inspection.inspector}</p>
            </div>
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">{report.inspection.substationName}</h1>
          <p className="mt-1 font-mono text-xs text-slate-400">
            {report.inspection.coveragePercent}% coverage
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "ASSETS TRACKED", value: report.inspection.totalAssetsTracked },
              { label: "CRITICAL", value: report.statistics.critical },
              { label: "HIGH", value: report.statistics.high },
              { label: "TOTAL DEFECTS", value: report.defects.length },
            ].map((s) => (
              <div key={s.label} className="rounded-md border border-line bg-ink px-3 py-3">
                <p className="micro-label">{s.label}</p>
                <p className="tabular mt-1 font-mono text-2xl font-bold text-slate-100">{s.value}</p>
              </div>
            ))}
          </div>
          {report.evidenceCoverage && (
            <p className="mt-1 font-mono text-[11px] text-slate-500">
              {report.evidenceCoverage.assetsRepresented}/{report.evidenceCoverage.totalAssetsTracked} assets in key frames ·{" "}
              {report.evidenceCoverage.visualFindings} visual · {report.evidenceCoverage.voiceOnlyFindings} voice-only ·{" "}
              {report.evidenceCoverage.verificationSkipped} verification skipped
            </p>
          )}
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
          </div>
        </header>
        <AnimatePresence>
          {report.defects.map((d, i) => (
            <motion.div
              key={d.id ?? i}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.25, delay: i * 0.06 }}
            >
              <DefectCard
                defect={d}
                onSeek={(t) => router.push(`/inspection/${sessionId}?t=${Math.floor(t)}`)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
        <RawJsonPanel json={JSON.stringify(report, null, 2)} />
      </div>
    </main>
  );
}
