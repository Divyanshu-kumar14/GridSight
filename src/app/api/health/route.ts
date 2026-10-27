// GET /api/health → { ok, ffmpeg, dbWritable, version }. No auth, no secrets.
// ffmpeg: ffprobe runs. dbWritable: a temp row writes to the scratch dir.
// Used by the Dockerfile HEALTHCHECK and judges hitting the live URL.

import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { DatabaseSync } from "node:sqlite";
import { ensureScratchDirs, scratchDir } from "@/lib/store";

const execFileAsync = promisify(execFile);

async function hasFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync("ffprobe", ["-version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function dbWritable(): Promise<boolean> {
  try {
    ensureScratchDirs();
    const probe = join(scratchDir(), ".health-probe.db");
    const db = new DatabaseSync(probe);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, v TEXT)");
      db.prepare("INSERT INTO probe (v) VALUES (?)").run("ok");
      db.exec("DROP TABLE probe");
    } finally {
      db.close();
    }
    await unlink(probe).catch(() => null);
    return true;
  } catch {
    return false;
  }
}

async function appVersion(): Promise<string> {
  try {
    const raw = await readFile(join(process.cwd(), "package.json"), "utf8");
    const v: unknown = JSON.parse(raw).version;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

export async function GET(): Promise<NextResponse> {
  const [ffmpeg, writable, version] = await Promise.all([
    hasFfmpeg(),
    dbWritable(),
    appVersion(),
  ]);
  const ok = ffmpeg && writable;
  return NextResponse.json(
    { ok, ffmpeg, dbWritable: writable, version },
    { status: ok ? 200 : 503 },
  );
}
