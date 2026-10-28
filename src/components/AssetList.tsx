"use client";

import { useMemo, useState } from "react";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { TrackedObject } from "@/lib/types";

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
      <div className="rounded-md border border-dashed border-line bg-panel p-6 text-center">
        <p className="text-sm font-semibold text-slate-200">No assets yet</p>
        <p className="mx-auto mt-1 max-w-[40ch] text-xs leading-relaxed text-slate-500">Run tracking — detected assets appear here with thumbnails and frame counts.</p>
        <div className="pointer-events-none relative mt-3 overflow-hidden rounded bg-ink py-3" aria-hidden>
          <div className="absolute left-0 h-6 w-full border-y border-amber-500/20 bg-amber-500/10" style={{ top: 6, animation: "gs-scan 5.5s cubic-bezier(0.4, 0, 0.2, 1) infinite" }} />
          <span className="relative text-xs text-slate-500">Awaiting detection…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-line bg-panel p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-bold tracking-wide text-slate-200">Assets</span>
        <span className="rounded-full bg-ink px-2 py-0.5 font-mono text-[11px] text-steel">{visible.length} of {objects.length}</span>
        <Select.Root value={filter} onValueChange={setFilter}>
          <Select.Trigger
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-line bg-ink px-2 py-1 text-xs text-slate-200 hover:border-slate-500 data-[placeholder]:text-slate-400"
            aria-label="Filter by category"
          >
            <Select.Value />
            <Select.Icon><ChevronDown className="h-3 w-3" /></Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              className="overflow-hidden rounded-md border border-line bg-panel shadow-xl z-50"
              position="popper"
              sideOffset={4}
            >
              <Select.Viewport className="p-1">
                {["all", ...categories].map((c) => (
                  <Select.Item
                    key={c}
                    value={c}
                    className="relative flex cursor-pointer select-none items-center rounded px-6 py-1.5 text-xs text-slate-200 outline-none data-[highlighted]:bg-amber-500/10 data-[highlighted]:text-amber-300"
                  >
                    <Select.ItemText>{c}</Select.ItemText>
                    <Select.ItemIndicator className="absolute left-1.5">
                      <Check className="h-3 w-3 text-amber-400" />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </div>
      <ScrollArea.Root className="h-80">
        <ScrollArea.Viewport className="h-full w-full">
          <ul className="grid grid-cols-2 gap-2 pr-3">
            {visible.map((o) => (
              <li key={o.id}>
                <button
                  onClick={() => onSelect(o.id)}
                  className={`group h-full w-full overflow-hidden rounded-md border bg-ink p-2 text-left transition-colors ${selectedId === o.id ? "border-amber-500 ring-1 ring-amber-500/30" : "border-line hover:border-slate-500"}`}
                >
                  {thumbs?.[o.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumbs[o.id]} alt="" className="mb-2 aspect-video w-full rounded object-cover" loading="lazy" />
                  ) : (
                    <span className="mb-2 block aspect-video w-full rounded bg-slate-900" aria-hidden />
                  )}
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: o.color }} />
                    <span className="truncate font-mono text-xs text-slate-200">{o.id}</span>
                  </span>
                  <span className="mt-1 flex items-center justify-between text-xs">
                    <span className="truncate text-slate-400">{o.category}</span>
                    <span className="ml-2 shrink-0 font-mono text-slate-500">{o.totalFrameCount}f</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar className="flex w-1.5 touch-none select-none p-0.5" orientation="vertical">
          <ScrollArea.Thumb className="relative flex-1 rounded-full bg-slate-700 hover:bg-slate-500 transition-colors" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </div>
  );
}
