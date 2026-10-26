"use client";

// Global route error boundary: user-visible message + recovery (never blank).
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen bg-ink px-4 py-12 text-slate-100">
      <div className="mx-auto max-w-xl rounded-xl border border-red-800 bg-red-950 p-6">
        <h1 className="text-lg font-bold">Something went wrong</h1>
        <p className="mt-2 font-mono text-xs text-red-300">
          {(error.message || "Unknown error").slice(0, 300)}
        </p>
        <button
          onClick={reset}
          className="mt-4 rounded bg-amber-500 px-4 py-2 text-sm font-bold text-slate-950"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
