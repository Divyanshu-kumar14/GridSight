"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, FolderOpen } from "lucide-react";
import { useRouter } from "next/navigation";

// All-inspections dashboard (PRD §4 support feature): every session in the SQLite
// store with status + rollups, linking out to workspace and report.
interface Row {
  id: string;
  substationName: string;
  inspectorName: string;
  date: string;
  status: string;
  totalTracked: number;
  totalDefects: number;
  updatedAt: string;
}

const statusColor: Record<string, string> = {
  uploading: "bg-slate-500",
  tracking: "bg-amber-500",
  transcribing: "bg-amber-500",
  tagging: "bg-amber-500",
  generating: "bg-amber-500",
  complete: "bg-green-500",
  error: "bg-red-500",
};

export default function DashboardPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sessions")
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error?.message ?? "Failed to load sessions.");
        setRows(json.sessions as Row[]);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load sessions."));
  }, []);

  return (
    <main className="min-h-screen bg-ink text-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <button onClick={() => router.push("/")} className="inline-flex items-center gap-1 text-sm text-amber-400 underline">
          <ArrowLeft className="h-4 w-4" /> New inspection
        </button>
        <span className="micro-label mt-4 block">Fleet overview</span>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">All inspections</h1>

        {error && (
          <p role="alert" className="mt-4 rounded-md border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">{error}</p>
        )}
        {rows === null && !error && (
          <p className="mt-4 text-sm text-slate-500" role="status">Loading sessions…</p>
        )}
        {rows !== null && rows.length === 0 && (
          <div className="panel mt-4 p-6 text-center">
            <FolderOpen className="mx-auto h-6 w-6 text-slate-500" />
            <p className="mt-2 text-sm text-slate-400">No inspections yet — run your first one.</p>
            <button onClick={() => router.push("/")} className="btn-primary mt-4">Start inspection</button>
          </div>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="mt-6 space-y-3">
            {rows.map((r) => (
              <li key={r.id} className="panel p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusColor[r.status] ?? "bg-slate-500"}`} />
                  <span className="font-bold">{r.substationName}</span>
                  <span className="font-mono text-xs text-slate-500">
                    {r.inspectorName} · {r.totalTracked} assets · {r.totalDefects} defects
                  </span>
                  <span className="ml-auto flex gap-3 text-sm">
                    <button onClick={() => router.push(`/inspection/${r.id}`)} className="text-amber-400 underline">
                      Workspace
                    </button>
                    <button onClick={() => router.push(`/inspection/${r.id}/report`)} className="text-amber-400 underline">
                      Report
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
