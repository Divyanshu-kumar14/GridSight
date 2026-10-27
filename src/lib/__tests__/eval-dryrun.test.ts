import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/eval.ts executes main() on import, so the dry-run credential check
// can only be exercised as a child process. Every case below is quota-free:
// --dry-run never constructs a provider client and performs zero requests.

const REPO = process.cwd();
const TSX = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const EVAL = join(REPO, "scripts", "eval.ts");

function runEvalDryRun(args: string[], env: NodeJS.ProcessEnv, cwd: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [TSX, EVAL, "--dry-run", ...args], {
      cwd,
      env,
      timeout: 60_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as string;
    return { stdout: String(stdout), stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; status?: number };
    return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), status: e.status ?? 1 };
  }
}

function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MODEL_API_KEY;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

describe("eval --dry-run credential status", () => {
  it(
    "reports present (value undisclosed) when MODEL_API_KEY is loaded, without leaking it",
    () => {
      const sentinel = "test-sentinel-key-9f8e7d6c5b4a";
      const r = runEvalDryRun([], childEnv({ MODEL_API_KEY: sentinel }), REPO);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("credentials: present (value undisclosed)");
      expect(r.stdout).not.toContain(sentinel);
      expect(r.stderr).not.toContain(sentinel);
    },
    60_000,
  );

  it(
    "reports ABSENT when no key is available anywhere (no .env fallback in play)",
    () => {
      // Fully self-contained temp cwd: its own labels registry, frames, and
      // manifest — and crucially no .env/.env.local — so ABSENT means genuinely
      // unavailable, not an ordering artifact. No network, no fixtures touched.
      const dir = mkdtempSync(join(tmpdir(), "gridsight-dryrun-"));
      mkdirSync(join(dir, "fixtures", "eval"), { recursive: true });
      mkdirSync(join(dir, "out"), { recursive: true });
      const payloads: Record<string, string> = { "t-f001": "frame-bytes-one", "t-f002": "frame-bytes-two" };
      const frames = Object.entries(payloads).map(([frameId, body], i) => {
        const file = `frames/t-frame-${i}.jpg`;
        mkdirSync(join(dir, "frames"), { recursive: true });
        writeFileSync(join(dir, file), body);
        return {
          frameId,
          file,
          sha256: createHash("sha256").update(body, "utf8").digest("hex"),
          timestamp: i,
          scene: "test-scene",
        };
      });
      writeFileSync(
        join(dir, "fixtures", "eval", "labels.json"),
        JSON.stringify({
          sourceClip: "fixtures/eval/source.mp4",
          frames: frames.map((f) => ({ id: f.frameId, timestamp: f.timestamp, truth: [] })),
        }),
      );
      const manifestPath = join(dir, "provenance.json");
      writeFileSync(manifestPath, JSON.stringify({ sources: [{ sourceMediaId: "t", frames }] }));
      const r = runEvalDryRun(
        ["--frames=t-f001,t-f002", `--provenance-manifest=${manifestPath}`, `--cache-dir=${join(dir, "cache")}`, `--out-dir=${join(dir, "out")}`],
        childEnv({}),
        dir,
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("credentials: ABSENT");
      expect(r.stdout).not.toContain("present (value undisclosed)");
    },
    60_000,
  );

  it(
    "refuses --static-bboxes against the checked-in fixture cache before doing any work",
    () => {
      const r = runEvalDryRun(["--static-bboxes"], childEnv({ MODEL_API_KEY: "test-sentinel-key-9f8e7d6c5b4a" }), REPO);
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("credentials:");
    },
    60_000,
  );
});
