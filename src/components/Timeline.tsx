"use client";

import type { TrackedObject } from "@/lib/types";

// Contract: appearance spans per object across video duration; click seeks.
// Empty (no duration/objects): hint message. Invalid t: clamped into [0, duration].
export default function Timeline({
  objects,
  duration,
  currentTime,
  onSeek,
}: {
  objects: TrackedObject[];
  duration: number;
  currentTime: number;
  onSeek: (t: number) => void;
}) {
  if (objects.length === 0 || !(duration > 0)) {
    return (
      <div className="panel p-3 text-xs text-slate-500">
        Timeline appears after tracking — markers show where each asset is visible.
      </div>
    );
  }
  const clampT = (t: number) => Math.min(duration, Math.max(0, t));
  const toPct = (t: number) => `${(clampT(t) / duration) * 100}%`;

  return (
    <div
      className="panel relative h-16 cursor-pointer"
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
            style={{ left: toPct(start), width: `max(2px, ${(Math.max(end - start, 0.05) / duration) * 100}%)`, top: `${8 + (hash(o.id) % 36)}px`, background: o.color, opacity: 0.85 }}
          />
        );
      })}
      <div className="absolute inset-y-0 w-0.5 bg-amber-500" style={{ left: toPct(currentTime) }} />
    </div>
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
