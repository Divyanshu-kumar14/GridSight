"use client";

import { ArrowDown, Check, Mic, Minus } from "lucide-react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { Defect } from "@/lib/types";

// Contract: one severity-ranked defect with visuals, actions, and seek link.
// Images: real key frame + deterministic tracked-bbox overlay only.

function toDataUrl(b64: string, mime = "image/jpeg"): string {
  return `data:${mime};base64,${b64}`;
}
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

const VerifyIcon = ({ verdict }: { verdict: string }) =>
  verdict === "keep" ? (
    <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
  ) : verdict === "downgrade" ? (
    <ArrowDown className="h-3 w-3" strokeWidth={3} aria-hidden />
  ) : (
    <Minus className="h-3 w-3" strokeWidth={3} aria-hidden />
  );

export default function DefectCard({
  defect,
  onSeek,
}: {
  defect: Defect;
  onSeek: (t: number) => void;
}) {
  const box = isRenderableBox(defect.overlayBox) ? defect.overlayBox : null;
  const evidenceReason =
    defect.evidenceSource === "visual"
      ? `Visual evidence from the tracked key frame${typeof defect.evidenceFrameIndex === "number" ? ` · F${defect.evidenceFrameIndex}` : ""}.`
      : "Voice-only finding — no frame capture, inspector note only.";
  const associationReason =
    defect.assetAssociation === "unresolved"
      ? "Asset association could not be confirmed — no bounding box borrowed from another asset."
      : "Asset association confirmed against tracked IDs.";
  return (
    <Tooltip.Provider delayDuration={200}>
    <article className="panel grid overflow-hidden sm:grid-cols-3">
      {/* Left third: evidence frame, or voice-only marker */}
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
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-4 text-center">
            <Mic className="h-8 w-8 text-amber-500" strokeWidth={1.75} aria-hidden />
            <span className="font-mono text-[10px] font-bold tracking-wider text-amber-400">VOICE ONLY</span>
            <span className="text-[11px] text-slate-500">No frame capture — inspector note only.</span>
          </div>
        )}
      </div>
      {/* Right two thirds: finding */}
      <div className="p-4 sm:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-2.5 py-1 font-mono text-sm font-bold text-slate-950 ${badge[defect.severity]}`}>
            {defect.severity}
          </span>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${evidenceBadge(defect)}`}>
                {defect.evidenceSource === "visual"
                  ? `VISUAL${typeof defect.evidenceFrameIndex === "number" ? ` · F${defect.evidenceFrameIndex}` : ""}`
                  : "VOICE ONLY"}
              </span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                className="z-50 max-w-xs rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-[11px] text-slate-200 shadow-xl"
                sideOffset={4}
              >
                {evidenceReason}
                <Tooltip.Arrow className="fill-panel" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          {defect.verification && (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <span
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${verifyBadge[defect.verification.verdict] ?? verifyBadge.skipped}`}
                >
                  <VerifyIcon verdict={defect.verification.verdict} />
                  {verifyLabel[defect.verification.verdict] ?? defect.verification.verdict.toUpperCase()}
                </span>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  className="z-50 max-w-xs rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-[11px] text-slate-200 shadow-xl"
                  sideOffset={4}
                >
                  {defect.verification.reason}
                  <Tooltip.Arrow className="fill-panel" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          )}
          {defect.assetAssociation && (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <span
                  className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${associationBadge(defect)}`}
                >
                  {defect.assetAssociation === "unresolved" ? "ASSET UNCONFIRMED" : "ASSET CONFIRMED"}
                </span>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  className="z-50 max-w-xs rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-[11px] text-slate-200 shadow-xl"
                  sideOffset={4}
                >
                  {associationReason}
                  <Tooltip.Arrow className="fill-panel" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          )}
        </div>
        <h3 className="mt-2 text-base font-bold tracking-tight text-slate-100">{defect.title}</h3>
        <p className="mt-0.5 font-mono text-xs text-slate-500">
          {defect.assetId} · {defect.assetCategory}
        </p>
        {defect.observation && (
          <p className="mt-2 text-xs text-green-300/90">Observed: {defect.observation}</p>
        )}
        {defect.verification && (
          <p className="mt-1 font-mono text-[11px] text-slate-500">{defect.verification.reason}</p>
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
          <button onClick={() => onSeek(defect.frameTimestamp)} className="ml-auto font-mono text-amber-400 hover:underline">
            [view @ {fmtClock(defect.frameTimestamp)}]
          </button>
        </div>
      </div>
    </article>
    </Tooltip.Provider>
  );
}

function fmtClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
