// Global loading state for route transitions (never blank).
export default function Loading() {
  return (
    <main className="min-h-screen bg-ink px-4 py-12 text-slate-100">
      <div className="mx-auto max-w-xl text-sm text-slate-400" role="status" aria-live="polite">
        Loading GridSight…
      </div>
    </main>
  );
}
