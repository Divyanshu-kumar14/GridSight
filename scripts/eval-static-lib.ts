// Static-image evaluation support for the real-v1 benchmark (quota-free helpers).
// Pure functions only: no network, no filesystem, no secrets. All filesystem
// access stays in the calling scripts so these units are trivially testable.
//
// The static path evaluates single images (not video, not tracking): each
// prediction is linked to its input frame by stable frameId, localized with an
// optional model-reported box in ORIGINAL submitted-image coordinates, and
// scored per defect episode. Ground-truth labels are NEVER part of prompts.

import { createHash } from "node:crypto";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { canonicalJson, assertNoSecrets } from "../src/lib/bench-metrics";
import type { RunManifest, RunStage, StaticPrediction } from "../src/lib/bench-metrics";

// The approved real-v1 input set, in stable evaluation order. Frame IDs map
// 1:1 to ground-truth cases. Never derive this list from model outputs.
export const STATIC_FRAME_IDS = [
  "f001",
  "f003",
  "f006",
  "f009",
  "f011",
  "f014",
  "f018",
  "f021",
  "f023",
  "f025",
  "f028",
  "f030",
] as const;

// Checked-in fixture cache. Isolated runs must point elsewhere.
export const FIXTURE_CACHE_DIR = "fixtures/eval/cache";

// Terms that must never appear in a model prompt: stable IDs that would leak
// the expected answers (generic defect vocabulary like "rust" is fine and
// required for detection).
const PROMPT_FORBIDDEN_TERMS = [
  "EP-RUST",
  "rust-pole",
  "insulator-stack",
  "tower-left",
  "tower-right",
  "fence-post",
  "R-08",
  "R-09",
  "R-10",
  "R-11",
  "R-12",
  "slunj-yard",
  "insulators-closeup",
  "switchyard-towers",
];

export function assertPromptHasNoGroundTruth(prompt: string): void {
  for (const term of PROMPT_FORBIDDEN_TERMS) {
    if (prompt.toLowerCase().includes(term.toLowerCase())) {
      throw new Error(`model prompt leaks ground-truth identity: contains ${JSON.stringify(term)}`);
    }
  }
}

// Bbox instruction appended ONLY in static mode. Coordinates refer to the
// original submitted image (not any verification crop).
export const STATIC_BBOX_INSTRUCTION = [
  "For each defect, also report where it is: a normalized bounding box for the",
  "visibly damaged region as {\"x\": <left 0-1>, \"y\": <top 0-1>,",
  "\"width\": <positive width>, \"height\": <positive height>}. All four numbers",
  "must be finite; x and y inside [0,1]; width and height positive; the box must",
  "stay inside the image. Coordinates refer to the attached image as submitted.",
  "If the location is unclear, omit \"bbox\" for that defect rather than guessing.",
].join(" ");

export interface StaticBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EPS = 1e-6;

// Server-side box validation. Returns a normalized {x,y,w,h} box or throws.
// Never repairs, clamps, or invents coordinates: invalid boxes are rejected and
// the finding is preserved WITHOUT localization.
export function validateStaticBox(raw: unknown): { x: number; y: number; w: number; h: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("bbox must be an object with x, y, width, height");
  }
  const { x, y, width, height } = raw as Record<string, unknown>;
  for (const [k, v] of [["x", x], ["y", y], ["width", width], ["height", height]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`bbox.${k} must be a finite number`);
  }
  const w = width as number;
  const h = height as number;
  const bx = x as number;
  const by = y as number;
  if (bx < 0 || bx > 1 || by < 0 || by > 1) throw new Error("bbox x/y must lie inside [0,1]");
  if (w <= 0 || h <= 0) throw new Error("bbox width/height must be positive");
  if (bx + w > 1 + EPS || by + h > 1 + EPS) throw new Error("bbox must stay inside the image bounds");
  return { x: bx, y: by, w, h };
}

export interface StaticInputRef {
  frameId: string;
  file: string;
  sha256: string;
  timestamp: number;
  scene: string;
}

// Resolve the requested evaluation inputs against the manifest frame list.
// Default: exactly the 12 approved real-v1 frames, in manifest order.
// Rejects unknown IDs, duplicates, and anything outside the requested set —
// before any inference runs.
export function selectStaticInputs(
  available: StaticInputRef[],
  requested?: string[] | undefined,
): StaticInputRef[] {
  const want = requested ?? [...STATIC_FRAME_IDS];
  if (want.length === 0) throw new Error("static input selection is empty (refusing to evaluate nothing)");
  const seen = new Set<string>();
  for (const id of want) {
    if (seen.has(id)) throw new Error(`duplicate input frameId ${JSON.stringify(id)} (refusing to count a frame twice)`);
    seen.add(id);
  }
  const byId = new Map(available.map((a) => [a.frameId, a]));
  const missing = want.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`unknown input frame(s): ${missing.join(", ")} (not in the approved manifest; refusing to substitute)`);
  // Requested order is the evaluation order: deterministic and explicit. The
  // default request is the approved dataset order.
  return want.map((id) => byId.get(id) as StaticInputRef);
}

// Verify input bytes against manifest checksums. Pure: caller supplies bytes.
export function verifyStaticInputBytes(entries: Array<{ frameId: string; sha256: string; bytes: Uint8Array | string }>): void {
  for (const e of entries) {
    if (typeof e.sha256 !== "string" || e.sha256.length === 0) {
      throw new Error(`input ${e.frameId}: manifest is missing its checksum`);
    }
    const actual = createHash("sha256").update(e.bytes).digest("hex");
    if (actual !== e.sha256.toLowerCase()) {
      throw new Error(`input ${e.frameId}: checksum mismatch (media changed or wrong file; refusing to score)`);
    }
  }
}

export interface RunPathConfig {
  cacheDir: string;
  outDir: string;
  isolated: boolean;
}

// Resolve cache/output locations to absolute paths. isolated is true unless the
// cache dir IS the checked-in fixture cache (compared by absolute path, so an
// explicit absolute path to the fixtures is still caught, not just the
// historical relative string). Defaults preserve historical behavior.
export function resolveRunPaths(opts: { cacheDir?: string; outDir?: string; baseDir?: string } = {}): RunPathConfig {
  const base = opts.baseDir ?? process.cwd();
  const fixtureAbs = resolvePath(base, FIXTURE_CACHE_DIR);
  const toAbs = (p: string): string => (isAbsolute(p) ? p : join(base, p));
  const cacheDir = opts.cacheDir !== undefined ? toAbs(opts.cacheDir) : fixtureAbs;
  const outDir = opts.outDir !== undefined ? toAbs(opts.outDir) : cacheDir;
  return {
    cacheDir,
    outDir,
    isolated: cacheDir !== fixtureAbs,
  };
}

// ---- Standalone execution records (run-log) ----

export interface RunLogEntry {
  frameId: string;
  timestamp: number;
  /** How this frame was actually executed. Never silently upgraded. */
  mode: "live" | "cache-hit" | "skipped";
  provider: string;
  model: string;
  requests: { firstPass: 0 | 1; verify: number };
  /** sha256 of the raw first-pass response text (live only). */
  responseDigest?: string;
  /** sha256 digests of raw verification response texts (live only). */
  verifyDigests?: string[];
  verdicts?: Array<"keep" | "downgrade" | "drop" | "skipped">;
  /** Box rejected by server-side validation (finding preserved without localization). */
  boxRejected?: string;
  /** ISO timestamp when this frame finished (UTC). Used for manifest bounds. */
  at?: string;
  /** Execution error for this frame (status failed; never scored as completed). */
  error?: string;
}

// Build a run-manifest-v1 from standalone eval execution records plus the
// final prediction array. No SQLite, no fabricated job rows: each live frame
// becomes a `frame:<id>` inference stage carrying its response digest; any
// frame without live evidence cannot be claimed as inference.
export function buildStandaloneManifest(args: {
  runLog: RunLogEntry[];
  predictions: unknown[];
  datasetId: string;
  datasetVersion: string;
  inputs: Record<string, string>;
  provider: string;
  model: string;
  runId: string;
  recordedAt?: string;
  /** Execution start from the run log (new runs). Never artifact-build time. */
  runStartedAt?: string;
}): RunManifest {
  const { runLog, predictions, datasetId, datasetVersion, inputs, provider, model, runId, recordedAt, runStartedAt } = args;
  if (runLog.length === 0) throw new Error("run log is empty (nothing executed; refusing to manifest)");
  const atTimes = runLog.map((e) => e.at).filter((t): t is string => typeof t === "string" && t.length > 0).sort();
  const stages: RunStage[] = runLog.map((e) => {
    if (!e.frameId || typeof e.frameId !== "string") throw new Error("run log entry missing frameId");
    if (e.mode === "live") {
      if (!e.error && !e.responseDigest) {
        throw new Error(`frame ${e.frameId}: completed live inference without responseDigest (refusing silent upgrade)`);
      }
      const stage: RunStage = {
        key: `frame:${e.frameId}`,
        mode: "inference",
        status: e.error ? "failed" : "completed",
        providerRequestMade: true,
        note: `standalone live inference: ${e.requests.firstPass} first-pass + ${e.requests.verify} verify call(s)`,
      };
      if (e.responseDigest) stage.responseDigest = e.responseDigest;
      if (e.error) stage.error = e.error.slice(0, 300);
      return stage;
    }
    if (e.mode !== "cache-hit" && e.mode !== "skipped") {
      throw new Error(`frame ${e.frameId}: bad mode ${JSON.stringify((e as { mode?: unknown }).mode)}`);
    }
    const failed = typeof e.error === "string" && e.error.length > 0;
    const nonLive: RunStage = {
      key: `frame:${e.frameId}`,
      mode: e.mode === "cache-hit" ? "cache" : "skipped",
      status: failed ? "failed" : e.mode === "skipped" ? "skipped" : "completed",
      providerRequestMade: false,
      note: `standalone frame ${e.frameId}: ${e.mode} (no provider request)`,
    };
    if (failed) nonLive.error = (e.error as string).slice(0, 300);
    return nonLive;
  });
  const failed = stages.some((s) => s.status === "failed");
  // Manifest bounds anchor to EXECUTION evidence, never to artifact-build wall
  // time. createdAt = run start when recorded (new runs), else the earliest
  // frame finish; completedAt = the latest frame finish. recordedAt is only a
  // last-resort fallback when no frame carries timing (all-skipped runs).
  // Skew (start postdating completion) throws rather than silently reordering.
  const sortedAt = [...atTimes].sort();
  const earliestAt = sortedAt.length > 0 ? sortedAt[0] : undefined;
  const latestAt = sortedAt.length > 0 ? sortedAt[sortedAt.length - 1] : undefined;
  let createdAt: string;
  if (runStartedAt !== undefined) {
    if (Number.isNaN(Date.parse(runStartedAt))) throw new Error("run manifest: bad runStartedAt");
    if (latestAt !== undefined && Date.parse(runStartedAt) > Date.parse(latestAt))
      throw new Error("run manifest: runStartedAt postdates frame completion (clock skew; refusing to reorder)");
    createdAt = runStartedAt;
  } else if (earliestAt !== undefined) {
    createdAt = earliestAt;
  } else {
    createdAt = recordedAt ?? new Date().toISOString();
  }
  const completedAt = failed ? null : (latestAt ?? createdAt);
  const manifest: RunManifest = {
    manifestVersion: "run-manifest-v1",
    runId,
    createdAt,
    completedAt,
    status: failed ? "failed" : "completed",
    dataset: { id: datasetId, version: datasetVersion, inputs },
    pipeline: { provider, model },
    stages,
    predictionsDigest: createHash("sha256").update(canonicalJson(predictions), "utf8").digest("hex"),
    notes: [
      "Standalone single-image evaluation: stages are per-frame execution records emitted by the eval run itself (no SQLite job rows exist on this path).",
      "Cache-hit frames are recorded as cache mode and can never satisfy actual-inference evidence for their frame.",
    ],
  };
  assertNoSecrets(manifest);
  return manifest;
}

// ============ Static artifact adapter (pure) ============

export interface StaticCacheDefect {
  assetCategory?: unknown;
  defect?: unknown;
  title?: unknown;
  evidenceSource?: unknown;
  verification?: { verdict?: unknown } | null;
}

export interface StaticCacheEntry {
  id?: unknown;
  model?: unknown;
  after?: unknown;
  error?: unknown;
  claimedBoxes?: unknown;
  mode?: unknown;
}

/**
 * Map recorded single-frame eval outputs to frame-linked static predictions.
 * Box source: the entry's claimedBoxes map (keyed by defect id `${frameId}-${i+1}`),
 * written by --static-bboxes runs and validated again here — invalid boxes
 * become null (localization unavailable), never repaired, never invented.
 * Entries with run errors, or frames with zero reported defects, contribute no
 * predictions (a fully empty result is a completed zero-detection run only
 * when the envelope says the run completed).
 */
export function adaptStaticCacheToArtifact(
  entries: StaticCacheEntry[],
  opts: { provenanceDefault: "actual" | "cached" },
): { predictions: StaticPrediction[]; notes: string[]; skipped: number } {
  const predictions: StaticPrediction[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (const e of entries) {
    if (!e || typeof e.id !== "string" || e.id.length === 0) {
      skipped++;
      continue;
    }
    if (typeof e.error === "string" && e.error.length > 0) {
      skipped++;
      notes.push(`frame ${e.id}: run error recorded, no prediction emitted (never treated as zero)`);
      continue;
    }
    if (!Array.isArray(e.after)) {
      skipped++;
      continue;
    }
    const claimed = isRecordLike(e.claimedBoxes) ? (e.claimedBoxes as Record<string, unknown>) : {};
    e.after.forEach((d, i) => {
      if (!isRecordLike(d)) return;
      const rec = d as Record<string, unknown>;
      const id = `${e.id as string}-${i + 1}`;
      let bbox: StaticPrediction["bbox"] = null;
      const rawBox = claimed[id];
      if (rawBox !== undefined && rawBox !== null) {
        // Cache entries store normalized {x,y,w,h}; the validator takes the
        // {x,y,width,height} input form. Accept both; never repair values.
        const normalized = isRecordLike(rawBox) && typeof (rawBox as Record<string, unknown>).width === "number"
          ? rawBox
          : isRecordLike(rawBox)
            ? {
                x: (rawBox as Record<string, unknown>).x,
                y: (rawBox as Record<string, unknown>).y,
                width: (rawBox as Record<string, unknown>).w,
                height: (rawBox as Record<string, unknown>).h,
              }
            : rawBox;
        try {
          const v = validateStaticBox(normalized);
          bbox = { x: v.x, y: v.y, w: v.w, h: v.h };
        } catch (err) {
          notes.push(`frame ${e.id as string}: invalid claimed box for ${id} rejected (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      const category = typeof rec.assetCategory === "string" ? rec.assetCategory : "";
      const defectClass =
        typeof rec.defect === "string" && rec.defect.length > 0
          ? rec.defect
          : typeof rec.title === "string"
            ? rec.title
            : "";
      const evidenceSource = rec.evidenceSource === "voice" ? "voice" : "visual";
      const v = isRecordLike(rec.verification) ? (rec.verification as { verdict?: unknown }).verdict : null;
      const verification =
        v === "keep" || v === "downgrade" || v === "drop" || v === "skipped" ? v : null;
      predictions.push({
        frameId: e.id as string,
        category,
        defectClass,
        bbox,
        evidenceSource,
        verification,
        provenance: opts.provenanceDefault,
      });
    });
  }
  return { predictions, notes, skipped };
}

function isRecordLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse + minimally validate a run-log.json document produced by an isolated
 * eval --live run. Returns the run identity, pipeline ids, and entries.
 * Uniformity of provider/model across entries is enforced by the caller.
 */
export function parseStandaloneRunLog(raw: unknown): {
  runId: string | null;
  provider: string | null;
  model: string | null;
  startedAt: string | null;
  frames: RunLogEntry[];
} {
  if (!isRecordLike(raw)) throw new Error("run log is not an object");
  const rec = raw as Record<string, unknown>;
  const frames = rec.frames;
  if (!Array.isArray(frames) || frames.length === 0) throw new Error("run log has no frame entries (nothing executed)");
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!isRecordLike(f) || typeof (f as Record<string, unknown>).frameId !== "string" || ((f as Record<string, unknown>).frameId as string).length === 0)
      throw new Error(`run log entry ${i} missing frameId`);
    const mode = (f as Record<string, unknown>).mode;
    if (mode !== "live" && mode !== "cache-hit" && mode !== "skipped")
      throw new Error(`run log entry ${(f as Record<string, unknown>).frameId} has bad mode ${JSON.stringify(mode)}`);
  }
  const runId = typeof rec.runId === "string" && rec.runId.length > 0 ? rec.runId : null;
  const provider = typeof rec.provider === "string" && rec.provider.length > 0 ? rec.provider : null;
  const model = typeof rec.model === "string" && rec.model.length > 0 ? rec.model : null;
  // Execution start when the eval run recorded one (new runs). Historical logs
  // predate this field: null means "anchor to earliest frame evidence instead".
  // A present-but-malformed value is rejected, never silently accepted.
  let startedAt: string | null = null;
  if ((rec as Record<string, unknown>).startedAt !== undefined) {
    const s = (rec as Record<string, unknown>).startedAt;
    if (typeof s !== "string" || Number.isNaN(Date.parse(s))) throw new Error("run log has bad startedAt");
    startedAt = s;
  }
  return { runId, provider, model, startedAt, frames: frames as RunLogEntry[] };
}

// Fail clearly on unexpected frames: a static prediction must name a benchmark
// input frame. Anything else is a wiring bug, never a scored outcome (the
// scorer additionally buckets unknown frames defensively).
export function assertKnownFrames(
  frameIds: string[],
  knownFrameIds: ReadonlySet<string> | readonly string[],
  context?: string,
): void {
  const known = knownFrameIds instanceof Set ? knownFrameIds : new Set(knownFrameIds);
  const unknown = Array.from(new Set(frameIds)).filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `static predictions reference unknown frames: ${unknown.join(", ")}${context ? ` (${context})` : " (expected only benchmark input frameIds)"}`,
    );
  }
}
