"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Defect } from "@/lib/types";

// Contract: one severity-ranked defect as a departure-board open row.
// Collapsed = 72px row band; expanded = 216px+ evidence detail. Rows stack
// with 4px gaps via the parent grid. Status is a solid severity block on the
// left edge — no glow, no gradient, no shadow. Mono is reserved for asset /
// frame ids, timestamps, and model ids only.
// Images: real key frame + deterministic tracked-bbox overlay only.

function toDataUrl(b64: string, mime = "image/jpeg"): string {
  return `data:${mime};base64,${b64}`;
}

const severityBlock: Record<Defect["severity"], string> = {
  CRITICAL: "bg-red-600",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-yellow-500",
  LOW: "bg-green-600",
};

const severityText: Record<Defect["severity"], string> = {
  CRITICAL: "text-red-400",
  HIGH: "text-orange-400",
  MEDIUM: "text-yellow-400",
  LOW: "text-green-400",
};

const verifyLabel: Record<string, string> = {
  keep: "AI RE-CHECKED",
  downgrade: "DOWNGRADED TO VOICE-ONLY",
  skipped: "RE-CHECK UNAVAILABLE",
  drop: "REJECTED BY AI REVIEW",
};

const verifyExplain: Record<string, string> = {
  keep: "AI re-checked the cited frame and accepted the visual claim. Not independent ground truth or engineer approval.",
  downgrade:
    "AI review could not confirm the visual claim — kept as a voice-only note, not visual evidence.",
  skipped:
    "AI re-check did not run or failed — finding kept unchanged. Absence of a re-check is not proof for or against the defect.",
  drop: "AI review rejected the visual claim.",
};

function isRenderableBox(box: Defect["overlayBox"]): boolean {
  if (!box) return false;
  const { x, y, w, h } = box;
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    x >= 0 &&
    x <= 1 &&
    y >= 0 &&
    y <= 1 &&
    w > 0 &&
    w <= 1 &&
    h > 0 &&
    h <= 1 &&
    x + w <= 1 + 1e-6 &&
    y + h <= 1 + 1e-6
  );
}

export default function DefectCard({
  defect,
  onSeek,
  sessionId,
  onReviewed,
}: {
  defect: Defect;
  onSeek: (t: number) => void;
  sessionId?: string;
  onReviewed?: (next: Defect) => void;
}) {
  // Evidence-first: rows open on the detail so the frame/observation is
  // visible on first paint; collapse to the 72px row on demand.
  const [open, setOpen] = useState(true);
  const box = isRenderableBox(defect.overlayBox) ? defect.overlayBox : null;
  const evidenceReason =
    defect.evidenceSource === "visual"
      ? "Visual evidence from the tracked key frame."
      : "Voice-only finding — no frame capture, inspector note only.";
  const associationReason =
    defect.assetAssociation === "unresolved"
      ? "Asset association could not be confirmed — no bounding box borrowed from another asset."
      : "Asset association confirmed against tracked IDs.";
  return (
    <article
      aria-label={`${defect.severity} finding: ${defect.title}`}
      className="board-row items-stretch overflow-hidden p-0"
    >
      {/* Status solid block */}
      <span aria-hidden className={`w-2 shrink-0 self-stretch ${severityBlock[defect.severity]}`} />
      <div className="min-w-0 flex-1">
        {/* 72px row band */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-h-[72px] w-full items-center gap-3 px-3 py-2 text-left"
        >
          <span className={`shrink-0 text-xs font-bold tracking-wide ${severityText[defect.severity]}`}>
            {defect.severity}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold text-slate-100">{defect.title}</span>
            <span className="mt-0.5 block truncate font-mono text-[11px] text-slate-500">
              {defect.assetId} · {defect.assetCategory}
              {typeof defect.evidenceFrameIndex === "number" ? ` · F${defect.evidenceFrameIndex}` : ""}
            </span>
          </span>
          <span className="hidden shrink-0 items-center gap-1.5 sm:inline-flex" aria-label="Evidence flags">
            <span
              title={evidenceReason}
              className={
                defect.evidenceSource === "visual"
                  ? "rounded border border-green-500 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-green-400"
                  : "rounded border border-amber-500/60 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-amber-400"
              }
            >
              {defect.evidenceSource === "visual" ? "VISUAL" : "VOICE ONLY"}
            </span>
            {defect.verification && (
              <span
                title={defect.verification.reason}
                className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-slate-400"
              >
                {verifyLabel[defect.verification.verdict] ?? defect.verification.verdict.toUpperCase()}
              </span>
            )}
            {defect.assetAssociation && (
              <span
                title={associationReason}
                className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-slate-500"
              >
                {defect.assetAssociation === "unresolved" ? "ASSET UNCONFIRMED" : "ASSET CONFIRMED"}
              </span>
            )}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-amber-400">
            {fmtClock(defect.frameTimestamp)}
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>
        {/* 216px open detail */}
        {open && (
          <div className="min-h-[216px] border-t border-line px-3 py-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="relative bg-black">
                {defect.frameCapture ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={toDataUrl(defect.frameCapture)}
                      alt={`Key frame for ${defect.title}`}
                      className="h-full min-h-40 w-full object-contain"
                    />
                    {box && (
                      <div
                        aria-hidden
                        className="pointer-events-none absolute rounded-sm border-2 border-red-500"
                        style={{
                          left: `${box.x * 100}%`,
                          top: `${box.y * 100}%`,
                          width: `${box.w * 100}%`,
                          height: `${box.h * 100}%`,
                        }}
                      >
                        <span className="absolute -top-5 left-0 whitespace-nowrap font-mono text-[10px] font-bold text-red-400">
                          {defect.assetId} @ {fmtClock(defect.frameTimestamp)}
                        </span>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="flex h-full min-h-40 items-center justify-center p-4 text-center text-[11px] font-bold tracking-wider text-amber-400">
                    VOICE ONLY — NO FRAME CAPTURE
                  </p>
                )}
              </div>
              <div className="sm:col-span-2">
                <p className="text-[11px] leading-relaxed text-slate-500">{evidenceReason}</p>
                {defect.verification && (
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                    {verifyExplain[defect.verification.verdict] ?? ""} {defect.verification.reason}
                  </p>
                )}
                {defect.assetAssociation && (
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{associationReason}</p>
                )}
                <h3 className="mt-2 text-base font-bold tracking-tight text-slate-100">{defect.title}</h3>
                <p className="mt-0.5 font-mono text-xs text-slate-500">
                  {defect.assetId} · {defect.assetCategory}
                </p>
                {defect.observation && (
                  <p className="mt-2 text-xs text-green-300/90">Observed: {defect.observation}</p>
                )}
                <p className="mt-2 text-sm text-slate-300">{defect.description}</p>
                {defect.voiceNoteExcerpt && (
                  <blockquote className="mt-2 border-l border-amber-500/60 pl-2 text-xs italic text-slate-400">
                    “{defect.voiceNoteExcerpt}”
                  </blockquote>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-400">Action: <span className="text-slate-200">{defect.recommendedAction}</span></span>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">{defect.estimatedUrgency}</span>
                  <button onClick={() => onSeek(defect.frameTimestamp)} className="ml-auto text-amber-400 hover:underline">
                    [view @ <span className="font-mono">{fmtClock(defect.frameTimestamp)}</span>]
                  </button>
                </div>
                {defect.humanReview && (
                  <p className="mt-2 rounded-md border border-sky-800 bg-sky-950/50 px-2 py-1.5 text-[11px] text-sky-200">
                    Reviewer: {defect.humanReview.status}
                    {defect.humanReview.note ? ` — ${defect.humanReview.note}` : ""}
                    {defect.humanReview.correctedAssetId ? ` · asset → ${defect.humanReview.correctedAssetId}` : ""}
                    <span className="block font-mono text-[10px] text-sky-300/70">{defect.humanReview.updatedAt}</span>
                  </p>
                )}
                {sessionId && (
                  <ReviewControls defect={defect} sessionId={sessionId} onReviewed={onReviewed} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function ReviewControls({
  defect,
  sessionId,
  onReviewed,
}: {
  defect: Defect;
  sessionId: string;
  onReviewed?: (next: Defect) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState(defect.humanReview?.note ?? "");
  const [asset, setAsset] = useState(defect.humanReview?.correctedAssetId ?? "");
  const [desc, setDesc] = useState(defect.humanReview?.correctedDescription ?? "");
  const [action, setAction] = useState(defect.humanReview?.correctedAction ?? "");

  const submit = async (status: "confirmed" | "rejected" | "needs-inspection") => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/report-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          defectId: defect.id,
          status,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(asset.trim() ? { correctedAssetId: asset.trim() } : {}),
          ...(desc.trim() ? { correctedDescription: desc.trim() } : {}),
          ...(action.trim() ? { correctedAction: action.trim() } : {}),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error?.message ?? `Review failed (${res.status}).`);
      onReviewed?.(json.defect as Defect);
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Review failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t border-line pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="micro-label">Human review</span>
        <span className="text-[10px] text-slate-500">
          {defect.humanReview ? defect.humanReview.status : "unreviewed"} · distinct from AI re-check
        </span>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="ml-auto text-[11px] font-semibold text-amber-400 hover:underline"
        >
          {open ? "Close" : defect.humanReview ? "Update review" : "Review"}
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          <label className="block">
            <span className="micro-label mb-1 block">Reviewer note (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. confirmed on site, rust visible at cap"
              maxLength={2000}
              className="w-full rounded-md border border-line bg-ink px-2 py-1.5 text-xs text-slate-200"
            />
          </label>
          <label className="block">
            <span className="micro-label mb-1 block">Corrected asset ID (optional)</span>
            <input
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
              placeholder={defect.assetId}
              maxLength={120}
              className="w-full rounded-md border border-line bg-ink px-2 py-1.5 font-mono text-xs text-slate-200"
            />
          </label>
          <label className="block">
            <span className="micro-label mb-1 block">Corrected description (optional)</span>
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Corrected finding text"
              maxLength={5000}
              className="w-full rounded-md border border-line bg-ink px-2 py-1.5 text-xs text-slate-200"
            />
          </label>
          <label className="block">
            <span className="micro-label mb-1 block">Corrected action (optional)</span>
            <input
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="Corrected recommended action"
              maxLength={2000}
              className="w-full rounded-md border border-line bg-ink px-2 py-1.5 text-xs text-slate-200"
            />
          </label>
          {err && <p role="alert" className="text-[11px] text-red-400">{err}</p>}
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => void submit("confirmed")} className="rounded bg-green-600 px-2.5 py-1 text-xs font-bold text-white disabled:opacity-40">
              Confirm
            </button>
            <button disabled={busy} onClick={() => void submit("needs-inspection")} className="rounded bg-amber-500 px-2.5 py-1 text-xs font-bold text-slate-950 disabled:opacity-40">
              Needs inspection
            </button>
            <button disabled={busy} onClick={() => void submit("rejected")} className="rounded border border-line px-2.5 py-1 text-xs font-semibold text-slate-300 disabled:opacity-40">
              Reject
            </button>
          </div>
          <p className="text-[10px] text-slate-500">Original AI fields + verification history stay intact for audit — review is stored separately.</p>
        </div>
      )}
    </div>
  );
}

function fmtClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
