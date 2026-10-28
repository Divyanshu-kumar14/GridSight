"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronDown, ShieldCheck, TriangleAlert } from "lucide-react";
import DefectCard from "@/components/DefectCard";
import RawJsonPanel from "@/components/RawJsonPanel";
import ReportBreadcrumb from "@/components/ReportBreadcrumb";
import SeverityChart from "@/components/SeverityChart";
import { buildReportCsv, reportCsvFilename } from "@/lib/export";
import type { DefectReport } from "@/lib/types";

function CountUp({ to, duration = 0.8 }: { to: number; duration?: number }) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (to === 0) return;
    const start = performance.now();
    let raf = 0;
    const step = () => {
      const progress = Math.min((performance.now() - start) / (duration * 1000), 1);
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

  const totalDefects = report?.defects.length ?? 0;
  const allClear = report !== null && totalDefects === 0;
  const topDefects = report?.defects.slice(0, 3) ?? [];
  const nextActions = Array.from(
    new Set((report?.defects ?? []).map((d) => d.recommendedAction).filter(Boolean)),
  ).slice(0, 3);
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
          <div className="h-5 w-40 animate-pulse rounded bg-slate-800" />
          <div className="h-8 w-2/3 animate-pulse rounded bg-slate-800" />
          <div className="grid gap-1" aria-hidden>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="board-row animate-pulse" />
            ))}
          </div>
          <div className="grid gap-1" aria-hidden>
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="board-row animate-pulse" />
            ))}
          </div>
        </div>
      </main>
    );
  }

  const isNamed = report.inspection.substationName.trim().length > 0 && report.inspection.substationName !== "Not provided";
  const displayName = isNamed ? report.inspection.substationName : null;

  return (
    <main className="min-h-screen bg-ink text-slate-100">
      {/* Top bar — dark, stays dark */}
      <div className="sticky top-0 z-10 border-b border-line bg-ink/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
          <ReportBreadcrumb sessionId={sessionId} substationName={report.inspection.substationName} current="REPORT" />
          <div className="ml-auto flex items-center gap-2">
            <button onClick={downloadCsv} className="hidden rounded bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400 sm:inline-flex">
              Export CSV
            </button>
            <button onClick={() => window.print()} className="hidden rounded border border-line px-3 py-1.5 text-xs font-semibold text-slate-400 hover:border-slate-500 hover:text-slate-200 sm:inline-flex">
              Print
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 py-6">
        {isSample && (
          <p role="status" className="mb-4 rounded-md border border-sky-700 bg-sky-950/60 px-3 py-2 text-xs leading-relaxed text-sky-200">
            SAMPLE / CACHED REPORT — frozen demo data for trying GridSight with no API key and no cost. These results were not generated from your video.
          </p>
        )}

        {/* ── 1 · NAMEPLATE ────────────────────────────────────────── */}
        <header className="overflow-hidden rounded-lg border border-line bg-panel text-slate-100">
          <div className="px-5 py-5 sm:px-6 sm:py-6">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-steel">
              GridSight · Field Inspection Report
            </p>
            {displayName ? (
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-[28px]">{displayName}</h1>
            ) : (
              <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-300">Unnamed inspection <span className="font-mono text-xs font-normal normal-case tracking-normal text-steel">· {report.inspection.date.slice(0, 10)}</span></h1>
            )}
            <p className="mt-1 text-xs font-medium text-steel">
              {report.inspection.date} · {report.inspection.inspector}
            </p>

            {/* Coverage badge row */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white px-3 py-1 font-mono text-xs font-bold text-slate-950">
                {report.inspection.totalAssetsTracked} assets tracked
              </span>
              <span className="rounded-full border border-line bg-ink px-3 py-1 font-mono text-xs font-semibold text-slate-300">
                {report.inspection.coveragePercent}% stable-track rate
              </span>
              {cov && cov.totalAssetsTracked > 0 && (
                <span className="rounded-full border border-line bg-ink px-3 py-1 text-xs text-steel">
                  {cov.assetsRepresented}/{cov.totalAssetsTracked} in key frames
                </span>
              )}
            </div>
            <p className="mt-2 max-w-xl text-[11px] leading-relaxed text-slate-400">
              Stable-track rate = share of assets seen in ≥3 frames. It is not the share of equipment visually inspected or proven defect-free.
            </p>
            {report.modelRun && (
              <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                {report.modelRun.model} · {report.modelRun.provider}
              </p>
            )}
            {summaryPoints.length > 0 && (
              <div className="mt-4 rounded-md border border-line bg-ink/60 px-3 py-2.5">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-steel">Model analysis</p>
                <ul className="mt-1.5 space-y-1 text-sm leading-relaxed text-slate-200">
                  {visiblePoints.map((point, i) => (
                    <li key={i} className="flex gap-2">
                      <span aria-hidden className="shrink-0 font-bold text-steel">·</span>
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
                {summaryPoints.length > 2 && (
                  <button
                    onClick={() => setSummaryExpanded((v) => !v)}
                    aria-expanded={summaryExpanded}
                    className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-steel hover:text-slate-200"
                  >
                    <ChevronDown className={`h-3 w-3 transition-transform ${summaryExpanded ? "rotate-180" : ""}`} aria-hidden />
                    {summaryExpanded ? "Show less" : `Show all ${summaryPoints.length} points`}
                  </button>
                )}
              </div>
            )}
          </div>
        </header>

        {/* ── 2 · VERDICT ──────────────────────────────────────────── */}
        {allClear ? (
          <div role="status" className="mt-4 flex gap-3 rounded-lg border border-green-800 bg-green-950 px-4 py-4 sm:gap-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-green-400" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-bold leading-tight text-green-100">No defects were confirmed in the evidence reviewed.</p>
              <p className="mt-1 text-xs leading-relaxed text-green-300/80">
                This does not prove the entire inspection area is defect-free — only the selected key frames and notes were reviewed.
                {report.evidenceCoverage && (
                  <span className="mt-1 block font-mono text-[11px] text-green-400/60">
                    {report.evidenceCoverage.assetsRepresented}/{report.evidenceCoverage.totalAssetsTracked} assets in key frames · nothing met the evidence bar
                  </span>
                )}
              </p>
            </div>
          </div>
        ) : (
          <div role="alert" className="mt-4 flex gap-3 rounded-lg border border-red-800 bg-red-950 px-4 py-4 sm:gap-4">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-bold leading-tight text-red-100">
                {totalDefects} defect{totalDefects === 1 ? "" : "s"} listed — {report.statistics.critical} critical, {report.statistics.high} high.
              </p>
              <p className="mt-1 text-xs leading-relaxed text-red-300/80">
                Candidate findings from the evidence reviewed, not a certified engineering determination. Review severity and evidence before acting.
              </p>
              <p className="mt-1 font-mono text-[11px] text-red-400/60">
                {report.inspection.totalAssetsTracked} tracked · {report.inspection.coveragePercent}% stable-track rate
              </p>
            </div>
          </div>
        )}

        {/* ── 3 · STATS · compact inline bar, not four full cards ──── */}
        <section aria-label="Report figures" className="mt-4 overflow-hidden rounded-lg border border-line bg-panel">
          <div className="grid grid-cols-2 divide-x divide-y divide-line sm:grid-cols-4 sm:divide-y-0">
            <div className="px-4 py-4 text-center sm:py-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-steel">Assets</p>
              <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-white sm:text-3xl"><CountUp to={report.inspection.totalAssetsTracked} /></p>
              <p className="mt-0.5 text-[11px] text-steel/70">tracked in flight</p>
            </div>
            <div className="px-4 py-4 text-center sm:py-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-red-400">Critical</p>
              <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-white sm:text-3xl"><CountUp to={report.statistics.critical} /></p>
              <p className="mt-0.5 text-[11px] text-steel/70">needs attention</p>
            </div>
            <div className="px-4 py-4 text-center sm:py-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-orange-400">High</p>
              <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-white sm:text-3xl"><CountUp to={report.statistics.high} /></p>
              <p className="mt-0.5 text-[11px] text-steel/70">needs attention</p>
            </div>
            <div className="px-4 py-4 text-center sm:py-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-amber-400">Total defects</p>
              <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-white sm:text-3xl"><CountUp to={report.defects.length} /></p>
              <p className="mt-0.5 text-[11px] text-steel/70">{allClear ? "none confirmed" : `${report.statistics.medium} med · ${report.statistics.low} low`}</p>
            </div>
          </div>
        </section>

        {/* ── 4 · EVIDENCE & LIMITS ───────────────────────────────── */}
        {report.evidenceCoverage && (
          <section aria-label="Evidence limits" className="mt-3 rounded-lg border border-line bg-panel px-4 py-4 sm:px-5">
            <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-steel">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" /> Evidence & limits
            </h2>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="rounded-full border border-line bg-ink px-2.5 py-1 font-mono text-xs text-slate-300">{report.evidenceCoverage.assetsRepresented}/{report.evidenceCoverage.totalAssetsTracked} in frames</span>
              <span className="rounded-full border border-line bg-ink px-2.5 py-1 font-mono text-xs text-slate-300">{report.evidenceCoverage.visualFindings} visual</span>
              <span className="rounded-full border border-line bg-ink px-2.5 py-1 font-mono text-xs text-slate-300">{report.evidenceCoverage.voiceOnlyFindings} voice-only</span>
              {report.evidenceCoverage.verificationSkipped > 0 && (
                <span className="rounded-full border border-amber-900/60 bg-amber-950/40 px-2.5 py-1 text-xs text-amber-300">{report.evidenceCoverage.verificationSkipped} re-check unavailable</span>
              )}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              <span className="font-semibold text-slate-300">Limits:</span>{" "}
              {assetsNotRepresented} not in key frames · {verificationSkippedCount} without AI re-check · {unresolvedCount} unresolved associations · {needsReviewCount} needing human review. Assets absent from key frames were not visually reviewed.
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              AI re-check means the model accepted the visual claim after re-reading the cited frame — it is not ground truth or engineer approval. Skipped re-checks keep findings unchanged; they never delete them.
            </p>
          </section>
        )}

        {/* ── 5 · AT A GLANCE — only when there is something to glance at */}
        {!allClear ? (
          <section aria-label="Findings at a glance" className="mt-3 grid gap-2">
            <div className="rounded-lg border border-line bg-panel px-4 py-4 sm:px-5">
              <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-steel">What we found</h2>
              <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-slate-200">
                {topDefects.map((d) => (
                  <li key={d.id} className="flex gap-2"><span className="text-steel">—</span><span>{d.title}</span></li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg border border-line bg-panel px-4 py-4 sm:px-5">
              <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-steel">Verification</h2>
              <ul className="mt-2 space-y-1 text-sm text-slate-300">
                <li>• {report.evidenceCoverage?.visualFindings ?? 0} visual · {report.evidenceCoverage?.voiceOnlyFindings ?? 0} voice-only</li>
                {verification.kept > 0 && <li>• {verification.kept} AI re-checked and kept</li>}
                {verification.downgraded > 0 && <li>• {verification.downgraded} downgraded to voice-only</li>}
                {verification.dropped > 0 && <li>• {verification.dropped} rejected by AI review</li>}
                {verification.skipped > 0 && <li>• {verification.skipped} re-check unavailable (kept, not deleted)</li>}
                {unresolvedCount > 0 && <li>• {unresolvedCount} unresolved asset association{unresolvedCount === 1 ? "" : "s"}</li>}
              </ul>
            </div>
            <div className="rounded-lg border border-line bg-panel px-4 py-4 sm:px-5">
              <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-steel">Next actions</h2>
              {nextActions.length > 0 ? (
                <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-slate-200">
                  {nextActions.map((a) => (
                    <li key={a} className="flex gap-2"><span className="text-amber-500">→</span><span>{a}</span></li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-slate-400">No corrective actions — continue routine inspections.</p>
              )}
            </div>
          </section>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-line bg-panel px-4 py-4">
              <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-steel">What we found</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">No defects confirmed across {report.inspection.totalAssetsTracked} tracked assets. Key frames and notes reviewed; nothing met the evidence bar.</p>
            </div>
            <div className="rounded-lg border border-line bg-panel px-4 py-4">
              <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-steel">Verification</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">{report.evidenceCoverage?.visualFindings ?? 0} visual · {report.evidenceCoverage?.voiceOnlyFindings ?? 0} voice-only · key frames reviewed.</p>
            </div>
            <div className="rounded-lg border border-line bg-panel px-4 py-4">
              <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-steel">Next actions</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">No corrective actions assigned — continue routine inspections.</p>
            </div>
          </div>
        )}

        {/* ── 6 · SEVERITY ──────────────────────────────────────────── */}
        <section aria-label="Severity breakdown" className="mt-3 rounded-lg border border-line bg-panel px-4 py-4 sm:px-5">
          <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-steel">Severity</h2>
          {allClear ? (
            <p className="mt-2 text-sm font-semibold text-slate-200">No defects confirmed — nothing to grade</p>
          ) : (
            <p className="mt-2 text-sm font-semibold text-slate-200">
              {totalDefects} defect{totalDefects === 1 ? "" : "s"} need{totalDefects === 1 ? "s" : ""} attention
            </p>
          )}
          <p className="mt-1 font-mono text-xs text-slate-500">
            {report.statistics.critical} critical · {report.statistics.high} high · {report.statistics.medium} medium · {report.statistics.low} low
          </p>
          <div className="mt-3">
            <SeverityChart stats={report.statistics} />
          </div>
        </section>

        {/* ── 7 · NOTICE + ACTIONS ─────────────────────────────────── */}
        <p className="mt-4 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2.5 text-xs leading-relaxed text-amber-200/90">
          AI-generated inspection support — not a certified engineering safety determination. Confirm findings on site with a qualified engineer before scheduling work.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 print:hidden">
          <button onClick={downloadCsv} className="rounded-md bg-amber-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-amber-400">
            Export CSV
          </button>
          <button onClick={() => window.print()} className="rounded-md border border-line bg-panel px-4 py-2 text-xs font-semibold text-slate-200 hover:border-slate-500">
            Print / Save as PDF
          </button>
          <a href={`/inspection/${sessionId}`} className="ml-auto text-xs font-semibold text-steel underline decoration-line underline-offset-4 hover:text-slate-300">
            Back to workspace →
          </a>
        </div>

        {/* ── 8 · DEFECTS ──────────────────────────────────────────── */}
        <section aria-label={allClear ? "Findings (none)" : "Findings"} className="mt-4 grid gap-1">
          {allClear && (
            <div className="rounded-lg border border-dashed border-line bg-panel/50 px-4 py-6 text-center">
              <p className="text-sm font-semibold text-slate-300">No defect cards — nothing met the evidence bar.</p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">This is not proof the substation is defect-free — continue routine inspections and re-fly areas not covered by key frames.</p>
            </div>
          )}
          {report.defects.map((d) => (
            <DefectCard
              key={d.id}
              defect={d}
              sessionId={sessionId}
              onSeek={(t) => router.push(`/inspection/${sessionId}?t=${Math.floor(t)}`)}
              onReviewed={(next) =>
                setReport((prev) =>
                  prev ? { ...prev, defects: prev.defects.map((x) => (x.id === next.id ? next : x)) } : prev,
                )
              }
            />
          ))}
        </section>

        <div className="mt-4">
          <RawJsonPanel json={JSON.stringify(report, null, 2)} />
        </div>
      </div>
    </main>
  );
}
