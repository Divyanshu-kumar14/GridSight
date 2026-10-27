"use client";

import { useMemo, useState } from "react";
import type { TrackedObject } from "@/lib/types";

// Contract: filterable tracked-object list. Click → onSelect(id) for seek/highlight.
// Empty: "no objects" message (never blank).
export default function AssetList({
  objects,
  selectedId,
  thumbs,
  onSelect,
}: {
  objects: TrackedObject[];
  selectedId: string | null;
  thumbs?: Record<string, string>;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const categories = useMemo(
    () => Array.from(new Set(objects.map((o) => o.category))).sort(),
    [objects],
  );
  const visible = filter === "all" ? objects : objects.filter((o) => o.category === filter);

  if (objects.length === 0) {
    return (
      <div className="panel p-4">
        <div className="relative overflow-hidden rounded-md border border-dashed border-amber-500/60 p-6 text-center">
          <div
            className="pointer-events-none absolute left-0 h-8 w-full border-y border-amber-500/25 bg-amber-500/10"
            style={{ top: 0, animation: "gs-scan 5.5s cubic-bezier(0.4, 0, 0.2, 1) infinite" }}
            aria-hidden
          />
          <p className="relative text-sm text-slate-300">Start tracking to detect assets.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-semibold text-slate-200">Assets ({visible.length})</span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="ml-auto rounded-md border border-line bg-ink px-2 py-1 text-xs text-slate-200"
          aria-label="Filter by category"
        >
          <option value="all">all</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <ul className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto">
        {visible.map((o) => (
          <li key={o.id}>
            <button
              onClick={() => onSelect(o.id)}
              className={`h-full w-full rounded-md border border-line bg-ink p-2 text-left text-xs transition-colors hover:border-slate-500 ${selectedId === o.id ? "border-amber-500" : ""}`}
            >
              {thumbs?.[o.id] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumbs[o.id]} alt="" className="mb-2 aspect-video w-full rounded object-cover" loading="lazy" />
              ) : (
                <span className="mb-2 block aspect-video w-full rounded bg-slate-900" aria-hidden />
              )}
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: o.color }} />
                <span className="truncate font-mono text-slate-200">{o.id}</span>
              </span>
              <span className="mt-1 flex items-center justify-between text-slate-400">
                <span className="truncate">{o.category}</span>
                <span className="ml-2 shrink-0 font-mono text-slate-500">{o.totalFrameCount}f</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
