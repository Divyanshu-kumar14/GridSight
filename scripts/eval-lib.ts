import { z } from "zod";
import type { Defect } from "../src/lib/types";

// Pure scoring for the verification-pass eval (no I/O, no network, no ffmpeg).
// A reported defect matches a truth entry when the category strings match
// case-insensitively OR one contains the other. Each truth entry is consumed at
// most once per frame; matching is greedy in reported order.

export interface Truth {
  category: string;
  defect: string;
}

export interface FrameResult {
  id: string;
  truth: Truth[];
  reported: Defect[]; // after verify
  reportedBeforeVerify: Defect[];
}

export interface Metrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  // null = undefined, not zero. Precision with zero predictions is 0/0 and recall
  // with zero truth entries is 0/0; printing "0.00" for either claims a measurement
  // that was never made.
  precision: number | null;
  recall: number | null;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

// Pairwise category match. Empty strings never match (avoids ""-in-anything).
function categoriesMatch(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// First index in truth matching reported (skipping used), or -1.
function matchIndex(reported: Defect, truth: Truth[], used: Set<number>): number {
  for (let i = 0; i < truth.length; i++) {
    if (used.has(i)) continue;
    if (categoriesMatch(reported.assetCategory, truth[i].category)) {
      return i;
    }
  }
  return -1;
}

// Does ANY truth entry match (ignores consumption — frame-level dedupe lives in score).
export function matchDefect(reported: Defect, truth: Truth[]): boolean {
  return matchIndex(reported, truth, new Set()) >= 0;
}

export function score(runs: FrameResult[], mode: "before" | "after"): Metrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const run of runs) {
    const reported = mode === "before" ? run.reportedBeforeVerify : run.reported;
    const used = new Set<number>();
    for (const d of reported) {
      const i = matchIndex(d, run.truth, used);
      if (i >= 0) {
        used.add(i);
        tp++;
      } else {
        fp++;
      }
    }
    fn += run.truth.length - used.size;
  }
  // Undefined ratios are null (see Metrics) — never NaN, never a fake 0.00.
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall };
}

// ============ Eval first pass (single frame, no tracking context) ============

// The report prompt cannot be reused here: it requires an assetId from SAM tracking
// and tells the model to return zero defects when nothing supports a claim. Fed an
// empty tracked_assets list, it correctly returns [] on every frame — which measured
// the harness, not the product. This prompt asks the only question the labeled set
// can answer: what is visibly wrong in this frame?
export const EVAL_SYSTEM_PROMPT = `You are reviewing ONE frame from a power substation inspection.

List every visible defect on any asset in this frame.

Rules (no exceptions):
- Report only damage you can concretely see in the attached frame: rust, corrosion, cracking, deformation, leakage, staining, or a missing/broken part.
- A blur, shadow, reflection, distant structure, or ordinary surface weathering is NOT a defect.
- Do not infer a defect from the setting. If the frame shows no damage, return an empty array.
- category: use pole, insulator, transformer, connector, tower, building, fence, or vegetation when one fits. Otherwise a short lowercase noun.
- severity: CRITICAL (immediate failure risk), HIGH (repair before the next cycle), MEDIUM (schedule repair), LOW (monitor).
- observation: one sentence stating exactly what is visible and where in the frame.

Output JSON only:
{"defects":[{"category":"...","defect":"...","severity":"HIGH","observation":"..."}]}`;

export interface EvalDefect {
  category: string;
  defect: string;
  severity: Defect["severity"];
  observation: string;
  /** Optional model-reported box in ORIGINAL submitted-image coordinates.
   * Shape-checked only here; strict range validation happens server-side in
   * eval-static-lib (invalid boxes are rejected, never repaired). */
  bbox?: { x: number; y: number; width: number; height: number };
}

const evalBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const evalDefectSchema = z.object({
  category: z.string().min(1),
  defect: z.string().min(1),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  observation: z.string().min(1),
  bbox: evalBoxSchema.optional(),
});

const evalEnvelopeSchema = z.object({ defects: z.array(evalDefectSchema) });

// Tolerant reader: bare {"defects":[...]}, a bare array, ```json fences, or prose.
// Throws when nothing valid is found so the caller records a failed frame.
export function parseEvalDefects(raw: string): EvalDefect[] {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed) candidates.push(trimmed);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced?.[1]?.trim()) candidates.push(fenced[1].trim());
  const greedy = /\{[\s\S]*\}/.exec(raw);
  if (greedy?.[0]) candidates.push(greedy[0]);

  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    const envelope = evalEnvelopeSchema.safeParse(parsed);
    if (envelope.success) return envelope.data.defects;
    const bare = z.array(evalDefectSchema).safeParse(parsed);
    if (bare.success) return bare.data;
  }
  throw new Error('Unparseable eval response: no valid {"defects":[...]} JSON found.');
}

const URGENCY: Record<Defect["severity"], Defect["estimatedUrgency"]> = {
  CRITICAL: "Immediate",
  HIGH: "Immediate",
  MEDIUM: "Next scheduled",
  LOW: "Monitor",
};

// EvalDefect → Defect so the same scorer works for both paths.
// evidenceFrameIndex is 0 by construction: exactly one frame is attached to the call,
// so any visual claim necessarily cites frame 0. That is what lets verifyDefects
// audit these findings (labelEvidence requires a cited index + an observation).
export function toDefect(raw: EvalDefect, frameTimestamp: number, id: string): Defect {
  const slug =
    raw.category
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "asset";
  return {
    id,
    assetId: `${slug}-001`,
    assetCategory: raw.category,
    severity: raw.severity,
    title: raw.defect,
    description: raw.observation,
    frameTimestamp,
    recommendedAction: "Inspect and schedule repair",
    estimatedUrgency: URGENCY[raw.severity],
    observation: raw.observation,
    evidenceFrameIndex: 0,
  };
}
