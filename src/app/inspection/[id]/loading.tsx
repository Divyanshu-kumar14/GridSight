// Workspace skeleton: HUD bar, video pane, tab panel (never blank).
export default function Loading() {
  return (
    <main className="min-h-screen bg-ink px-4 py-6 text-slate-100" role="status" aria-label="Loading workspace">
      <div className="mx-auto max-w-6xl">
        <div className="h-4 w-32 animate-pulse rounded bg-amber-900/60" />
        <div className="mt-2 h-7 w-56 animate-pulse rounded bg-slate-800" />
        <div className="mt-3 flex h-12 items-center gap-2 rounded-md border border-line bg-panel px-3">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-6 w-24 animate-pulse rounded-full bg-slate-800" />
          ))}
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className="panel aspect-video animate-pulse bg-slate-900/60" />
            <div className="panel mt-3 h-16 animate-pulse bg-slate-900/60" />
          </div>
          <div>
            <div className="panel h-10 animate-pulse bg-amber-900/50" />
            <div className="panel mt-3 h-64 animate-pulse bg-slate-900/60" />
          </div>
        </div>
      </div>
    </main>
  );
}
