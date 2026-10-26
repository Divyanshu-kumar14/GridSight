"use client";

import { toDataUrl } from "@/lib/images";
import type { Defect } from "@/lib/types";

// Contract: one severity-ranked defect with visuals, actions, and seek link.
// Images: annotated preferred, frame capture fallback, placeholder when neither.
const badge: Record<Defect["severity"], string> = {
  CRITICAL: "bg-red-600",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-yellow-500",
  LOW: "bg-green-600",
};

export default function DefectCard({
  defect,
  onSeek,
}: {
  defect: Defect;
  onSeek: (t: number) => void;
}) {
  const img = defect.annotatedImage ?? defect.frameCapture;
  return (
    <article className="panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 font-mono text-xs font-bold text-slate-950 ${badge[defect.severity]}`}>
          {defect.severity}
        </span>
        <h3 className="text-sm font-bold tracking-tight text-slate-100">{defect.title}</h3>
        <span className="ml-auto font-mono text-xs text-slate-500">
          {defect.assetId} · {defect.assetCategory}
        </span>
      </div>
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={toDataUrl(img)}
          alt={`Annotated frame for ${defect.title}`}
          className="mt-3 aspect-video max-h-64 w-full rounded-md border border-line object-contain bg-black"
        />
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-line p-3 text-xs text-slate-500">No frame capture available.</p>
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
