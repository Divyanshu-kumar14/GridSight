"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Eye, Mic, Zap } from "lucide-react";
import DefectCard from "@/components/DefectCard";
import RawJsonPanel from "@/components/RawJsonPanel";
import ReportBreadcrumb from "@/components/ReportBreadcrumb";
import SeverityChart from "@/components/SeverityChart";
import { buildReportCsv, reportCsvFilename } from "@/lib/export";
import type { DefectReport } from "@/lib/types";

// Styled defect report. Data: GET /api/generate-report?sessionId=
// CSV export is client-side.
function CountUp({ to, duration = 0.8 }: { to: number; duration?: number }) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (to === 0) return;
    const start = performance.now();
    let raf = 0;
    const step = () => {
      const progress = Math.min((performance.now() - start) / (duration * 1000), 1);
      // easeOutExpo
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setVal(Math.round(eased * to));
      if (progress < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, duration]);
  return <>{val}</>;
}
export default function ReportPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const sessionId = params.id;
  const [report, setReport] = useState<DefectReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [isSample, setIsSample] = useState(false);

  useEffect(() => {
    setSummaryExpanded(false);
    fetch(`/api/generate-report?sessionId=${encodeURIComponent(sessionId)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error?.message ?? `Report unavailable (${res.status}).`);
        setReport(json.report as DefectReport);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Report unavailable."));
    fetch(`/api/sessions?sessionId=${encodeURIComponent(sessionId)}`)
      .then((res) => res.json().catch(() => null))
      .then((json) => {
        if (json?.session?.isSample === true) setIsSample(true);
      })
      .catch(() => null);
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

  // Header derivations (render-time only, no extra state): everything below
  // reads straight from the report JSON so the banner, columns, and verdict
  // can never describe findings the data doesn't contain.
  const totalDefects = report?.defects.length ?? 0;
  const allClear = report !== null && totalDefects === 0;
  const topDefects = report?.defects.slice(0, 3) ?? [];
  const nextActions = Array.from(
    new Set((report?.defects ?? []).map((d) => d.recommendedAction).filter(Boolean)),
  ).slice(0, 3);
  // Older stored reports predate the verification pass — treat missing keys as zero.
  const verification = {
    kept: report?.statistics.verification?.kept ?? 0,
    downgraded: report?.statistics.verification?.downgraded ?? 0,
    dropped: report?.statistics.verification?.dropped ?? 0,
    skipped: report?.statistics.verification?.skipped ?? 0,
  };
  const cov = report?.evidenceCoverage;
  const assetsNotRepresented = cov?.assetsNotRepresented ?? Math.max(0, (cov?.totalAssetsTracked ?? 0) - (cov?.assetsRepresented ?? 0));
  const unresolvedCount = cov?.unresolvedAssociations ?? (report?.defects.filter((d) => d.assetAssociation === "unresolved").length ?? 0);
  const needsReviewCount = cov?.needsReview ?? (report?.defects.filter((d) => !d.humanReview || d.humanReview.status === "needs-inspection").length ?? 0);
  const verificationSkippedCount = cov?.verificationSkipped ?? verification.skipped;
  // Model summary as scannable pointers: one bullet per sentence.
  const summaryPoints = (report?.summary ?? "")
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const visiblePoints = summaryExpanded ? summaryPoints : summaryPoints.slice(0, 2);

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
        {isSample && (
          <p role="status" className="rounded-md border border-sky-700 bg-sky-950/60 px-3 py-2 text-xs leading-relaxed text-sky-200">
            SAMPLE / CACHED REPORT — frozen demo data for trying GridSight with no API key and no cost.
            These results were not generated from your video. Start a live inspection from the home page for your own footage.
          </p>
        )}
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
            {report.inspection.coveragePercent}% stable-track rate · {report.inspection.totalAssetsTracked} assets tracked
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Stable-track rate = share of tracked assets seen in ≥3 frames. It is not the share of
            equipment visually inspected or proven defect-free.
          </p>
          {allClear ? (
            <div role="status" className="mt-4 rounded-md border border-green-800 bg-green-950/60 px-3 py-2 text-sm text-green-200">
              <span className="font-bold">
                No defects were confirmed in the evidence reviewed.
              </span>
              <span className="mt-1 block text-green-200/90">
                This does not prove the entire inspection area is defect-free — only the selected
                key frames and notes were reviewed (see limitations below).
              </span>
              {report.evidenceCoverage && (
                <span className="mt-1 block font-mono text-[11px] text-green-300/80">
                  {report.evidenceCoverage.assetsRepresented}/{report.evidenceCoverage.totalAssetsTracked} assets in key frames · {assetsNotRepresented} not in selected evidence · nothing met the evidence bar.
                </span>
              )}
            </div>
          ) : (
            <div role="alert" className="mt-4 rounded-md border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-200">
              <span className="font-bold">
                {totalDefects} defect{totalDefects === 1 ? "" : "s"} listed — {report.statistics.critical} critical, {report.statistics.high} high.
              </span>
              <span className="mt-0.5 block">
                Candidate findings from the evidence reviewed, not a certified engineering
                determination. Review severity and evidence before acting.
              </span>
              <span className="mt-0.5 block font-mono text-[11px] text-red-300/80">
                {report.inspection.totalAssetsTracked} assets tracked · {report.inspection.coveragePercent}% stable-track rate.
              </span>
            </div>
          )}
          <motion.div
            className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
          >
            {[
              { label: "ASSETS TRACKED", value: report.inspection.totalAssetsTracked },
              { label: "CRITICAL", value: report.statistics.critical },
              { label: "HIGH", value: report.statistics.high },
              { label: "TOTAL DEFECTS", value: report.defects.length },
            ].map((s) => (
              <div key={s.label} className="rounded-md border border-line bg-ink px-3 py-3">
                <p className="micro-label">{s.label}</p>
                <p className="tabular mt-1 font-mono text-2xl font-bold text-slate-100">
                  <CountUp to={s.value} duration={0.9} />
                </p>
              </div>
            ))}
          </motion.div>
          {report.evidenceCoverage && (
            <div className="mt-2 rounded-md border border-line bg-ink px-3 py-2">
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <Eye className="h-3 w-3" aria-hidden />
                  {report.evidenceCoverage.assetsRepresented}/{report.evidenceCoverage.totalAssetsTracked} assets in frames
                </span>
                <span>{report.evidenceCoverage.visualFindings} visual</span>
                <span className="inline-flex items-center gap-1">
                  <Mic className="h-3 w-3" aria-hidden />
                  {report.evidenceCoverage.voiceOnlyFindings} voice-only
                </span>
                <span>{report.evidenceCoverage.verificationSkipped} re-check unavailable</span>
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                Evidence limits: {assetsNotRepresented} asset{assetsNotRepresented === 1 ? "" : "s"} not
                represented in selected key frames · {verificationSkippedCount} visual finding
                {verificationSkippedCount === 1 ? "" : "s"} without AI re-check · {unresolvedCount} unresolved
                asset association{unresolvedCount === 1 ? "" : "s"} · {needsReviewCount} item{needsReviewCount === 1 ? "" : "s"} needing
                human review. Assets absent from key frames were not visually reviewed for this report.
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                AI re-check means the model accepted the visual claim after re-reading the cited
                frame — it is not independent ground truth or an engineer&apos;s approval.
                Skipped re-checks keep the finding unchanged; they never delete it.
              </p>
            </div>
          )}
          {report.modelRun && (
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
              {report.modelRun.model} · {report.modelRun.provider}
            </p>
          )}
          {summaryPoints.length > 0 && (
            <div className="mt-2">
              <p className="micro-label">Model analysis</p>
              <ul className="mt-1 space-y-1 text-sm text-slate-300">
                {visiblePoints.map((point, i) => (
                  <li key={i} className="flex gap-2">
                    <span aria-hidden className="shrink-0 text-amber-400">•</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              {summaryPoints.length > 2 && (
                <button
                  onClick={() => setSummaryExpanded((v) => !v)}
                  aria-expanded={summaryExpanded}
                  className="mt-1.5 inline-flex items-center gap-1 font-mono text-[11px] text-amber-400 hover:underline"
                >
                  <ChevronDown
                    className={`h-3 w-3 transition-transform ${summaryExpanded ? "rotate-180" : ""}`}
                    aria-hidden
                  />
                  {summaryExpanded ? "Show less" : `Show all ${summaryPoints.length} points`}
                </button>
              )}
            </div>
          )}
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="rounded-md border border-line bg-ink p-3">
              <p className="micro-label">What we found</p>
              {topDefects.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs text-slate-200">
                  {topDefects.map((d) => (
                    <li key={d.id}>• {d.title}</li>
                  ))}
                </ul>
              ) : (
                <ul className="mt-2 space-y-1 text-xs text-slate-200">
                  <li>• No defects confirmed in the evidence reviewed ({report.inspection.totalAssetsTracked} tracked assets)</li>
                  <li>• {assetsNotRepresented} assets not in key frames · inspector notes reviewed</li>
                </ul>
              )}
            </div>
            <div className="rounded-md border border-line bg-ink p-3">
              <p className="micro-label">Evidence &amp; limits</p>
              <ul className="mt-2 space-y-1 text-xs text-slate-200">
                <li>
                  • {report.evidenceCoverage?.visualFindings ?? 0} visual ·{" "}
                  {report.evidenceCoverage?.voiceOnlyFindings ?? 0} voice-only findings
                </li>
                {verification.kept > 0 && (
                  <li>• {verification.kept} AI re-checked and kept</li>
                )}
                {verification.downgraded > 0 && (
                  <li>• {verification.downgraded} downgraded to voice-only on re-check</li>
                )}
                {verification.dropped > 0 && (
                  <li>• {verification.dropped} rejected by AI review</li>
                )}
                {verification.skipped > 0 && (
                  <li>• {verification.skipped} re-check unavailable (kept, not deleted)</li>
                )}
                {unresolvedCount > 0 && <li>• {unresolvedCount} unresolved asset association{unresolvedCount === 1 ? "" : "s"}</li>}
                {totalDefects === 0 && <li>• Key frames reviewed — nothing met the evidence bar; not proof the yard is defect-free</li>}
              </ul>
            </div>
            <div className="rounded-md border border-line bg-ink p-3">
              <p className="micro-label">Next actions</p>
              {nextActions.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs text-slate-200">
                  {nextActions.map((a) => (
                    <li key={a}>• {a}</li>
                  ))}
                </ul>
              ) : (
                <ul className="mt-2 space-y-1 text-xs text-slate-200">
                  <li>• No corrective actions assigned — continue routine inspections</li>
                </ul>
              )}
            </div>
          </div>
          {allClear ? (
            <div className="mt-4 flex flex-col items-center gap-1 py-2 text-center">
              <motion.span
                aria-hidden
                className="flex h-10 w-10 items-center justify-center rounded-full border border-green-500 bg-green-950"
                animate={{ scale: [1, 1.15, 1], opacity: [1, 0.75, 1] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
              >
                <Check className="h-5 w-5 text-green-400" strokeWidth={3} />
              </motion.span>
              <p className="text-base font-bold tracking-tight text-slate-100">No defects confirmed in reviewed evidence</p>
              <p className="max-w-md text-xs leading-relaxed text-slate-500">
                {report.inspection.totalAssetsTracked} assets tracked · {assetsNotRepresented} not in
                selected key frames · {verificationSkippedCount} re-check unavailable. This is not
                proof the substation is defect-free — continue routine inspections.
              </p>
            </div>
          ) : (
            <div className="mt-4 flex flex-col items-center gap-1 py-2 text-center">
              <p className="text-base font-bold tracking-tight text-slate-100">
                {totalDefects} defect{totalDefects === 1 ? "" : "s"} need{totalDefects === 1 ? "s" : ""} attention
              </p>
              <p className="font-mono text-xs text-slate-500">
                {report.statistics.critical} critical · {report.statistics.high} high ·{" "}
                {report.statistics.medium} medium · {report.statistics.low} low
              </p>
            </div>
          )}
          <div className="mt-3">
            <SeverityChart stats={report.statistics} />
          </div>
          <p className="mt-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
            AI-generated inspection support — not a certified engineering safety determination.
            Confirm findings on site with a qualified engineer before scheduling work.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 print:hidden">
            <button onClick={downloadCsv} className="rounded bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-950">
              Export CSV
            </button>
            <button onClick={() => window.print()} className="rounded border border-line px-3 py-1.5 text-xs font-semibold text-slate-200">
              Print / Save as PDF
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
                sessionId={sessionId}
                onSeek={(t) => router.push(`/inspection/${sessionId}?t=${Math.floor(t)}`)}
                onReviewed={(next) =>
                  setReport((prev) =>
                    prev ? { ...prev, defects: prev.defects.map((x) => (x.id === next.id ? next : x)) } : prev,
                  )
                }
              />
            </motion.div>
          ))}
        </AnimatePresence>
        <RawJsonPanel json={JSON.stringify(report, null, 2)} />
      </div>
    </main>
  );
}
