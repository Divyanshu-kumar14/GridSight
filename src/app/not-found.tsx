import Link from "next/link";

// 404 state (never blank).
export default function NotFound() {
  return (
    <main className="min-h-screen bg-ink px-4 py-12 text-slate-100">
      <div className="panel mx-auto max-w-xl p-6">
        <h1 className="text-lg font-bold">Page not found</h1>
        <p className="mt-2 text-sm text-slate-400">
          This inspection link doesn&apos;t match anything. Start a new inspection instead.
        </p>
        <Link href="/" className="mt-4 inline-block rounded bg-amber-500 px-4 py-2 text-sm font-bold text-slate-950">
          New inspection
        </Link>
      </div>
    </main>
  );
}
