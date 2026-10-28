"use client";

import type { TrackedObject } from "@/lib/types";

export default function Timeline({
  objects,
  duration,
  currentTime,
  onSeek,
  loading = false,
}: {
  objects: TrackedObject[];
  duration: number;
  currentTime: number;
  onSeek: (t: number) => void;
  loading?: boolean;
}) {
  if (loading && objects.length === 0) {
    return (
      <div className="rounded-md border border-line bg-panel p-3" aria-busy="true" aria-label="Timeline loading">
        <div className="space-y-1.5" aria-hidden>
          {[92, 78, 64, 84, 58, 70].map((w) => (
            <div key={w} className="h-1.5 animate-pulse rounded bg-slate-800" style={{ width: `${w}%` }} />
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">Tracking in progress — lanes appear here as assets are detected.</p>
      </div>
    );
  }
  if (objects.length === 0 || !(duration > 0)) {
    return (
      <div className="rounded-md border border-dashed border-line bg-panel px-3 py-4 text-center">
        <p className="text-xs font-semibold text-slate-300">Timeline appears after tracking</p>
        <p className="mx-auto mt-1 max-w-[42ch] text-xs leading-relaxed text-slate-500">Lanes show where each asset is visible. Click to seek once lanes exist.</p>
      </div>
    );
  }
  const clampT = (t: number) => Math.min(duration, Math.max(0, t));
  const toPct = (t: number) => `${(clampT(t) / duration) * 100}%`;

  return (
    <div className="rounded-md border border-line bg-panel p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-steel">Timeline</span>
        <span className="font-mono text-[11px] text-slate-500">{objects.length} lanes · {duration.toFixed(1)}s</span>
      </div>
      <div
        className="relative h-14 cursor-pointer overflow-hidden rounded bg-ink"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek(clampT(((e.clientX - rect.left) / rect.width) * duration));
        }}
        role="slider"
        aria-label="Video timeline"
        aria-valuenow={Math.round(currentTime)}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
      >
        {objects.slice(0, 60).map((o) => {
          const start = o.frames[0] ? o.frames[0].timestamp : 0;
          const end = o.frames[o.frames.length - 1] ? o.frames[o.frames.length - 1].timestamp : start;
          return (
            <div
              key={o.id}
              title={`${o.id} (${o.category})`}
              className="absolute h-1.5 rounded"
              style={{ left: toPct(start), width: `max(2px, ${(Math.max(end - start, 0.05) / duration) * 100}%)`, top: `${6 + (hash(o.id) % 32)}px`, background: o.color, opacity: 0.9 }}
            />
          );
        })}
        <div className="absolute inset-y-0 w-0.5 bg-amber-500" style={{ left: toPct(currentTime) }} />
      </div>
    </div>
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
