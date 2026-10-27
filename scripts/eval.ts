// GridSight eval: one defensible number for the verification pass.
// Clip: fixtures/eval/source.mp4, built from three CC-licensed Wikimedia Commons
// photos (Ken Burns zoompan, 10s each, 30s total):
//   insulators.jpg — "Rows of insulators" (geograph 6720396, CC BY-SA 2.0)
//   switchyard.png — "Switchyard of electric substation 750kV" (CC BY-SA 4.0)
//   slunj.jpg      — "Power substation Slunj" (CC BY-SA 4.0)
// Labels (fixtures/eval/labels.json) were set by viewing the extracted frames
// BEFORE any model run and are never tuned to outputs: f001–f020 clean (healthy
// insulators + switchyard), f021–f030 defective (visibly rust-streaked pole).
// Usage:
//   npx tsx scripts/eval.ts                       # cached scoring, zero quota
//   npx tsx scripts/eval.ts --live [--cap=N] [--json=out.json]
// Without --live, every labeled frame must have fixtures/eval/cache/<id>.json
// or the run exits non-zero. --live makes real API calls (bounded: at most
// 2 calls per frame — 1 first-pass + verify cap 1).
// Never run in CI or npm test (burns quota).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { getSparkClient } from "../src/lib/meta-client";
import { getSparkConfig } from "../src/lib/models";
import { REPORT_SYSTEM_PROMPT, validateDefects } from "../src/lib/report";
import { extractFrame } from "../src/lib/ffmpeg";
import { ensureScratchDirs } from "../src/lib/store";
import { verifyDefects } from "../src/lib/verify";
import type { Defect } from "../src/lib/types";
import { score, type FrameResult } from "./eval-lib";

const LABELS_PATH = "fixtures/eval/labels.json";
const CACHE_DIR = "fixtures/eval/cache";
const VERIFY_CAP_PER_FRAME = 1; // keeps --live total at most 2 calls per frame

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
  firstPass: z.string(),
  verdictRaw: z.array(z.string()),
  after: z.array(z.unknown()),
  // Present when the frame could not be evaluated (unparseable model output, etc.).
  // The raw response is preserved for audit; such entries never count as complete.
  error: z.string().optional(),
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

// Same envelope tolerance as the report route: bare array or {defects}.
function parseDefects(raw: string): Defect[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const parsed = JSON.parse((fenced ? fenced[1] : raw).trim()) as unknown;
  return validateDefects(
    parsed && typeof parsed === "object" && "defects" in (parsed as object)
      ? parsed
      : parsed,
  );
}

function cacheIsComplete(entry: CacheEntry): boolean {
  try {
    if (entry.error) return false;
    parseDefects(entry.firstPass);
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

function parseFlags(argv: string[]): { live: boolean; cap: number; json?: string } {
  let live = false;
  let cap = 40;
  let json: string | undefined;
  for (const a of argv) {
    if (a === "--live") live = true;
    else if (a.startsWith("--cap=")) {
      const n = Number(a.slice("--cap=".length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`Bad --cap value: ${a}`);
      cap = n;
    } else if (a.startsWith("--json=")) {
      json = a.slice("--json=".length);
      if (!json) throw new Error("Bad --json value: empty path.");
    } else {
      throw new Error(`Unknown flag: ${a} (expected --live, --cap=N, --json=path).`);
    }
  }
  return { live, cap, json };
}

function cell(s: string, w: number, align: "left" | "right" = "left"): string {
  const v = s.length > w ? s.slice(0, w) : s;
  return `│ ${align === "left" ? v.padEnd(w) : v.padStart(w)} `;
}

function border(left: string, mid: string, right: string, widths: number[]): string {
  return left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
}

function renderTable(args: {
  n: number;
  clean: number;
  defective: number;
  model: string;
  before: { precision: number; recall: number; falsePositives: number; falseNegatives: number };
  after: { precision: number; recall: number; falsePositives: number; falseNegatives: number };
}): string {
  const W = [10, 9, 6, 4, 4];
  const f2 = (x: number) => x.toFixed(2);
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
  const dp = args.after.precision - args.before.precision;
  const removed = args.before.falsePositives - args.after.falsePositives;
  const fpBit =
    removed > 0 ? `-${removed}` : removed < 0 ? `+${-removed}` : "0";
  lines.push(`Δ precision ${(dp >= 0 ? "+" : "") + dp.toFixed(2)} · Δ false positives ${fpBit}`);
  return lines.join("\n");
}

function renderSentence(args: {
  n: number;
  clean: number;
  before: { precision: number; recall: number; falsePositives: number };
  after: { precision: number; recall: number; falsePositives: number };
}): string {
  const f2 = (x: number) => x.toFixed(2);
  const precBit =
    args.after.precision === args.before.precision
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
    args.after.recall === args.before.recall
      ? `with recall unchanged at ${f2(args.after.recall)}`
      : `with recall from ${f2(args.before.recall)} to ${f2(args.after.recall)}`;
  return `On ${args.n} labeled frames (${args.clean} clean): verification ${precBit}, ${fpBit}, ${recallBit}.`;
}

async function main(): Promise<void> {
  const { live, cap, json } = parseFlags(process.argv.slice(2));
  const labelsRaw = JSON.parse(readFileSync(join(process.cwd(), LABELS_PATH), "utf8"));
  const labels = labelSchema.parse(labelsRaw);
  const frames = labels.frames.slice(0, cap);
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
      const p = join(process.cwd(), CACHE_DIR, `${f.id}.json`);
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
      const before = parseDefects(entry.firstPass);
      const after = validateDefects(entry.after);
      runs.push({ id: label.id, truth: label.truth, reported: after, reportedBeforeVerify: before });
    }
  } else {
    loadLocalEnv();
    const spark = getSparkConfig();
    model = spark.model;
    const client = getSparkClient();
    const clipPath = join(process.cwd(), labels.sourceClip);
    if (!existsSync(clipPath)) {
      throw new Error(`Source clip missing: ${labels.sourceClip} (see scripts/eval.ts header for how to rebuild it).`);
    }
    ensureScratchDirs();
    mkdirSync(join(process.cwd(), CACHE_DIR), { recursive: true });
    const frameErrors: string[] = [];
    for (const f of frames) {
      // Resume: a complete cache entry is reused, never re-burned.
      const cachePath = join(process.cwd(), CACHE_DIR, `${f.id}.json`);
      const existingRaw = existsSync(cachePath) ? readFileSync(cachePath, "utf8") : null;
      const existing = existingRaw
        ? cacheSchema.safeParse(JSON.parse(existingRaw) as unknown)
        : null;
      if (existing?.success && cacheIsComplete(existing.data) && existing.data.model === model) {
        console.error(`eval ${f.id}: cached, skipping.`);
        const before = parseDefects(existing.data.firstPass);
        const after = validateDefects(existing.data.after);
        runs.push({ id: f.id, truth: f.truth, reported: after, reportedBeforeVerify: before });
        continue;
      }
      console.error(`eval ${f.id} @t=${f.timestamp}s…`);
      const writeCache = (entry: Record<string, unknown>) =>
        writeFileSync(cachePath, JSON.stringify({ id: f.id, model, ...entry }, null, 2));
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
            { role: "system", content: REPORT_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    frames_attached: 1,
                    frame_note:
                      "The attached key frame FRAME 0 is the visual ground truth. Cite visual claims with evidenceFrameIndex.",
                    tracked_assets: [],
                    tagged_notes: [],
                    voice_transcript: [],
                    key_frame_timestamps: [f.timestamp],
                    inspection_metadata: { substation: "eval", date: new Date().toISOString(), inspector: "eval" },
                  }),
                },
                { type: "text", text: `FRAME 0 @ t=${f.timestamp.toFixed(2)}s` },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
              ],
            },
          ],
        });
        const firstPass = res.choices[0]?.message?.content ?? "";
        // Cache the raw response BEFORE parsing: a malformed model output must
        // survive for audit even though it fails this frame.
        writeCache({ firstPass, verdictRaw: [], after: [], error: "pending" });
        const before = parseDefects(firstPass);
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
          const { frameCapture: _fc, annotatedImage: _ai, overlayBox: _ob, ...rest } = d;
          void _fc;
          void _ai;
          void _ob;
          return rest;
        });
        writeCache({ firstPass, verdictRaw, after: slim });
        runs.push({ id: f.id, truth: f.truth, reported: after, reportedBeforeVerify: before });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`eval ${f.id} FAILED: ${msg}`);
        const partial = existsSync(cachePath) ? readFileSync(cachePath, "utf8") : null;
        if (!partial) {
          writeCache({ firstPass: "", verdictRaw: [], after: [], error: msg.slice(0, 300) });
        } else {
          try {
            const entry = JSON.parse(partial) as Record<string, unknown>;
            entry.error = msg.slice(0, 300);
            writeFileSync(cachePath, JSON.stringify({ id: f.id, model, ...entry }, null, 2));
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
  console.log(
    renderTable({ n: frames.length, clean, defective, model, before, after }),
  );
  console.log(
    renderSentence({ n: frames.length, clean, before, after }),
  );
  if (live) console.error(`eval done: ${modelCalls} model calls across ${frames.length} frames.`);
  if (json) {
    writeFileSync(
      join(process.cwd(), json),
      JSON.stringify({ model, frames: runs.length, clean, defective, modelCalls, before, after }, null, 2),
    );
  }
}

main().catch((err) => {
  console.error("eval failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
