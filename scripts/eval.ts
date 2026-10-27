// GridSight eval — Mode C (visual) + cached re-scoring.
// Modes: `npx tsx scripts/eval-smoke.ts` = Mode A smoke (no inference).
// `npx tsx scripts/bench.ts` = Mode B synthetic ground-truth benchmark.
// This file = Mode C visual (30 labeled frames) + its cached re-scoring:
//   cached (default): re-scores RECORDED model outputs in fixtures/eval/cache/.
//     Zero quota, zero network. Measures the verification pass on old outputs —
//     NOT live detection accuracy. Never present as real-world accuracy.
//   --live: makes real Meta calls (bounded: at most 4 calls per frame).
// Clip: fixtures/eval/source.mp4, built from three CC-licensed Wikimedia Commons
// photos (Ken Burns zoompan, 10s each, 30s total):
//   insulators.jpg — "Rows of insulators" (geograph 6720396, CC BY-SA 2.0)
//   switchyard.png — "Switchyard of electric substation 750kV" (CC BY 4.0)
//   slunj.jpg      — "Power substation Slunj" (CC BY-SA 4.0)
// Labels (fixtures/eval/labels.json) were set by viewing the extracted frames
// BEFORE any model run and are never tuned to outputs: f001–f020 clean (healthy
// insulators + switchyard), f021–f030 defective (visibly rust-streaked pole).
// Unit of evaluation here is one FRAME; f021–f030 are adjacent views of one
// rust-streaked pole, so per-frame TP counts inflate single-asset detection.
// Grouped scene/asset scoring lives in scripts/bench.ts instead.
// Usage:
//   npx tsx scripts/eval.ts                       # cached re-scoring, zero quota
//   npx tsx scripts/eval.ts --live [--cap=N] [--json=out.json]
//   npx tsx scripts/eval.ts --live --frames=f001,f003 --static-bboxes \
//     --cache-dir=/tmp/run1/cache --out-dir=/tmp/run1 [--json=/tmp/run1.json]
// --frames selects explicit frame IDs (validated, labels.json order; --cap
// alone cannot express the non-contiguous real-v1 set). --cache-dir isolates
// all cache reads/writes (default: the checked-in fixture cache).
// --static-bboxes requests normalized boxes (original-image coordinates) and
// REQUIRES an isolated --cache-dir. --dry-run prints the preflight plan with
// zero provider calls. --out-dir receives run-log.json on live runs only.
// Without --live, every labeled frame must have fixtures/eval/cache/<id>.json
// or the run exits non-zero. --live makes real API calls (bounded: at most
// 4 calls per frame — 1 first pass + verify cap 3).
// Never run in CI or npm test (burns quota).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getSparkClient } from "../src/lib/meta-client";
import { getSparkConfig } from "../src/lib/models";
import { validateDefects } from "../src/lib/report";
import { extractFrame } from "../src/lib/ffmpeg";
import { ensureScratchDirs } from "../src/lib/store";
import { verifyDefects } from "../src/lib/verify";
import type { Defect } from "../src/lib/types";
import {
  EVAL_SYSTEM_PROMPT,
  parseEvalDefects,
  score,
  toDefect,
  type FrameResult,
} from "./eval-lib";
import {
  assertPromptHasNoGroundTruth,
  resolveRunPaths,
  selectStaticInputs,
  STATIC_BBOX_INSTRUCTION,
  STATIC_FRAME_IDS,
  validateStaticBox,
  verifyStaticInputBytes,
  type RunLogEntry,
  type StaticInputRef,
} from "./eval-static-lib";

const LABELS_PATH = "fixtures/eval/labels.json";
const VERIFY_CAP_PER_FRAME = 3; // one frame may hold several findings; audit up to 3
// Bump when the first-pass prompt or output contract changes. Cached responses from
// an older prompt are answers to a different question and must never be reused.
const EVAL_VERSION = 2;

const labelSchema = z.object({
  sourceClip: z.string().min(1),
  frames: z
    .array(
      z.object({
        id: z.string().min(1),
        timestamp: z.number(),
        truth: z.array(z.object({ category: z.string().min(1), defect: z.string() })),
      }),
    )
    .min(1),
});

const cacheSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  // Responses recorded under an older prompt are rejected, forcing a re-run.
  evalVersion: z.number().int(),
  firstPass: z.string(),
  verdictRaw: z.array(z.string()),
  after: z.array(z.unknown()),
  // Present when the frame could not be evaluated (unparseable model output, etc.).
  // The raw response is preserved for audit; such entries never count as complete.
  error: z.string().optional(),
  // Static-image run fields (all optional → old entries still parse). frameId
  // mirrors the entry id; mode records whether this entry came from a live
  // call or a cache resume; claimedBoxes maps defect id → validated box
  // (null = no usable box; never repaired); boxRejected records why.
  frameId: z.string().min(1).optional(),
  mode: z.enum(["live", "cache-hit"]).optional(),
  staticPrompt: z.boolean().optional(),
  claimedBoxes: z.record(z.string(), z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable()).optional(),
  boxRejected: z.record(z.string(), z.string()).optional(),
});

type CacheEntry = z.infer<typeof cacheSchema>;

// Mirror of labelEvidence for the single-frame case: with exactly one cited frame,
// index 0 + an observation is visual, everything else is voice.
function labelSingleFrame(defects: Defect[], frameBase64: string): Defect[] {
  return defects.map((d) =>
    d.evidenceFrameIndex === 0 &&
    typeof d.observation === "string" &&
    d.observation.length > 0
      ? { ...d, evidenceSource: "visual" as const, frameCapture: frameBase64 }
      : { ...d, evidenceSource: "voice" as const },
  );
}

// Eval first pass → Defect[]. Uses the single-frame eval prompt, not the report
// prompt: the report prompt needs a tracked assetId and returns [] without one.
function parseFirstPass(raw: string, frameTimestamp: number, frameId: string): Defect[] {
  return parseEvalDefects(raw).map((d, i) => toDefect(d, frameTimestamp, `${frameId}-${i + 1}`));
}

function cacheIsComplete(entry: CacheEntry): boolean {
  try {
    if (entry.error) return false;
    parseEvalDefects(entry.firstPass);
    validateDefects(entry.after);
    return true;
  } catch {
    return false;
  }
}

function loadLocalEnv(): void {
  if (process.env.MODEL_API_KEY) return;
  for (const f of [".env.local", ".env"]) {
    const p = join(process.cwd(), f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^(MODEL_API_KEY|SPARK_PROVIDER|SPARK_MODEL|BASETEN_BASE_URL|BASETEN_MODEL|BASETEN_API_KEY|MODAL_BASE_URL|MODAL_MODEL|MODAL_API_KEY)=(.+)$/.exec(line.trim());
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}

function parseFlags(argv: string[]): {
  live: boolean;
  cap: number;
  json?: string;
  frames?: string[];
  cacheDir?: string;
  outDir?: string;
  dryRun: boolean;
  staticBboxes: boolean;
  provenanceManifest?: string;
} {
  let live = false;
  let cap = 40;
  let json: string | undefined;
  let frames: string[] | undefined;
  let cacheDir: string | undefined;
  let outDir: string | undefined;
  let dryRun = false;
  let staticBboxes = false;
  let provenanceManifest: string | undefined;
  for (const a of argv) {
    if (a === "--live") live = true;
    else if (a.startsWith("--cap=")) {
      const n = Number(a.slice("--cap=".length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`Bad --cap value: ${a}`);
      cap = n;
    } else if (a.startsWith("--json=")) {
      json = a.slice("--json=".length);
      if (!json) throw new Error("Bad --json value: empty path.");
    } else if (a.startsWith("--frames=")) {
      const list = a.slice("--frames=".length).split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length === 0) throw new Error("Bad --frames value: empty list.");
      frames = list;
    } else if (a.startsWith("--cache-dir=")) {
      cacheDir = a.slice("--cache-dir=".length);
      if (!cacheDir) throw new Error("Bad --cache-dir value: empty path.");
    } else if (a.startsWith("--out-dir=")) {
      outDir = a.slice("--out-dir=".length);
      if (!outDir) throw new Error("Bad --out-dir value: empty path.");
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--static-bboxes") {
      staticBboxes = true;
    } else if (a.startsWith("--provenance-manifest=")) {
      provenanceManifest = a.slice("--provenance-manifest=".length);
      if (!provenanceManifest) throw new Error("Bad --provenance-manifest value: empty path.");
    } else {
      throw new Error(`Unknown flag: ${a} (expected --live, --cap=N, --json=path, --frames=id,... --cache-dir=path, --out-dir=path, --dry-run, --static-bboxes, --provenance-manifest=path).`);
    }
  }
  return { live, cap, json, frames, cacheDir, outDir, dryRun, staticBboxes, provenanceManifest };
}

function cell(s: string, w: number, align: "left" | "right" = "left"): string {
  const v = s.length > w ? s.slice(0, w) : s;
  return `│ ${align === "left" ? v.padEnd(w) : v.padStart(w)} `;
}

function border(left: string, mid: string, right: string, widths: number[]): string {
  return left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
}

// null precision/recall means the ratio was undefined (no predictions / no truth).
// Print an em dash — never 0.00, which would read as a measured failure.
const f2 = (x: number | null): string => (x === null ? "—" : x.toFixed(2));

type Row = {
  precision: number | null;
  recall: number | null;
  falsePositives: number;
  falseNegatives: number;
};

function renderTable(args: {
  n: number;
  clean: number;
  defective: number;
  model: string;
  before: Row;
  after: Row;
}): string {
  const W = [10, 9, 6, 4, 4];
  const lines = [
    `GridSight eval — ${args.n} frames (${args.clean} clean, ${args.defective} defective) — model ${args.model}`,
    border("┌", "┬", "┐", W),
    cell("mode", W[0]) + cell("precision", W[1]) + cell("recall", W[2]) + cell("FP", W[3]) + cell("FN", W[4]) + "│",
    border("├", "┼", "┤", W),
    cell("first pass", W[0]) +
      cell(f2(args.before.precision), W[1], "right") +
      cell(f2(args.before.recall), W[2], "right") +
      cell(String(args.before.falsePositives), W[3], "right") +
      cell(String(args.before.falseNegatives), W[4], "right") +
      "│",
    cell("verified", W[0]) +
      cell(f2(args.after.precision), W[1], "right") +
      cell(f2(args.after.recall), W[2], "right") +
      cell(String(args.after.falsePositives), W[3], "right") +
      cell(String(args.after.falseNegatives), W[4], "right") +
      "│",
    border("└", "┴", "┘", W),
  ];
  const dp =
    args.before.precision === null || args.after.precision === null
      ? null
      : args.after.precision - args.before.precision;
  const removed = args.before.falsePositives - args.after.falsePositives;
  const fpBit =
    removed > 0 ? `-${removed}` : removed < 0 ? `+${-removed}` : "0";
  const dpBit = dp === null ? "n/a" : (dp >= 0 ? "+" : "") + dp.toFixed(2);
  lines.push(`Δ precision ${dpBit} · Δ false positives ${fpBit}`);
  return lines.join("\n");
}

function renderSentence(args: {
  n: number;
  clean: number;
  before: Row;
  after: Row;
}): string {
  const precBit =
    args.before.precision === null || args.after.precision === null
      ? "has no defined precision (no predictions were made)"
      : args.after.precision === args.before.precision
        ? `left precision unchanged at ${f2(args.after.precision)}`
        : `raised precision from ${f2(args.before.precision)} to ${f2(args.after.precision)}`;
  const y = args.before.falsePositives;
  const x = y - args.after.falsePositives;
  const fpBit =
    y > 0 && x > 0
      ? `removed ${x} of ${y} false positives`
      : y > 0 && x === 0
        ? `removed none of ${y} false positives`
        : y > 0
          ? `added ${-x} false positives (from ${y})`
          : args.after.falsePositives === 0
            ? `with no false positives in either pass`
            : `introduced ${args.after.falsePositives} false positives`;
  const recallBit =
    args.before.recall === null || args.after.recall === null
      ? "with no defined recall (no labeled defects in the set)"
      : args.after.recall === args.before.recall
        ? `with recall unchanged at ${f2(args.after.recall)}`
        : `with recall from ${f2(args.before.recall)} to ${f2(args.after.recall)}`;
  return `On ${args.n} labeled frames (${args.clean} clean): verification ${precBit}, ${fpBit}, ${recallBit}.`;
}

async function main(): Promise<void> {
  const { live, cap, json, frames: frameFilter, cacheDir: cacheDirFlag, outDir: outDirFlag, dryRun, staticBboxes, provenanceManifest } = parseFlags(process.argv.slice(2));
  const paths = resolveRunPaths({ cacheDir: cacheDirFlag, outDir: outDirFlag });
  const cacheDir = paths.cacheDir;
  const outDir = paths.outDir;
  // All run paths are absolute from here on (resolveRunPaths normalizes).
  // Never join() them onto cwd again — that would corrupt absolute paths.
  const abs = (q: string): string => (isAbsolute(q) ? q : join(process.cwd(), q));
  // Fail before any inference when static boxes are requested without cache
  // isolation: bbox-augmented outputs must never silently mutate the fixture cache.
  if (staticBboxes && !paths.isolated) {
    throw new Error("refusing --static-bboxes with the checked-in fixture cache (pass an isolated --cache-dir)");
  }
  const systemPrompt = staticBboxes ? `${EVAL_SYSTEM_PROMPT}\n\n${STATIC_BBOX_INSTRUCTION}` : EVAL_SYSTEM_PROMPT;
  if (staticBboxes) assertPromptHasNoGroundTruth(systemPrompt);
  const labelsRaw = JSON.parse(readFileSync(join(process.cwd(), LABELS_PATH), "utf8"));
  const labels = labelSchema.parse(labelsRaw);
  // Explicit frame selection (validated IDs, labels.json order). --cap alone
  // can NOT express the non-contiguous real-v1 set, so it never substitutes.
  let frames = labels.frames.slice(0, cap);
  if (frameFilter !== undefined) {
    const known = new Set(labels.frames.map((f) => f.id));
    const seen = new Set<string>();
    for (const id of frameFilter) {
      if (!known.has(id)) throw new Error(`unknown frame id ${JSON.stringify(id)} (not in ${LABELS_PATH}; refusing to substitute)`);
      if (seen.has(id)) throw new Error(`duplicate frame id ${JSON.stringify(id)} (refusing to count a frame twice)`);
      seen.add(id);
    }
    frames = labels.frames.filter((f) => seen.has(f.id));
  }
  // Load local env files once, up front: both dry-run credential reporting and
  // the live path below read from process.env. Never logs values.
  loadLocalEnv();
  // Quota-free preflight: verifies inputs, checksums, cache policy, config
  // identifiers, and request bounds without touching the network. Never
  // constructs a provider client and never emits model output.
  if (dryRun) {
    const manifestPath = provenanceManifest ?? "fixtures/benchmark/real-v1/provenance.json";
    const manifestRaw = JSON.parse(readFileSync(abs(manifestPath), "utf8")) as {
      datasetVersion?: unknown;
      sources?: Array<{ frames?: Array<{ frameId?: unknown; file?: unknown; sha256?: unknown; timestamp?: unknown; scene?: unknown }> }>;
    };
    const available: StaticInputRef[] = [];
    for (const s of manifestRaw.sources ?? []) {
      for (const f of s.frames ?? []) {
        if (typeof f.frameId !== "string" || typeof f.file !== "string" || typeof f.sha256 !== "string") {
          throw new Error(`provenance manifest ${manifestPath}: frame record missing frameId/file/sha256`);
        }
        available.push({
          frameId: f.frameId,
          file: f.file,
          sha256: f.sha256,
          timestamp: typeof f.timestamp === "number" ? f.timestamp : NaN,
          scene: typeof f.scene === "string" ? f.scene : "",
        });
      }
    }
    const wanted = frameFilter ?? [...STATIC_FRAME_IDS];
    const selected = selectStaticInputs(available, wanted);
    verifyStaticInputBytes(
      selected.map((s) => ({
        frameId: s.frameId,
        sha256: s.sha256,
        bytes: readFileSync(abs(s.file)),
      })),
    );
    let sparkDesc = "unresolved (set SPARK_PROVIDER/BASETEN_*/MODAL_* or accept meta default)";
    try {
      const spark = getSparkConfig();
      sparkDesc = `${spark.provider} / ${spark.model}`;
    } catch (err) {
      sparkDesc = `unresolvable: ${err instanceof Error ? err.message : String(err)}`;
    }
    const keyPresent = typeof process.env.MODEL_API_KEY === "string" && process.env.MODEL_API_KEY.length > 0;
    console.log(
      `DRY RUN — static-image preflight (no provider calls, no cache writes): ${selected.length} input(s) verified against ${manifestPath}`,
    );
    for (const s of selected) {
      const hit = existsSync(join(cacheDir, `${s.frameId}.json`));
      console.log(`- ${s.frameId} ← ${s.file} [${s.sha256.slice(0, 12)}…] cache:${hit ? "HIT (would skip)" : "miss (would infer)"}`);
    }
    console.log(`cache policy: dir=${cacheDir} isolated=${paths.isolated ? "yes (fixtures untouched)" : "NO — fixture cache in scope"}`);
    console.log(`output dir: ${outDir} (run-log.json would be written here on --live)`);
    console.log(`provider/model: ${sparkDesc} · credentials: ${keyPresent ? "present (value undisclosed)" : "ABSENT"}`);
    console.log(
      `request bounds: max ${selected.length * (1 + VERIFY_CAP_PER_FRAME)} provider calls (${selected.length} first-pass + up to ${VERIFY_CAP_PER_FRAME} verify each); expected fewer on clean frames`,
    );
    console.log(`prompt: ${staticBboxes ? "static bbox variant (leakage-checked)" : "standard single-frame prompt"} — ground-truth labels never included`);
    if (staticBboxes) assertPromptHasNoGroundTruth(systemPrompt);
    return;
  }
  const clean = frames.filter((f) => f.truth.length === 0).length;
  const defective = frames.length - clean;
  let modelCalls = 0;

  let model: string;
  const runs: FrameResult[] = [];

  if (!live) {
    // Cached scoring: no client, no key, no network. Incomplete cache → exit 1.
    const missing: string[] = [];
    const cached: { label: (typeof frames)[number]; entry: CacheEntry }[] = [];
    for (const f of frames) {
      const p = join(cacheDir, `${f.id}.json`);
      const raw = existsSync(p) ? readFileSync(p, "utf8") : null;
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      const entry = parsed ? cacheSchema.safeParse(parsed) : null;
      if (!entry?.success || !cacheIsComplete(entry.data)) {
        missing.push(f.id);
        continue;
      }
      cached.push({ label: f, entry: entry.data });
    }
    if (missing.length > 0) {
      console.error(
        `eval cache incomplete — missing: ${missing.join(", ")}. Run with --live to populate fixtures/eval/cache/.`,
      );
      process.exit(1);
    }
    model = cached[0].entry.model;
    for (const { label, entry } of cached) {
      const before = parseFirstPass(entry.firstPass, label.timestamp, label.id);
      const after = validateDefects(entry.after);
      runs.push({ id: label.id, truth: label.truth, reported: after, reportedBeforeVerify: before });
    }
  } else {
    const spark = getSparkConfig();
    model = spark.model;
    const client = getSparkClient();
    const clipPath = join(process.cwd(), labels.sourceClip);
    if (!existsSync(clipPath)) {
      throw new Error(`Source clip missing: ${labels.sourceClip} (see scripts/eval.ts header for how to rebuild it).`);
    }
    ensureScratchDirs();
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const frameErrors: string[] = [];
    // Standalone execution records: one entry per evaluated frame, written
    // incrementally so a partial run still leaves an auditable trail. Written
    // only to isolated output dirs — the default cached path is untouched.
    const runLog: RunLogEntry[] = [];
    const runId = randomUUID();
    // Execution start, recorded once: anchors manifest createdAt to the run
    // itself (not to later artifact-build wall time). New runs only; historical
    // logs without startedAt fall back to earliest frame evidence.
    const runStartedAt = new Date().toISOString();
    const flushRunLog = () => {
      if (!paths.isolated) return;
      writeFileSync(
        join(outDir, "run-log.json"),
        JSON.stringify({ runLogVersion: 1, runId, startedAt: runStartedAt, datasetHint: "real-v1", provider: spark.provider, model: spark.model, frames: runLog }, null, 2),
      );
    };
    for (const f of frames) {
      // Resume: a complete cache entry is reused, never re-burned.
      const cachePath = join(cacheDir, `${f.id}.json`);
      const existingRaw = existsSync(cachePath) ? readFileSync(cachePath, "utf8") : null;
      const existing = existingRaw
        ? cacheSchema.safeParse(JSON.parse(existingRaw) as unknown)
        : null;
      if (existing?.success && cacheIsComplete(existing.data) && existing.data.model === model) {
        console.error(`eval ${f.id}: cached, skipping.`);
        const before = parseFirstPass(existing.data.firstPass, f.timestamp, f.id);
        const after = validateDefects(existing.data.after);
        runLog.push({
          frameId: f.id,
          timestamp: f.timestamp,
          at: new Date().toISOString(),
          mode: "cache-hit",
          provider: spark.provider,
          model: spark.model,
          requests: { firstPass: 0, verify: 0 },
        });
        flushRunLog();
        runs.push({ id: f.id, truth: f.truth, reported: after, reportedBeforeVerify: before });
        continue;
      }
      console.error(`eval ${f.id} @t=${f.timestamp}s…`);
      const writeCache = (entry: Record<string, unknown>) =>
        writeFileSync(
          cachePath,
          JSON.stringify({ id: f.id, model, evalVersion: EVAL_VERSION, ...entry }, null, 2),
        );
      try {
        const tmp = join(tmpdir(), `gridsight-eval-${f.id}.jpg`);
        await extractFrame(clipPath, f.timestamp, tmp);
        modelCalls++;
        const b64 = await readFile(tmp, "base64");
        await unlink(tmp).catch(() => null);
        const res = await client.chat.completions.create({
          model: spark.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Substation inspection frame at t=${f.timestamp.toFixed(2)}s. List every visible defect.`,
                },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
              ],
            },
          ],
        });
        const firstPass = res.choices[0]?.message?.content ?? "";
        const firstPassDigest = createHash("sha256").update(firstPass, "utf8").digest("hex");
        // Cache the raw response BEFORE parsing: a malformed model output must
        // survive for audit even though it fails this frame.
        writeCache({ firstPass, verdictRaw: [], after: [], error: "pending" });
        const before = parseFirstPass(firstPass, f.timestamp, f.id);
        // Static boxes: validated server-side per defect, keyed by defect id.
        // Invalid boxes are rejected with a reason; the finding is preserved
        // WITHOUT localization (never repaired, never clamped, never invented).
        const claimedBoxes: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
        const boxRejected: Record<string, string> = {};
        if (staticBboxes) {
          let rawDefects: ReturnType<typeof parseEvalDefects> = [];
          try {
            rawDefects = parseEvalDefects(firstPass);
          } catch {
            // Unparseable first pass: no boxes to claim; the failure path below records it.
          }
          rawDefects.forEach((raw, i) => {
            const id = `${f.id}-${i + 1}`;
            if (raw.bbox === undefined) {
              claimedBoxes[id] = null;
              return;
            }
            try {
              claimedBoxes[id] = validateStaticBox(raw.bbox);
            } catch (err) {
              claimedBoxes[id] = null;
              boxRejected[id] = err instanceof Error ? err.message : String(err);
            }
          });
        }
        const labeled = labelSingleFrame(before, b64);
        const verdictRaw: string[] = [];
        const after = await verifyDefects(labeled, {
          frames: [{ timestamp: f.timestamp, base64: b64 }],
          videoPath: clipPath,
          sessionId: "eval",
          client,
          model: spark.model,
          cap: VERIFY_CAP_PER_FRAME,
          onVerdict: (_id, v) => {
            verdictRaw.push(JSON.stringify({ verdict: v.verdict, reason: v.reason }));
          },
        });
        modelCalls += verdictRaw.length;
        const slim = after.map((d) => {
          const { frameCapture: _fc, overlayBox: _ob, ...rest } = d;
          void _fc;
          void _ob;
          return rest;
        });
        const verifyDigests = verdictRaw.map((v) => createHash("sha256").update(v, "utf8").digest("hex"));
        const verdicts = after
          .map((d) => d.verification?.verdict)
          .filter((v): v is "keep" | "downgrade" | "drop" | "skipped" => v !== undefined);
        writeCache({
          firstPass,
          verdictRaw,
          after: slim,
          frameId: f.id,
          mode: "live" as const,
          ...(staticBboxes ? { staticPrompt: true, claimedBoxes, boxRejected } : {}),
        });
        runLog.push({
          frameId: f.id,
          timestamp: f.timestamp,
          mode: "live",
          provider: spark.provider,
          model: spark.model,
          requests: { firstPass: 1, verify: verdictRaw.length },
          at: new Date().toISOString(),
          responseDigest: firstPassDigest,
          verifyDigests,
          verdicts,
          ...(Object.keys(boxRejected).length > 0
            ? { boxRejected: Object.entries(boxRejected).map(([id, why]) => `${id}: ${why}`).join("; ").slice(0, 300) }
            : {}),
        });
        flushRunLog();
        runs.push({ id: f.id, truth: f.truth, reported: after, reportedBeforeVerify: before });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`eval ${f.id} FAILED: ${msg}`);
        runLog.push({
          frameId: f.id,
          timestamp: f.timestamp,
          mode: "live",
          provider: spark.provider,
          model: spark.model,
          requests: { firstPass: 0, verify: 0 },
          at: new Date().toISOString(),
          error: msg.slice(0, 300),
        });
        flushRunLog();
        const partial = existsSync(cachePath) ? readFileSync(cachePath, "utf8") : null;
        if (!partial) {
          writeCache({ firstPass: "", verdictRaw: [], after: [], error: msg.slice(0, 300) });
        } else {
          try {
            const entry = JSON.parse(partial) as Record<string, unknown>;
            entry.error = msg.slice(0, 300);
            writeFileSync(
              cachePath,
              JSON.stringify({ id: f.id, model, evalVersion: EVAL_VERSION, ...entry }, null, 2),
            );
          } catch {
            // leave the partial raw as-is; completeness check will reject it
          }
        }
        frameErrors.push(`${f.id}: ${msg.slice(0, 160)}`);
      }
    }
    if (frameErrors.length > 0) {
      console.error(`eval failed on ${frameErrors.length} frame(s):\n- ${frameErrors.join("\n- ")}`);
      process.exit(1);
    }
  }

  const before = score(runs, "before");
  const after = score(runs, "after");
  if (!live) {
    console.log(
      "MODE: cached re-scoring (no inference) — verification measured on RECORDED outputs in fixtures/eval/cache/, NOT live detection accuracy.",
    );
  } else {
    console.log(
      "MODE: live inference (quota-burning) — real Meta calls; failures are recorded as errors, never silently replaced with cached outputs.",
    );
  }
  console.log(
    renderTable({ n: frames.length, clean, defective, model, before, after }),
  );
  console.log(
    renderSentence({ n: frames.length, clean, before, after }),
  );
  console.log(
    "Limitations: per-frame unit inflates single-asset detection (f021-f030 are adjacent views of one pole); category-only matching ignores box/frame/association. See scripts/bench.ts for grouped ground-truth scoring.",
  );
  if (live) console.error(`eval done: ${modelCalls} model calls across ${frames.length} frames.`);
  if (json) {
    writeFileSync(
      isAbsolute(json) ? json : join(process.cwd(), json),
      JSON.stringify({ mode: live ? "live-inference" : "cached-rescoring", realInference: live, datasetVersion: "fixtures/eval/labels.json", evalVersion: EVAL_VERSION, model, frames: runs.length, clean, defective, modelCalls, before, after, limitations: ["Cached re-scoring is not live accuracy.", "Per-frame unit inflates single-asset counts.", "Category-only match; no box/frame/association check."] }, null, 2),
    );
  }
}

main().catch((err) => {
  console.error("eval failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
