"use client";

import { toDataUrl } from "@/lib/images";
import type { Defect } from "@/lib/types";

// Contract: one severity-ranked defect with visuals, actions, and seek link.
// Images: real key frame + deterministic tracked-bbox overlay. A legacy
// annotatedImage (Muse Image) renders ONLY inside a labeled <details> toggle —
// it is an AI-generated illustration, never evidence.
const badge: Record<Defect["severity"], string> = {
  CRITICAL: "bg-red-600",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-yellow-500",
  LOW: "bg-green-600",
};

const evidenceBadge = (d: Defect) =>
  d.evidenceSource === "visual"
    ? "border-green-500 text-green-400"
    : "border-amber-500/60 text-amber-400";

const associationBadge = (d: Defect) =>
  d.assetAssociation === "unresolved"
    ? "border-slate-500 text-slate-400"
    : d.assetAssociation === "confirmed"
      ? "border-sky-500/60 text-sky-300"
      : "border-slate-700 text-slate-600";

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

const verifyBadge: Record<string, string> = {
  keep: "border-green-500 text-green-400",
  downgrade: "border-amber-500/60 text-amber-400",
  skipped: "border-slate-600 text-slate-500",
  drop: "border-slate-600 text-slate-500",
};

const verifyLabel: Record<string, string> = {
  keep: "VERIFIED",
  downgrade: "DOWNGRADED",
  skipped: "SKIPPED",
  drop: "DROPPED",
};

export default function DefectCard({
  defect,
  onSeek,
}: {
  defect: Defect;
  onSeek: (t: number) => void;
}) {
  const box = isRenderableBox(defect.overlayBox) ? defect.overlayBox : null;
  return (
    <article className="panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 font-mono text-xs font-bold text-slate-950 ${badge[defect.severity]}`}>
          {defect.severity}
        </span>
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${evidenceBadge(defect)}`}>
          {defect.evidenceSource === "visual" ? "VISUAL" : "VOICE ONLY"}
        </span>
        {defect.assetAssociation && (
          <span
            title={
              defect.assetAssociation === "unresolved"
                ? "Asset association could not be confirmed — no bounding box borrowed from another asset."
                : "Asset association confirmed against tracked IDs."
            }
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${associationBadge(defect)}`}
          >
            {defect.assetAssociation === "unresolved" ? "ASSET UNCONFIRMED" : "ASSET CONFIRMED"}
          </span>
        )}
        <h3 className="text-sm font-bold tracking-tight text-slate-100">{defect.title}</h3>
        <span className="ml-auto font-mono text-xs text-slate-500">
          {defect.assetId} · {defect.assetCategory}
        </span>
      </div>
      {defect.observation && (
        <p className="mt-2 text-xs text-green-300/90">
          Observed: {defect.observation}{" "}
          {typeof defect.evidenceFrameIndex === "number" && (
            <span className="font-mono text-slate-500">[frame {defect.evidenceFrameIndex}]</span>
          )}
        </p>
      )}
      {defect.verification && (
        <p className="mt-2" title={defect.verification.reason}>
          <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${verifyBadge[defect.verification.verdict] ?? verifyBadge.skipped}`}>
            {verifyLabel[defect.verification.verdict] ?? defect.verification.verdict.toUpperCase()}
          </span>{" "}
          <span className="font-mono text-[11px] text-slate-500">{defect.verification.reason}</span>
        </p>
      )}
      {defect.frameCapture ? (
        <div className="relative mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={toDataUrl(defect.frameCapture)}
            alt={`Key frame for ${defect.title}`}
            className="aspect-video max-h-64 w-full rounded-md border border-line object-contain bg-black"
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
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-line p-3 text-xs text-slate-500">No frame capture available.</p>
      )}
      {defect.annotatedImage && (
        <details className="mt-2 text-xs text-slate-500">
          <summary className="cursor-pointer hover:text-slate-300">
            AI-generated illustration (not evidence)
          </summary>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={toDataUrl(defect.annotatedImage)}
            alt="AI-generated illustration, not inspection evidence"
            className="mt-2 aspect-video max-h-64 w-full rounded-md border border-dashed border-slate-700 object-contain bg-black opacity-80"
          />
        </details>
      )}
      <p className="mt-3 text-sm text-slate-300">{defect.description}</p>
      {defect.voiceNoteExcerpt && (
        <blockquote className="mt-2 border-l border-amber-500/60 pl-2 text-xs italic text-slate-400">
          “{defect.voiceNoteExcerpt}”
        </blockquote>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-400">Action: <span className="text-slate-200">{defect.recommendedAction}</span></span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">{defect.estimatedUrgency}</span>
        <button onClick={() => onSeek(defect.frameTimestamp)} className="ml-auto font-mono text-amber-400 hover:underline">
          [view @ {fmtClock(defect.frameTimestamp)}]
        </button>
      </div>
    </article>
  );
}

function fmtClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
