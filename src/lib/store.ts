import { mkdirSync } from "node:fs";
import { getDb } from "./db";
import {
  DefectReport,
  InspectionSession,
  TaggedNote,
  TrackedObject,
  TranscriptSegment,
} from "./types";

// Contract: session store backed by SQLite (no DB *server*; a file DB keeps
// the hackathon zero-ops while surviving restarts and recompiles).
// Same API as the old memory store, so routes are untouched.
// Normal: create/get/update round-trips, hot or cold. Empty: get on unknown → undefined/[].
// Invalid: update on unknown id → throws. Corrupt rows → logged + treated as missing.

function row<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    console.error("store: corrupt row, treating as missing:", err instanceof Error ? err.message : err);
    return fallback;
  }
}

export function createSession(session: InspectionSession): InspectionSession {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO sessions (id, data, updated_at) VALUES (?, ?, ?)").run(
    session.id,
    JSON.stringify(session),
    now,
  );
  db.prepare("INSERT OR IGNORE INTO artifacts (session_id) VALUES (?)").run(session.id);
  return session;
}

export function getSession(id: string): InspectionSession | undefined {
  const found = getDb().prepare("SELECT data FROM sessions WHERE id = ?").get(id) as
    | { data: string }
    | undefined;
  return found ? (row<InspectionSession>(found.data, undefined as never) as InspectionSession | undefined) : undefined;
}

export function updateSession(
  id: string,
  patch: Partial<InspectionSession>,
): InspectionSession {
  const existing = getSession(id);
  if (!existing) throw new Error(`updateSession: unknown session ${id}`);
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  getDb().prepare("UPDATE sessions SET data = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(next),
    next.updatedAt,
    id,
  );
  return next;
}

export function setTracking(sessionId: string, objects: TrackedObject[]): void {
  getDb().prepare("INSERT INTO artifacts (session_id, tracking) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET tracking = excluded.tracking").run(
    sessionId,
    JSON.stringify(objects),
  );
}

export function getTracking(sessionId: string): TrackedObject[] {
  const found = getDb().prepare("SELECT tracking FROM artifacts WHERE session_id = ?").get(sessionId) as
    | { tracking: string }
    | undefined;
  return found ? row<TrackedObject[]>(found.tracking, []) : [];
}

export function setTranscript(sessionId: string, segments: TranscriptSegment[]): void {
  getDb().prepare("INSERT INTO artifacts (session_id, transcript) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET transcript = excluded.transcript").run(
    sessionId,
    JSON.stringify(segments),
  );
}

export function getTranscript(sessionId: string): TranscriptSegment[] {
  const found = getDb().prepare("SELECT transcript FROM artifacts WHERE session_id = ?").get(sessionId) as
    | { transcript: string }
    | undefined;
  return found ? row<TranscriptSegment[]>(found.transcript, []) : [];
}

export function setTaggedNotes(sessionId: string, notes: TaggedNote[]): void {
  getDb().prepare("INSERT INTO artifacts (session_id, tagged) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET tagged = excluded.tagged").run(
    sessionId,
    JSON.stringify(notes),
  );
}

export function getTaggedNotes(sessionId: string): TaggedNote[] {
  const found = getDb().prepare("SELECT tagged FROM artifacts WHERE session_id = ?").get(sessionId) as
    | { tagged: string }
    | undefined;
  return found ? row<TaggedNote[]>(found.tagged, []) : [];
}

export function setReport(sessionId: string, report: DefectReport): void {
  getDb().prepare("INSERT INTO artifacts (session_id, report) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET report = excluded.report").run(
    sessionId,
    JSON.stringify(report),
  );
}

export function getReport(sessionId: string): DefectReport | undefined {
  const found = getDb().prepare("SELECT report FROM artifacts WHERE session_id = ?").get(sessionId) as
    | { report: string | null }
    | undefined;
  if (!found || found.report === null) return undefined;
  return row<DefectReport | undefined>(found.report, undefined);
}

export interface SessionSummary {
  id: string;
  substationName: string;
  inspectorName: string;
  date: string;
  status: InspectionSession["status"];
  totalTracked: number;
  totalDefects: number;
  updatedAt: string;
  isSample?: boolean;
}

// Dashboard feed: every session + rollup counts, newest first.
// Single query — counts computed in SQL (json_array_length), no per-session
// round-trips and no full-JSON parses (was 2N+1 queries before).
export function listSessions(): SessionSummary[] {
  const rows = getDb().prepare(`
    SELECT s.id, s.data, s.updated_at,
      COALESCE(json_array_length(a.tracking), 0) AS tracked,
      COALESCE(json_array_length(a.report, '$.defects'), 0) AS defects
    FROM sessions s LEFT JOIN artifacts a ON a.session_id = s.id
    ORDER BY s.updated_at DESC, s.rowid DESC
  `).all() as {
    id: string;
    data: string;
    updated_at: string;
    tracked: number;
    defects: number;
  }[];
  return rows.map((r) => {
    const s = row<InspectionSession>(r.data, undefined as never);
    return {
      id: r.id,
      substationName: s?.substationName ?? "(unknown)",
      inspectorName: s?.inspectorName ?? "(unknown)",
      date: s?.date ?? "",
      status: s?.status ?? "error",
      totalTracked: r.tracked,
      totalDefects: r.defects,
      updatedAt: r.updated_at,
      isSample: s?.isSample === true,
    };
  });
}

// Filesystem scratch dirs (frame captures, audio, video, report JSON snapshots).
// Idempotent: safe to call on every boot.
function baseDir(): string {
  return process.env.GRIDSIGHT_TMP_DIR ?? "/tmp/opencode/gridsight";
}

export function ensureScratchDirs(): string {
  const dir = baseDir();
  mkdirSync(`${dir}/frames`, { recursive: true });
  mkdirSync(`${dir}/reports`, { recursive: true });
  mkdirSync(`${dir}/audio`, { recursive: true });
  mkdirSync(`${dir}/video`, { recursive: true });
  return dir;
}

export function scratchDir(): string {
  return baseDir();
}
