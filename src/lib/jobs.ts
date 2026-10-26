import { randomUUID } from "node:crypto";
import { getDb } from "./db";

// Contract: cancellable job records for long runs (track/report).
// Normal: create → progress* → complete|fail. Cancel: running → cancelled;
// workers poll isCancelled() and abort cooperatively. Unknown ids → fail loudly.

export type JobKind = "track" | "report";
export type JobStatus = "running" | "complete" | "error" | "cancelled";

export interface Job {
  id: string;
  sessionId: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  total: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const now = () => new Date().toISOString();

export function createJob(sessionId: string, kind: JobKind, total = 0): Job {
  const job: Job = {
    id: randomUUID(),
    sessionId,
    kind,
    status: "running",
    progress: 0,
    total,
    error: null,
    createdAt: now(),
    updatedAt: now(),
  };
  getDb().prepare(
    "INSERT INTO jobs (id, session_id, kind, status, progress, total, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(job.id, job.sessionId, job.kind, job.status, job.progress, job.total, job.error, job.createdAt, job.updatedAt);
  return job;
}

export function updateJobProgress(id: string, progress: number, total?: number): void {
  const db = getDb();
  if (total !== undefined) {
    db.prepare("UPDATE jobs SET progress = ?, total = ?, updated_at = ? WHERE id = ?").run(progress, total, now(), id);
  } else {
    db.prepare("UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?").run(progress, now(), id);
  }
}

function setStatus(id: string, status: JobStatus, error?: string): void {
  const info = getDb().prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(
    status,
    error ?? null,
    now(),
    id,
  );
  if (info.changes === 0 && getJob(id) === undefined) {
    throw new Error(`unknown job ${id}`);
  }
}

export function completeJob(id: string): void {
  setStatus(id, "complete");
}

export function failJob(id: string, error: string): void {
  setStatus(id, "error", error.slice(0, 300));
}

export function cancelJob(id: string): void {
  setStatus(id, "cancelled");
}

export function isCancelled(id: string): boolean {
  return getJob(id)?.status === "cancelled";
}

export function getJob(id: string): Job | undefined {
  const row = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapJob(row) : undefined;
}

export function getJobs(sessionId: string): Job[] {
  const rows = getDb().prepare("SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC").all(sessionId) as Record<string, unknown>[];
  return rows.map(mapJob);
}

function mapJob(r: Record<string, unknown>): Job {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    kind: r.kind as JobKind,
    status: r.status as JobStatus,
    progress: Number(r.progress),
    total: Number(r.total),
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
