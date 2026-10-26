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
        <span className="micro-label">Assets</span>
        <p className="mt-1 text-sm text-slate-500">No tracked objects yet — click “Start Tracking”.</p>
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
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {visible.map((o) => (
          <li key={o.id}>
            <button
              onClick={() => onSelect(o.id)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-slate-800 ${selectedId === o.id ? "bg-slate-800" : ""}`}
            >
              <span className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ background: o.color }} />
              {thumbs?.[o.id] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumbs[o.id]} alt="" className="h-8 w-10 shrink-0 rounded object-cover" loading="lazy" />
              ) : null}
              <span className="font-mono text-slate-200">{o.id}</span>
              <span className="text-slate-400">{o.category}</span>
              <span className="ml-auto font-mono text-slate-500">{o.totalFrameCount}f</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
