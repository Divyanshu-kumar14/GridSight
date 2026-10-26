import { DatabaseSync } from "node:sqlite";

// Contract: SQLite engine for GridSight (zero-dep via node:sqlite, WAL mode).
// Tables: sessions (one row per inspection), artifacts (tracking/transcript/tagged/
// report JSON per session), jobs (track/report runs with progress + cancel).
// Normal: first call opens + migrates. Invalid DB file → throws loudly on boot.

let db: DatabaseSync | null = null;
let dbPath = "";

export function dbPathFor(): string {
  if (process.env.GRIDSIGHT_DB_PATH) return process.env.GRIDSIGHT_DB_PATH;
  const base = process.env.GRIDSIGHT_TMP_DIR ?? "/tmp/opencode/gridsight";
  return `${base}/gridsight.db`;
}

export function getDb(): DatabaseSync {
  const path = dbPathFor();
  if (db && dbPath === path) return db;
  if (db) db.close();
  db = new DatabaseSync(path);
  dbPath = path;
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      session_id TEXT PRIMARY KEY,
      tracking TEXT NOT NULL DEFAULT '[]',
      transcript TEXT NOT NULL DEFAULT '[]',
      tagged TEXT NOT NULL DEFAULT '[]',
      report TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      progress INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id);
  `);
  return db;
}

// Test-only: close so a fresh open simulates a process restart.
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    dbPath = "";
  }
}
