// Landing skeleton: header, hero copy + feed, model cards (never blank).
export default function Loading() {
  return (
    <main className="min-h-screen bg-ink px-4 py-6 text-slate-100" role="status" aria-label="Loading GridSight">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center gap-2 border-b border-line pb-4">
          <div className="h-5 w-5 animate-pulse rounded bg-amber-900/70" />
          <div className="h-5 w-28 animate-pulse rounded bg-slate-800" />
          <div className="ml-auto h-8 w-32 animate-pulse rounded bg-amber-900/60" />
        </div>
        <div className="grid items-center gap-10 pt-14 lg:grid-cols-2">
          <div>
            <div className="h-12 w-4/5 animate-pulse rounded bg-slate-800" />
            <div className="mt-3 h-12 w-3/5 animate-pulse rounded bg-slate-800" />
            <div className="mt-5 h-5 w-full animate-pulse rounded bg-slate-900" />
            <div className="mt-8 h-10 w-48 animate-pulse rounded bg-amber-900/60" />
          </div>
          <div className="panel h-80 animate-pulse bg-slate-900/60" />
        </div>
        <div className="mt-14 grid gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="panel h-36 animate-pulse bg-slate-900/60" />
          ))}
        </div>
      </div>
    </main>
  );
}
