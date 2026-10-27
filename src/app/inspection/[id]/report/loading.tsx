// Report skeleton: official header, four stat boxes, defect cards (never blank).
export default function Loading() {
  return (
    <main className="min-h-screen bg-ink px-4 py-6 text-slate-100" role="status" aria-label="Loading report">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="panel flex items-center justify-between p-4">
          <div className="h-6 w-40 animate-pulse rounded bg-slate-800" />
          <div className="h-6 w-32 animate-pulse rounded bg-amber-900/60" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="panel h-20 animate-pulse bg-slate-900/60" />
          ))}
        </div>
        <div className="panel h-10 animate-pulse bg-slate-900/60" />
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="panel h-36 animate-pulse bg-slate-900/60" />
        ))}
      </div>
    </main>
  );
}
