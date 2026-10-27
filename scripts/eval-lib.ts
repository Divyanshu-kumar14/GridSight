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
  precision: number;
  recall: number;
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
  // Zeros are valid: return 0, never NaN.
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall };
}
