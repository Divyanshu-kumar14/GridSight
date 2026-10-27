"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { GripVertical } from "lucide-react";

// Contract: responsive two-pane workspace shell. No content logic lives here —
// callers pass fully-formed `left`/`right` trees and this only owns the split.
// Normal (md+): horizontal resizable Group, layout persisted to localStorage.
// Narrow (<md): plain stacked div, no resize machinery. SSR/pre-mount: stacked
// (matches server HTML, so hydration never diverges).

// useDefaultLayout defaults `storage` to `localStorage`, which throws at SSR
// render time — swap in a no-op store on the server. The Group only mounts
// post-hydration anyway, so the server snapshot (null) is always consistent.
const ssrStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: () => null,
  setItem: () => {},
};

export default function WorkspaceSplit({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}): JSX.Element {
  const [mounted, setMounted] = useState(false);
  const [wide, setWide] = useState(false);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "gridsight-workspace",
    storage: typeof window === "undefined" ? ssrStorage : window.localStorage,
  });

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Stacked until mounted (SSR-identical), and on narrow viewports after that.
  if (!mounted || !wide) {
    return (
      <div className="mt-4 space-y-3">
        {left}
        {right}
      </div>
    );
  }

  return (
    <Group
      id="gridsight-workspace"
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className="mt-4"
    >
      <Panel id="workspace-main" defaultSize="65%" minSize="40%" maxSize="80%" className="min-w-0">
        {left}
      </Panel>
      <Separator
        id="workspace-separator"
        className="group flex w-2 items-center justify-center"
        style={{ borderLeft: "1px solid var(--line)", background: "transparent", cursor: "col-resize" }}
      >
        <GripVertical className="h-4 w-4 text-slate-600 group-hover:text-amber-400 group-data-[separator=active]:text-amber-400 group-data-[separator=focus]:text-amber-400" />
      </Separator>
      <Panel id="workspace-side" minSize="20%" className="min-w-0">
        {right}
      </Panel>
    </Group>
  );
}
