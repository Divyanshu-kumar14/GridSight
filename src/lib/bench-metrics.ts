// GridSight benchmark metrics — pure, deterministic, quota-free.
// Measures what the evidence pipeline actually produces (defects, boxes,
// frames, associations, verification, coverage). No I/O, no network, no secrets.
//
// Unit of evaluation: ONE CASE (not one frame). Each case carries at most one
// ground-truth defect. Duplicate predictions for the same case do not create
// extra true positives: the first matching prediction consumes the GT entry,
// every additional prediction for that case is a false positive. Results are
// additionally grouped by scene so ten adjacent frames of one pole cannot read
// as ten independent asset detections.
//
// Unavailable metrics are explicit null + reason — never silent zero, never a
// fake 0.00, never counted as success.

import { createHash } from "node:crypto";

import type { BoundingBox } from "./types";

// Dataset + threshold identifiers recorded in every report for reproducibility.
export const BENCH_DATASET_VERSION = "v1";
export const BENCH_IOU_THRESHOLD = 0.5;

export interface BenchGroundTruth {
  caseId: string;
  scene: string;
  /** Human-readable note for judges/auditors. */
  description: string;
  /** True when the scene should produce NO defect. */
  clean: boolean;
  category: string;
  /** Defect label (e.g. "rust"). Empty when clean. */
  defect: string;
  /** Canonical asset the defect belongs to. Null when no reliable association exists. */
  assetId: string | null;
  /** Expected evidence frame index within the case's frame list. Null for voice-only/clean. */
  evidenceFrame: number | null;
  /** Reliable GT box where one can be defined, else null. */
  bbox: BoundingBox | null;
  /** Expected voice-note asset link. Null when the note has no reliable match. */
  voiceAssetId?: string | null;
}

export interface BenchPrediction {
  caseId: string;
  category: string;
  defect: string;
  assetId: string | null;
  /** Cited evidence frame index, or null/undefined for voice-only. */
  evidenceFrame: number | null;
  bbox: BoundingBox | null;
  evidenceSource: "visual" | "voice";
  assetAssociation: "confirmed" | "unresolved" | null;
  verification: "keep" | "downgrade" | "drop" | "skipped" | null;
  /** True when the runner could not produce a prediction (error path). */
  error?: boolean;
  /** True when the case was intentionally not evaluated. */
  skipped?: boolean;
}

export interface BenchCaseInput {
  groundTruth: BenchGroundTruth;
  predictions: BenchPrediction[];
}

export interface PRF {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface Availability<T> {
  value: T | null;
  reason?: string;
}

export interface BenchReport {
  mode: "ground-truth-benchmark";
  realInference: false;
  datasetVersion: string;
  iouThreshold: number;
  counts: {
    cases: number;
    defectiveCases: number;
    cleanCases: number;
    groundTruthDefects: number;
    predictions: number;
    skipped: number;
    errored: number;
  };
  detection: PRF & { falsePositivesOnClean: number };
  perClass: Record<string, PRF>;
  perScene: Record<string, PRF & { cases: number }>;
  association: {
    evaluated: number;
    correct: number;
    accuracy: number | null;
    unresolved: number;
    unresolvedRate: number | null;
    reason?: string;
  };
  evidenceFrame: {
    evaluated: number;
    correct: number;
    accuracy: number | null;
    reason?: string;
  };
  voiceMatching: {
    evaluated: number;
    correct: number;
    accuracy: number | null;
    reason?: string;
  };
  verification: {
    kept: number;
    downgraded: number;
    dropped: number;
    skipped: number;
    errors: number;
  };
  coverage: {
    assetsTracked: number;
    assetsRepresented: number;
    note: string;
  };
  cases: Array<{
    caseId: string;
    scene: string;
    passed: boolean;
    skipped: boolean;
    errored: boolean;
    expected: string;
    predicted: string;
    mismatches: string[];
  }>;
  limitations: string[];
}

// ---------- IoU (correct, documented) ----------

function isFiniteBox(b: BoundingBox | null | undefined): b is BoundingBox {
  if (!b || typeof b !== "object") return false;
  const { x, y, w, h } = b;
  return (
    typeof x === "number" &&
    typeof y === "number" &&
    typeof w === "number" &&
    typeof h === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w > 0 &&
    h > 0
  );
}

/**
 * Intersection-over-union for normalized boxes.
 * Invalid or degenerate boxes score 0 (documented: a missing/invalid box is
 * never evidence of correct localization). Pure + deterministic.
 */
export function iou(a: BoundingBox | null | undefined, b: BoundingBox | null | undefined): number {
  if (!isFiniteBox(a) || !isFiniteBox(b)) return 0;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b!.x + b!.w;
  const by2 = b!.y + b!.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b!.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b!.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const union = a.w * a.h + b!.w * b!.h - inter;
  if (!(union > 0)) return 0;
  return inter / union;
}

function norm(s: string): string {
  return (s ?? "").trim().toLowerCase();
}

function labelsMatch(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function prf(tp: number, fp: number, fn: number): PRF {
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1 };
}

// ---------- Main scorer ----------

export function scoreBenchmark(
  inputs: BenchCaseInput[],
  opts: { assetsTracked?: number; assetsRepresented?: number } = {},
): BenchReport {
  const sorted = [...inputs].sort((a, b) =>
    a.groundTruth.caseId < b.groundTruth.caseId ? -1 : a.groundTruth.caseId > b.groundTruth.caseId ? 1 : 0,
  );

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let fpOnClean = 0;
  const perClass = new Map<string, { tp: number; fp: number; fn: number }>();
  const perScene = new Map<string, { tp: number; fp: number; fn: number; cases: number }>();
  const bump = (m: Map<string, { tp: number; fp: number; fn: number }>, k: string, f: "tp" | "fp" | "fn") => {
    const e = m.get(k) ?? { tp: 0, fp: 0, fn: 0 };
    e[f]++;
    m.set(k, e);
  };
  const bumpScene = (scene: string, f: "tp" | "fp" | "fn") => {
    const e = perScene.get(scene) ?? { tp: 0, fp: 0, fn: 0, cases: 0 };
    e[f]++;
    perScene.set(scene, e);
  };

  let assocEval = 0;
  let assocCorrect = 0;
  let assocUnresolved = 0;
  let assocPreds = 0;
  let frameEval = 0;
  let frameCorrect = 0;
  let voiceEval = 0;
  let voiceCorrect = 0;
  let kept = 0;
  let downgraded = 0;
  let dropped = 0;
  let skippedV = 0;
  let errors = 0;
  let skippedCases = 0;
  let erroredCases = 0;

  const caseRows: BenchReport["cases"] = [];

  for (const { groundTruth: g, predictions: preds } of sorted) {
    const sceneEntry = perScene.get(g.scene) ?? { tp: 0, fp: 0, fn: 0, cases: 0 };
    sceneEntry.cases++;
    perScene.set(g.scene, sceneEntry);

    const active = (preds ?? []).filter((p) => !p.skipped && !p.error);
    const skippedHere = (preds ?? []).some((p) => p.skipped);
    const errorHere = (preds ?? []).some((p) => p.error);
    if (skippedHere) skippedCases++;
    if (errorHere) {
      erroredCases++;
      errors += (preds ?? []).filter((p) => p.error).length;
    }

    const mismatches: string[] = [];
    const expected = g.clean
      ? "clean (no defect)"
      : `${g.category}:${g.defect} asset=${g.assetId ?? "null"} frame=${g.evidenceFrame ?? "null"}`;
    const predicted =
      active.length === 0
        ? "no prediction"
        : active
            .map(
              (p) =>
                `${p.category}:${p.defect} asset=${p.assetId ?? "null"} frame=${p.evidenceFrame ?? "null"} src=${p.evidenceSource} assoc=${p.assetAssociation ?? "null"} ver=${p.verification ?? "null"}`,
            )
            .join(" | ");

    if (skippedHere && active.length === 0) {
      caseRows.push({
        caseId: g.caseId,
        scene: g.scene,
        passed: true,
        skipped: true,
        errored: false,
        expected,
        predicted: "skipped",
        mismatches: [],
      });
      continue;
    }

    if (g.clean) {
      if (active.length === 0) {
        caseRows.push({
          caseId: g.caseId,
          scene: g.scene,
          passed: true,
          skipped: false,
          errored: errorHere,
          expected,
          predicted,
          mismatches: [],
        });
      } else {
        fp += active.length;
        fpOnClean += active.length;
        for (const p of active) {
          bump(perClass, norm(p.category) || "unknown", "fp");
          bumpScene(g.scene, "fp");
        }
        mismatches.push(`expected clean, got ${active.length} prediction(s)`);
        caseRows.push({
          caseId: g.caseId,
          scene: g.scene,
          passed: false,
          skipped: false,
          errored: errorHere,
          expected,
          predicted,
          mismatches,
        });
      }
      // Verification + association tallies still recorded for transparency.
      for (const p of active) tallyAux(p);
      continue;
    }

    // Defective case: at most one TP; extras are FP (documented dedupe).
    let consumed = false;
    for (const p of active) {
      const categoryOk = labelsMatch(p.category, g.category) && labelsMatch(p.defect, g.defect);
      const frameOk =
        g.evidenceFrame === null || g.evidenceFrame === undefined
          ? p.evidenceSource === "voice"
          : p.evidenceSource === "visual" && p.evidenceFrame === g.evidenceFrame;
      const boxOk =
        g.bbox === null || g.bbox === undefined
          ? true // no reliable GT box: do not judge localization here
          : p.bbox !== null && iou(p.bbox, g.bbox) >= BENCH_IOU_THRESHOLD;
      if (!consumed && categoryOk && frameOk && boxOk) {
        consumed = true;
        tp++;
        bump(perClass, norm(g.category), "tp");
        bumpScene(g.scene, "tp");
      } else {
        fp++;
        bump(perClass, norm(p.category) || "unknown", "fp");
        bumpScene(g.scene, "fp");
        if (!categoryOk) mismatches.push(`label mismatch: got ${p.category}:${p.defect}, want ${g.category}:${g.defect}`);
        else if (!frameOk) mismatches.push(`frame/box wrong: got frame=${p.evidenceFrame ?? "null"} src=${p.evidenceSource}, want frame=${g.evidenceFrame ?? "null"}`);
        else mismatches.push(`duplicate prediction for ${g.caseId} (GT already consumed)`);
      }
    }
    if (!consumed) {
      fn++;
      bump(perClass, norm(g.category), "fn");
      bumpScene(g.scene, "fn");
      if (active.length === 0) mismatches.push("missing prediction for defective case");
    }

    for (const p of active) tallyAux(p);

    // Association + frame + voice tallies use the FIRST active prediction as the
    // case representative (deterministic; extras already counted as FP above).
    const rep = active[0];
    if (rep) {
      if (g.assetId !== null && g.assetId !== undefined && g.assetId !== "") {
        assocEval++;
        assocPreds++;
        if (rep.assetAssociation === "unresolved") assocUnresolved++;
        if (rep.assetId === g.assetId) assocCorrect++;
        else if (rep.assetId !== g.assetId) mismatches.push(`association: got ${rep.assetId ?? "null"}, want ${g.assetId}`);
      } else {
        // GT has no reliable association: a confirmed link is itself a mismatch.
        if (rep.assetAssociation === "confirmed") mismatches.push("association should be unresolved (no reliable GT link)");
        else assocUnresolved++;
      }
      if (g.evidenceFrame !== null && g.evidenceFrame !== undefined) {
        frameEval++;
        if (rep.evidenceFrame === g.evidenceFrame && rep.evidenceSource === "visual") frameCorrect++;
      }
      if (g.voiceAssetId !== undefined) {
        voiceEval++;
        const want = g.voiceAssetId;
        const got = rep.assetId;
        // voiceAssetId null means "expect unresolved/null link".
        if (want === null ? got === null : got === want) voiceCorrect++;
        else mismatches.push(`voice link: got ${got ?? "null"}, want ${want ?? "null"}`);
      }
    }

    const passed = mismatches.length === 0 && !errorHere;
    caseRows.push({
      caseId: g.caseId,
      scene: g.scene,
      passed,
      skipped: false,
      errored: errorHere,
      expected,
      predicted,
      mismatches,
    });
  }

  function tallyAux(p: BenchPrediction): void {
    if (p.verification === "keep") kept++;
    else if (p.verification === "downgrade") downgraded++;
    else if (p.verification === "drop") dropped++;
    else if (p.verification === "skipped") skippedV++;
    if (p.error) errors++;
  }

  const detectionBase = prf(tp, fp, fn);
  const perClassOut: Record<string, PRF> = {};
  Array.from(perClass.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .forEach(([k, v]) => {
      perClassOut[k] = prf(v.tp, v.fp, v.fn);
    });
  const perSceneOut: Record<string, PRF & { cases: number }> = {};
  Array.from(perScene.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .forEach(([k, v]) => {
      perSceneOut[k] = { ...prf(v.tp, v.fp, v.fn), cases: v.cases };
    });

  const gtDefects = sorted.filter((c) => !c.groundTruth.clean).length;
  const totalPreds = sorted.reduce((n, c) => n + (c.predictions ?? []).filter((p) => !p.skipped && !p.error).length, 0);

  return {
    mode: "ground-truth-benchmark",
    realInference: false,
    datasetVersion: BENCH_DATASET_VERSION,
    iouThreshold: BENCH_IOU_THRESHOLD,
    counts: {
      cases: sorted.length,
      defectiveCases: sorted.filter((c) => !c.groundTruth.clean).length,
      cleanCases: sorted.filter((c) => c.groundTruth.clean).length,
      groundTruthDefects: gtDefects,
      predictions: totalPreds,
      skipped: skippedCases,
      errored: erroredCases,
    },
    detection: { ...detectionBase, falsePositivesOnClean: fpOnClean },
    perClass: perClassOut,
    perScene: perSceneOut,
    association: {
      evaluated: assocEval,
      correct: assocCorrect,
      accuracy: assocEval > 0 ? assocCorrect / assocEval : null,
      unresolved: assocUnresolved,
      unresolvedRate: assocPreds > 0 ? assocUnresolved / assocPreds : null,
      reason: assocEval === 0 ? "no cases with a reliable GT asset link" : undefined,
    },
    evidenceFrame: {
      evaluated: frameEval,
      correct: frameCorrect,
      accuracy: frameEval > 0 ? frameCorrect / frameEval : null,
      reason: frameEval === 0 ? "no cases with expected visual evidence frame" : undefined,
    },
    voiceMatching: {
      evaluated: voiceEval,
      correct: voiceCorrect,
      accuracy: voiceEval > 0 ? voiceCorrect / voiceEval : null,
      reason: voiceEval === 0 ? "no cases with voice-note ground truth" : undefined,
    },
    verification: { kept, downgraded, dropped, skipped: skippedV, errors },
    coverage: {
      assetsTracked: opts.assetsTracked ?? 0,
      assetsRepresented: opts.assetsRepresented ?? 0,
      note: "Assets represented counts cases whose evidence frame was selected; unrepresented assets were NOT visually inspected in this benchmark.",
    },
    cases: caseRows,
    limitations: [
      "SYNTHETIC pipeline-logic benchmark: no real images or Meta inference; measures evidence handling, not visual detection accuracy.",
      "Unit of evaluation is one case; duplicate predictions for the same case count as false positives.",
      "Category matching is substring/case-insensitive by design for this benchmark; frame and IoU (0.5) gates still apply for a true positive.",
      "Cases without a reliable GT box skip the localization gate (documented per case) rather than scoring zero.",
    ],
  };
}

/** Deterministic serialization: stable key order via the scorer's sorted output. */
export function toBenchJson(report: BenchReport): string {
  return JSON.stringify(report, null, 2);
}

// ============ Asset-level real-media path (real-v1, static-image) ============
// Unit of evaluation: ONE DEFECT EPISODE (asset occurrence), not one frame.
// Five adjacent frames of the same rust pole = one episode = at most one TP.
// Frame-level counts are reported separately and never feed primary P/R.
// Static images: tracking, temporal frame selection, and note-interval alignment
// are NOT APPLICABLE — reported as explicit null with reasons, never scored.

export type Observability = "observable" | "not-observable" | "uncertain";

/**
 * Evaluation states for asset-level scoring. Missing predictions must never be
 * mistaken for failed detections or successful clean evaluations:
 * - "predictions-unavailable" (State A): no artifact exists / cannot be mapped /
 *   run never performed. NOTHING is scored; every performance metric is null or
 *   explicitly unavailable; cases are not_evaluated (never FN, never PASS).
 * - "completed-zero-detections" (State B): an explicit completed-run artifact
 *   whose prediction list is empty. Scored as a genuine zero-detection result:
 *   known defects become FN, precision is null (0/0), clean cases may pass.
 * - "completed-with-predictions" (State C): actual predictions scored normally.
 * Passing an array (even empty) asserts a completed run; passing null/undefined
 * asserts no artifact. Never substitute one for the other.
 */
export type EvaluationState =
  | "predictions-unavailable"
  | "completed-zero-detections"
  | "completed-with-predictions";

export type BenchStatus = "scored-pass" | "scored-fail" | "not-evaluated" | "input-error";

/** Process exit-code contract for benchmark runs. */
export const BENCH_EXIT_CODES = {
  pass: 0,
  fail: 1,
  notEvaluated: 2,
  inputError: 3,
} as const;

export function exitCodeForStatus(status: BenchStatus): number {
  if (status === "scored-pass") return BENCH_EXIT_CODES.pass;
  if (status === "scored-fail") return BENCH_EXIT_CODES.fail;
  if (status === "not-evaluated") return BENCH_EXIT_CODES.notEvaluated;
  return BENCH_EXIT_CODES.inputError;
}

export interface RealGroundTruth {
  caseId: string;
  scene: string;
  sourceMediaId: string;
  frameId: string;
  timestamp: number;
  assetId: string;
  assetCategory: string;
  clean: boolean;
  defectClass: string;
  visualDescription: string;
  bbox: BoundingBox | null;
  bboxReliable: boolean;
  observability: Observability;
  /** Defect episode for dedupe. Null for clean cases. Same episode across frames = one instance. */
  episodeId: string | null;
  /** Metrics to exclude this case from (e.g. ["detection"] when uncertain). */
  excludedFrom: string[];
  annotationNotes: string;
}

export interface RealPrediction {
  caseId: string;
  episodeId: string | null;
  assetId: string | null;
  category: string;
  defectClass: string;
  /** True when the cited frame actually contains the annotated defect. */
  frameContainsDefect: boolean | null;
  bbox: BoundingBox | null;
  evidenceSource: "visual" | "voice";
  assetAssociation: "confirmed" | "unresolved" | null;
  verification: "keep" | "downgrade" | "drop" | "skipped" | null;
  error?: boolean;
  skipped?: boolean;
  /** Provenance label: "actual" (pipeline), "cached" (recorded), "hand-test" (scorer test only). */
  provenance: "actual" | "cached" | "hand-test";
}

export interface AssetBenchReport {
  mode: "asset-benchmark";
  realInference: false;
  datasetVersion: string;
  datasetType: "static-image" | "genuine-video" | "mixed";
  iouThreshold: number;
  /** Overall outcome. Terminal summary, JSON, and process exit code all derive from this. */
  status: BenchStatus;
  evaluationState: EvaluationState;
  predictionsAvailable: boolean;
  predictionProvenance: string;
  counts: {
    cases: number;
    scenes: number;
    assets: number;
    episodes: number;
    cleanCases: number;
    uncertainCases: number;
    excludedFromDetection: number;
    predictions: number;
    skipped: number;
    errored: number;
  };
  detection: PRF & { falsePositivesOnClean: number; unit: string; unavailable: boolean; reason?: string; partial?: boolean };
  perClass: Record<string, PRF>;
  perScene: Record<string, PRF & { cases: number }>;
  perEpisode: Array<{ episodeId: string; scene: string; cases: string[]; status: "tp" | "fp" | "fn" | "excluded" | "unpredicted" | "not_evaluated" }>;
  association: { evaluated: number; correct: number; accuracy: number | null; unresolved: number; unresolvedRate: number | null; unavailable: boolean; reason?: string };
  evidenceFrame: { evaluated: number; correct: number; accuracy: number | null; unavailable: boolean; reason?: string };
  localization: { evaluated: number; correct: number; accuracy: number | null; unavailable: boolean; reason?: string };
  /**
   * Asset-strip overlap diagnostic (static path only): IoU of model
   * damage-region boxes against whole-asset GT strips, frame-matched.
   * Engineering signal only — NEVER defect-localization accuracy, since the
   * two box types annotate different targets. Absent on non-static paths.
   */
  assetOverlap?: {
    evaluated: number;
    overlapping: number;
    invalid: number;
    missing: number;
    note: string;
  };
  voiceMatching: { evaluated: number; correct: number; accuracy: number | null; unavailable: boolean; reason: string };
  verification: { kept: number; downgraded: number; dropped: number; skipped: number; errors: number; unavailable: boolean; reason?: string };
  coverage: { assetsPresent: number; assetsTracked: number | null; assetsRepresented: number | null; note: string };
  /**
   * Frame-execution coverage (static path only). evaluatedFrames counts GT
   * frames with manifest execution evidence or explicit prediction records;
   * expectedFrames counts every GT frame. Until complete, the report status
   * is not-evaluated and detection metrics are partial (see detection.partial).
   */
  evaluationCoverage?: {
    evaluatedFrames: number;
    expectedFrames: number;
    complete: boolean;
    unevaluatedFrames: string[];
    note: string;
  };
  unmappablePredictions: { count: number; caseIds: string[]; note: string };
  cases: BenchReport["cases"];
  limitations: string[];
}

function isValidNormBox(b: unknown): boolean {
  if (!b || typeof b !== "object") return false;
  const { x, y, w, h } = b as Record<string, unknown>;
  return (
    typeof x === "number" && typeof y === "number" && typeof w === "number" && typeof h === "number" &&
    Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h) &&
    x >= 0 && y >= 0 && w > 0 && h > 0 && x <= 1 && y <= 1 && x + w <= 1 + 1e-6 && y + h <= 1 + 1e-6
  );
}

/**
 * Validate a real-media dataset. Throws with a specific reason on malformed
 * annotations instead of producing misleading metrics. Pure + deterministic.
 */
export function validateRealDataset(cases: RealGroundTruth[]): { scenes: number; assets: number; episodes: number } {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error("real dataset: no cases");
  const ids = new Set<string>();
  const scenes = new Set<string>();
  const assets = new Set<string>();
  const episodes = new Set<string>();
  for (const c of cases) {
    if (!c || typeof c !== "object") throw new Error("real dataset: non-object case");
    for (const f of ["caseId", "scene", "sourceMediaId", "frameId", "assetId", "assetCategory"] as const) {
      if (typeof c[f] !== "string" || (c[f] as string).length === 0) throw new Error(`real dataset: ${c.caseId ?? "?"} missing ${f}`);
    }
    if (ids.has(c.caseId)) throw new Error(`real dataset: duplicate caseId ${c.caseId}`);
    ids.add(c.caseId);
    scenes.add(c.scene);
    assets.add(c.assetId);
    if (!Number.isFinite(c.timestamp) || c.timestamp < 0) throw new Error(`real dataset: ${c.caseId} bad timestamp`);
    if (c.bbox !== null && !isValidNormBox(c.bbox)) throw new Error(`real dataset: ${c.caseId} invalid bbox`);
    if (c.episodeId) {
      if (c.clean) throw new Error(`real dataset: ${c.caseId} clean case must not carry an episodeId`);
      episodes.add(c.episodeId);
    } else if (!c.clean && c.observability === "observable" && !(c.excludedFrom ?? []).includes("detection")) {
      throw new Error(`real dataset: ${c.caseId} defective observable case missing episodeId`);
    }
    if (!["observable", "not-observable", "uncertain"].includes(c.observability)) throw new Error(`real dataset: ${c.caseId} bad observability`);
    if (!Array.isArray(c.excludedFrom)) throw new Error(`real dataset: ${c.caseId} excludedFrom must be an array`);
  }
  return { scenes: scenes.size, assets: assets.size, episodes: episodes.size };
}

/**
 * Validate a prediction artifact and classify it into exactly one state.
 * Pure + deterministic. Never invents predictions; never touches the network.
 *
 * Accepted inputs:
 * - null/undefined → { state: "missing" }: no artifact exists, it cannot be
 *   mapped, or the run was never performed. Score NOTHING from this.
 * - An array of prediction entries → { state: "completed" }: an explicit
 *   completed run. An EMPTY array is a legitimate zero-detection result, NOT
 *   a missing artifact. Each entry must carry caseId + provenance
 *   ("actual" | "cached" | "hand-test"); malformed entries → "invalid".
 * - An envelope { status: "completed", predictions: [...] } → same as an array
 *   (forward-compatible with future run-record files). Any other envelope or
 *   status (e.g. "failed", "pending") → "invalid" with the reason preserved.
 * - Anything else (empty file parsed as "", numbers, half-shaped objects) →
 *   "invalid": fail clearly instead of scoring garbage.
 *
 * "stale" (datasetVersion mismatch) is checked by the caller, which knows the
 * benchmark's version; the mismatch reason surfaces as an input error.
 */
export interface PredictionArtifactValidation {
  state: "missing" | "completed" | "invalid";
  predictions: RealPrediction[];
  /** The run manifest embedded in the envelope, if any (validated separately). */
  run?: unknown;
  reason: string;
}

const PREDICTION_PROVENANCES = ["actual", "cached", "hand-test"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validatePredictionEntry(p: unknown, index: number): RealPrediction {
  if (!isRecord(p)) throw new Error(`prediction artifact: entry ${index} is not an object`);
  const { caseId, category, defectClass, provenance } = p as Record<string, unknown>;
  if (typeof caseId !== "string" || caseId.length === 0)
    throw new Error(`prediction artifact: entry ${index} missing caseId`);
  if (typeof category !== "string" || typeof defectClass !== "string")
    throw new Error(`prediction artifact: entry ${index} missing category/defectClass`);
  if (!PREDICTION_PROVENANCES.includes(provenance as (typeof PREDICTION_PROVENANCES)[number]))
    throw new Error(
      `prediction artifact: entry ${index} has unknown provenance ${JSON.stringify(provenance)} (expected one of actual|cached|hand-test)`,
    );
  return p as unknown as RealPrediction;
}

export function validatePredictionArtifact(raw: unknown): PredictionArtifactValidation {
  if (raw === null || raw === undefined)
    return {
      state: "missing",
      predictions: [],
      reason: "no prediction artifact: run never performed or artifact not mapped to this benchmark",
    };
  let list: unknown = raw;
  let run: unknown;
  if (isRecord(raw) && "predictions" in raw) {
    const status = (raw as { status?: unknown }).status;
    if (status !== "completed")
      return {
        state: "invalid",
        predictions: [],
        reason: `prediction artifact status is ${JSON.stringify(status)} (expected "completed"); a failed or pending run is not a scored result`,
      };
    list = (raw as { predictions: unknown }).predictions;
    run = (raw as { run?: unknown }).run;
  }
  if (!Array.isArray(list))
    return {
      state: "invalid",
      predictions: [],
      reason: "prediction artifact is neither a prediction array nor a {status, predictions} envelope",
    };
  try {
    const validated = list.map((p, i) => validatePredictionEntry(p, i));
    if (validated.length === 0)
      return {
        state: "completed",
        predictions: [],
        run,
        reason: "explicit completed run that produced zero detections (empty prediction set)",
      };
    return {
      state: "completed",
      predictions: validated,
      run,
      reason: `completed run with ${validated.length} prediction(s)`,
    };
  } catch (err) {
    return {
      state: "invalid",
      predictions: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * State A report: ground truth exists but no prediction artifact does.
 * NOTHING is scored: no TP/FP/FN as findings (counters stay 0 with
 * unavailable:true + reason), no PASS on clean cases, no FN on defect cases.
 * Every non-excluded case is marked skipped + not evaluated. Ground-truth
 * counts (cases, scenes, assets, episodes) are still reported — they describe
 * the dataset, not model performance.
 */
function notEvaluatedReport(
  gt: RealGroundTruth[],
  opts: { datasetVersion: string; datasetType: AssetBenchReport["datasetType"]; excludedCount: number },
): AssetBenchReport {
  const excluded = (c: RealGroundTruth) => (c.excludedFrom ?? []).includes("detection");
  const episodes = new Map<string, RealGroundTruth[]>();
  for (const c of gt) {
    if (!c.clean && c.episodeId && !excluded(c)) {
      const l = episodes.get(c.episodeId) ?? [];
      l.push(c);
      episodes.set(c.episodeId, l);
    }
  }
  const perEpisode: AssetBenchReport["perEpisode"] = Array.from(episodes.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([episodeId, members]) => ({
      episodeId,
      scene: members[0].scene,
      cases: members.map((m) => m.caseId),
      status: "not_evaluated" as const,
    }));
  const caseRows: BenchReport["cases"] = gt.map((c) => {
    if (excluded(c))
      return {
        caseId: c.caseId,
        scene: c.scene,
        passed: true,
        skipped: true,
        errored: false,
        expected: `excluded from detection (${c.observability})`,
        predicted: "not scored",
        mismatches: [],
      };
    return {
      caseId: c.caseId,
      scene: c.scene,
      passed: false,
      skipped: true,
      errored: false,
      expected: c.clean ? "clean (no defect)" : `${c.assetCategory}:${c.defectClass} episode=${c.episodeId ?? "n/a"}`,
      predicted: "not evaluated — no prediction artifact",
      mismatches: [],
    };
  });
  const notEvaluatedCount = gt.filter((c) => !excluded(c)).length;
  const perSceneOut: Record<string, PRF & { cases: number }> = {};
  for (const c of gt) {
    const e = perSceneOut[c.scene] ?? { ...prf(0, 0, 0), cases: 0 };
    e.cases++;
    perSceneOut[c.scene] = e;
  }
  const unavailableReason = "no prediction artifact — model accuracy not measured";
  return {
    mode: "asset-benchmark",
    realInference: false,
    datasetVersion: opts.datasetVersion,
    datasetType: opts.datasetType,
    iouThreshold: BENCH_IOU_THRESHOLD,
    status: "not-evaluated",
    evaluationState: "predictions-unavailable",
    predictionsAvailable: false,
    predictionProvenance: "none — visual accuracy NOT measured; no matching actual predictions exist",
    counts: {
      cases: gt.length,
      scenes: new Set(gt.map((c) => c.scene)).size,
      assets: new Set(gt.map((c) => c.assetId)).size,
      episodes: episodes.size,
      cleanCases: gt.filter((c) => c.clean).length,
      uncertainCases: gt.filter((c) => c.observability === "uncertain").length,
      excludedFromDetection: opts.excludedCount,
      predictions: 0,
      skipped: notEvaluatedCount + opts.excludedCount,
      errored: 0,
    },
    detection: {
      ...prf(0, 0, 0),
      falsePositivesOnClean: 0,
      unit: "defect episode (asset occurrence); adjacent frames of one episode count once",
      unavailable: true,
      reason: unavailableReason,
    },
    perClass: {},
    perScene: perSceneOut,
    perEpisode,
    association: { evaluated: 0, correct: 0, accuracy: null, unresolved: 0, unresolvedRate: null, unavailable: true, reason: unavailableReason },
    evidenceFrame: { evaluated: 0, correct: 0, accuracy: null, unavailable: true, reason: unavailableReason },
    localization: { evaluated: 0, correct: 0, accuracy: null, unavailable: true, reason: unavailableReason },
    voiceMatching: { evaluated: 0, correct: 0, accuracy: null, unavailable: true, reason: "static-image benchmark: no voice notes; tracking and note-interval alignment are not applicable" },
    verification: { kept: 0, downgraded: 0, dropped: 0, skipped: 0, errors: 0, unavailable: true, reason: unavailableReason },
    coverage: { assetsPresent: new Set(gt.map((c) => c.assetId)).size, assetsTracked: null, assetsRepresented: null, note: "Static images: assets present are annotated; tracked/represented are NOT APPLICABLE (no video tracking ran). Being present is not inspection." },
    unmappablePredictions: { count: 0, caseIds: [], note: "no prediction artifact supplied; nothing to map" },
    cases: caseRows,
    limitations: [
      "NOT EVALUATED: ground truth is available but no prediction artifact exists, so no detection, association, frame, localization, verification, or coverage finding is reported. Counters read 0 with unavailable:true — never interpret them as measured zeros.",
      "Static-image derivative frames (Ken Burns over stills): image-level asset/defect detection only. Tracking, temporal frame selection, and note-interval alignment are not applicable and are reported as unavailable, never scored.",
      "Primary detection unit is the defect episode; adjacent frames of one episode count once. Frame-level views are listed per episode, never as independent detections.",
      "Uncertain annotations are excluded from detection and reported separately, never counted as success.",
      "Hand-authored test predictions (provenance hand-test) validate the scorer only and are never evidence of model performance.",
    ],
  };
}

export function scoreAssetBenchmark(
  groundTruth: RealGroundTruth[],
  predictions: RealPrediction[] | null | undefined,
  opts: { datasetVersion?: string; datasetType?: AssetBenchReport["datasetType"] } = {},
): AssetBenchReport {
  const gt = [...groundTruth].sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  const excluded = (c: RealGroundTruth) => (c.excludedFrom ?? []).includes("detection");
  const excludedCount = gt.length - gt.filter((c) => !excluded(c)).length;

  // ---- State A: no prediction artifact. Score NOTHING. ----
  // An empty array is NOT the same as a missing artifact (see States B/C
  // below); only null/undefined takes this branch.
  if (predictions === null || predictions === undefined) {
    return notEvaluatedReport(gt, {
      datasetVersion: opts.datasetVersion ?? "real-v1",
      datasetType: opts.datasetType ?? "static-image",
      excludedCount,
    });
  }

  const preds = [...predictions];
  const predsByCase = new Map<string, RealPrediction[]>();
  for (const p of preds) {
    const l = predsByCase.get(p.caseId) ?? [];
    l.push(p);
    predsByCase.set(p.caseId, l);
  }

  const scored = gt.filter((c) => !excluded(c));

  // Episode grouping: one GT episode = one detection instance.
  const episodes = new Map<string, RealGroundTruth[]>();
  for (const c of scored) {
    if (!c.clean && c.episodeId) {
      const l = episodes.get(c.episodeId) ?? [];
      l.push(c);
      episodes.set(c.episodeId, l);
    }
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let fpOnClean = 0;
  const perClass = new Map<string, { tp: number; fp: number; fn: number }>();
  const perScene = new Map<string, { tp: number; fp: number; fn: number; cases: number }>();
  const bumpC = (k: string, f: "tp" | "fp" | "fn") => {
    const e = perClass.get(k) ?? { tp: 0, fp: 0, fn: 0 };
    e[f]++;
    perClass.set(k, e);
  };
  const bumpS = (s: string, f: "tp" | "fp" | "fn") => {
    const e = perScene.get(s) ?? { tp: 0, fp: 0, fn: 0, cases: 0 };
    e[f]++;
    perScene.set(s, e);
  };
  for (const c of scored) {
    const e = perScene.get(c.scene) ?? { tp: 0, fp: 0, fn: 0, cases: 0 };
    e.cases++;
    perScene.set(c.scene, e);
  }

  const perEpisode: AssetBenchReport["perEpisode"] = [];
  // Predictions referencing no known case or episode cannot be mapped to ground
  // truth. They are reported separately — never silently dropped into (or out
  // of) precision/recall.
  const knownCaseIds = new Set(gt.map((c) => c.caseId));
  const knownEpisodes = new Set(episodes.keys());
  const unmappable = preds.filter(
    (p) => !p.skipped && !p.error && !knownCaseIds.has(p.caseId) && (p.episodeId === null || p.episodeId === undefined || !knownEpisodes.has(p.episodeId)),
  );
  const unmappedNote =
    unmappable.length > 0
      ? `no mapped prediction (${unmappable.length} unmappable prediction(s) lack asset identity — see unmappablePredictions)`
      : null;
  let assocEval = 0;
  let assocCorrect = 0;
  let assocUnresolved = 0;
  let frameEval = 0;
  let frameCorrect = 0;
  let locEval = 0;
  let locCorrect = 0;
  let kept = 0;
  let downgraded = 0;
  let dropped = 0;
  let skippedV = 0;
  let errors = 0;
  let skipped = 0;
  let errored = 0;
  const caseRows: BenchReport["cases"] = [];

  const tallyV = (p: RealPrediction) => {
    if (p.verification === "keep") kept++;
    else if (p.verification === "downgrade") downgraded++;
    else if (p.verification === "drop") dropped++;
    else if (p.verification === "skipped") skippedV++;
    if (p.error) errors++;
  };

  // Score each episode once: a matching prediction on ANY of its frames = TP.
  // A correct category with the WRONG asset ID is a misassociation, never a
  // true positive: exact stable-ID match is part of the TP gate.
  const consumedPred = new Set<RealPrediction>();
  for (const [ep, members] of Array.from(episodes.entries()).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const rep = members[0];
    const scene = rep.scene;
    const memberCaseIds = new Set(members.map((m) => m.caseId));
    const candidates = preds.filter((p) => !p.skipped && !p.error && (memberCaseIds.has(p.caseId) || p.episodeId === ep));
    let hit: RealPrediction | null = null;
    let assocMismatch: string | null = null;
    for (const p of candidates) {
      const catOk = labelsMatch(p.category, rep.assetCategory) && (labelsMatch(p.defectClass, rep.defectClass) || norm(p.defectClass) === "");
      const frameOk = p.frameContainsDefect === true && p.evidenceSource === "visual";
      const gtBox = members.find((m) => m.bbox && m.bboxReliable)?.bbox ?? null;
      const boxOk = gtBox === null ? true : p.bbox !== null && iou(p.bbox, gtBox) >= BENCH_IOU_THRESHOLD;
      if (!catOk || !frameOk || !boxOk) continue;
      // Exact-ID gate: borrowing a sibling asset's identity is a failure.
      if (rep.assetId && p.assetId !== rep.assetId) {
        assocMismatch = `association: got ${p.assetId ?? "null"}, want ${rep.assetId}`;
        continue;
      }
      if (!rep.assetId && p.assetAssociation === "confirmed") {
        assocMismatch = "association should be unresolved (no reliable GT link)";
        continue;
      }
      hit = p;
      break;
    }
    if (hit) {
      tp++;
      bumpC(norm(rep.assetCategory), "tp");
      bumpS(scene, "tp");
      consumedPred.add(hit);
      perEpisode.push({ episodeId: ep, scene, cases: members.map((m) => m.caseId), status: "tp" });
      assocEval++;
      if (hit.assetAssociation === "unresolved") assocUnresolved++;
      if (hit.assetId === rep.assetId) assocCorrect++;
      frameEval++;
      if (hit.frameContainsDefect === true) frameCorrect++;
      if (rep.bbox && rep.bboxReliable) {
        locEval++;
        if (hit.bbox && iou(hit.bbox, rep.bbox) >= BENCH_IOU_THRESHOLD) locCorrect++;
      }
      tallyV(hit);
      for (const m of members) {
        caseRows.push({ caseId: m.caseId, scene: m.scene, passed: true, skipped: false, errored: false, expected: `${rep.assetCategory}:${rep.defectClass} episode=${ep}`, predicted: `${hit.category}:${hit.defectClass} asset=${hit.assetId ?? "null"}`, mismatches: [] });
      }
    } else {
      fn++;
      bumpC(norm(rep.assetCategory), "fn");
      bumpS(scene, "fn");
      const hasPred = candidates.length > 0;
      perEpisode.push({ episodeId: ep, scene, cases: members.map((m) => m.caseId), status: hasPred ? "fp" : "unpredicted" });
      if (hasPred) {
        fp++;
        for (const p of candidates) {
          if (!consumedPred.has(p)) {
            bumpC(norm(p.category) || "unknown", "fp");
            consumedPred.add(p);
            tallyV(p);
          }
        }
      }
      for (const m of members) {
        caseRows.push({ caseId: m.caseId, scene: m.scene, passed: false, skipped: false, errored: false, expected: `${rep.assetCategory}:${rep.defectClass} episode=${ep}`, predicted: candidates.length ? "prediction present but frame/box/association wrong" : (unmappedNote ?? "no prediction (unavailable)"), mismatches: candidates.length ? [assocMismatch ?? "no candidate satisfied category + frame-contains-defect + IoU + exact-asset gates"] : [unmappedNote ?? "missing prediction for defective episode"] });
      }
    }
  }

  // Clean scored cases: any active prediction = FP.
  for (const c of scored) {
    if (!c.clean) continue;
    const list = (predsByCase.get(c.caseId) ?? []).filter((p) => !p.skipped && !p.error);
    for (const p of list) {
      if (consumedPred.has(p)) continue;
      fp++;
      fpOnClean++;
      bumpC(norm(p.category) || "unknown", "fp");
      bumpS(c.scene, "fp");
      tallyV(p);
    }
    const skippedHere = (predsByCase.get(c.caseId) ?? []).some((p) => p.skipped);
    const errorHere = (predsByCase.get(c.caseId) ?? []).some((p) => p.error);
    if (skippedHere) skipped++;
    if (errorHere) errored++;
    caseRows.push({
      caseId: c.caseId,
      scene: c.scene,
      passed: list.length === 0,
      skipped: skippedHere,
      errored: errorHere,
      expected: "clean (no defect)",
      predicted: list.length ? list.map((p) => `${p.category}:${p.defectClass}`).join(" | ") : "no prediction",
      mismatches: list.length ? [`expected clean, got ${list.length} prediction(s)`] : [],
    });
  }

  // Excluded cases: reported, never scored.
  for (const c of gt) {
    if (!excluded(c)) continue;
    caseRows.push({ caseId: c.caseId, scene: c.scene, passed: true, skipped: true, errored: false, expected: `excluded from detection (${c.observability})`, predicted: "not scored", mismatches: [] });
    skipped++;
  }
  caseRows.sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));

  const perClassOut: Record<string, PRF> = {};
  Array.from(perClass.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .forEach(([k, v]) => {
      perClassOut[k] = prf(v.tp, v.fp, v.fn);
    });
  const perSceneOut: Record<string, PRF & { cases: number }> = {};
  Array.from(perScene.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .forEach(([k, v]) => {
      perSceneOut[k] = { ...prf(v.tp, v.fp, v.fn), cases: v.cases };
    });

  const assets = new Set(gt.map((c) => c.assetId)).size;
  const activePreds = preds.filter((p) => !p.skipped && !p.error);
  const provenances = Array.from(new Set(activePreds.map((p) => p.provenance).filter(Boolean))).sort();
  const predictionsAvailable = true; // an array was supplied: an explicit completed run (possibly zero detections)
  const evaluationState: EvaluationState =
    activePreds.length === 0 ? "completed-zero-detections" : "completed-with-predictions";
  const failedCases = caseRows.filter((c) => !c.passed && !c.skipped);
  const status: BenchStatus = failedCases.length === 0 ? "scored-pass" : "scored-fail";
  return {
    mode: "asset-benchmark",
    realInference: false,
    datasetVersion: opts.datasetVersion ?? "real-v1",
    datasetType: opts.datasetType ?? "static-image",
    iouThreshold: BENCH_IOU_THRESHOLD,
    status,
    evaluationState,
    predictionsAvailable,
    predictionProvenance:
      activePreds.length === 0
        ? "explicit completed run that produced zero detections (empty prediction set)"
        : `completed run with ${activePreds.length} prediction(s); observed provenance: ${provenances.join(", ") || "unspecified"}`,
    counts: {
      cases: gt.length,
      scenes: new Set(gt.map((c) => c.scene)).size,
      assets,
      episodes: episodes.size,
      cleanCases: gt.filter((c) => c.clean).length,
      uncertainCases: gt.filter((c) => c.observability === "uncertain").length,
      excludedFromDetection: excludedCount,
      predictions: activePreds.length,
      skipped,
      errored,
    },
    detection: { ...prf(tp, fp, fn), falsePositivesOnClean: fpOnClean, unit: "defect episode (asset occurrence); adjacent frames of one episode count once", unavailable: false },
    perClass: perClassOut,
    perScene: perSceneOut,
    perEpisode,
    association: { evaluated: assocEval, correct: assocCorrect, accuracy: assocEval > 0 ? assocCorrect / assocEval : null, unresolved: assocUnresolved, unresolvedRate: assocEval > 0 ? assocUnresolved / assocEval : null, unavailable: false, reason: assocEval === 0 ? "no scored episodes with predictions" : undefined },
    evidenceFrame: { evaluated: frameEval, correct: frameCorrect, accuracy: frameEval > 0 ? frameCorrect / frameEval : null, unavailable: false, reason: frameEval === 0 ? "no scored episodes with predictions" : undefined },
    localization: { evaluated: locEval, correct: locCorrect, accuracy: locEval > 0 ? locCorrect / locEval : null, unavailable: false, reason: locEval === 0 ? "no reliable GT boxes among scored episodes with predictions" : undefined },
    voiceMatching: { evaluated: 0, correct: 0, accuracy: null, unavailable: true, reason: "static-image benchmark: no voice notes; tracking and note-interval alignment are not applicable" },
    verification: { kept, downgraded, dropped, skipped: skippedV, errors, unavailable: false },
    unmappablePredictions: {
      count: unmappable.length,
      caseIds: Array.from(new Set(unmappable.map((p) => p.caseId))).sort(),
      note: "predictions referencing no known case or episode; excluded from all metrics, listed here so nothing is silently dropped",
    },
    coverage: { assetsPresent: assets, assetsTracked: null, assetsRepresented: null, note: "Static images: assets present are annotated; tracked/represented are NOT APPLICABLE (no video tracking ran). Being present is not inspection." },
    cases: caseRows,
    limitations: [
      "Static-image derivative frames (Ken Burns over stills): image-level asset/defect detection only. Tracking, temporal frame selection, and note-interval alignment are not applicable and are reported as unavailable, never scored.",
      "Primary detection unit is the defect episode; adjacent frames of one episode count once. Frame-level views are listed per episode, never as independent detections.",
      "Uncertain annotations are excluded from detection and reported separately, never counted as success.",
      "Hand-authored test predictions (provenance hand-test) validate the scorer only and are never evidence of model performance.",
    ],
  };
}

export function toAssetBenchJson(report: AssetBenchReport): string {
  return JSON.stringify(report, null, 2);
}

// ============ Provenance manifest validation (real-v1, pure) ============

export interface ProvenanceFrame {
  frameId: string;
  file: string;
  sha256: string;
  timestamp: number;
  scene: string;
}

export interface ProvenanceSource {
  sourceMediaId: string;
  commonsTitle?: string;
  filePageUrl?: string;
  author?: string;
  license?: string;
  licensePageUrl?: string;
  sampleType?: string;
  downloadDate?: string;
  verifiedDate?: string;
  frames?: ProvenanceFrame[];
}

export interface ProvenanceManifest {
  datasetVersion?: string;
  annotationVersion?: string;
  mediaType?: string;
  sources?: ProvenanceSource[];
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const UNVERIFIED_RE = /^(unknown|not recorded|tbd|n\/a|none)([\s:—-]|$)/i;

/**
 * Validate a provenance manifest against ground-truth cases. Throws with a
 * specific reason on any defect; returns counts plus warnings for explicitly
 * unknown (but honestly marked) fields. Pure + deterministic.
 *
 * Hard rules (missing/contradictory provenance is an input error, never a
 * silent pass): license + license page must be verified real values (a
 * "not recorded" license excludes the sample); every case frame must resolve
 * to exactly one manifest frame; checksums must be well-formed; defect
 * episodes must not span scenes; a static-image dataset must not claim
 * genuine-video sources.
 */
export function validateProvenanceManifest(
  manifest: unknown,
  cases: RealGroundTruth[],
): { sources: number; frames: number; assets: number; episodes: number; warnings: string[] } {
  if (!isRecord(manifest)) throw new Error("provenance manifest: not an object");
  const m = manifest as ProvenanceManifest;
  if (typeof m.datasetVersion !== "string" || m.datasetVersion.length === 0)
    throw new Error("provenance manifest: missing datasetVersion");
  if (typeof m.annotationVersion !== "string" || m.annotationVersion.length === 0)
    throw new Error("provenance manifest: missing annotationVersion");
  if (m.mediaType !== "static-image" && m.mediaType !== "genuine-video" && m.mediaType !== "mixed")
    throw new Error(`provenance manifest: bad mediaType ${JSON.stringify(m.mediaType)}`);
  if (!Array.isArray(m.sources) || m.sources.length === 0) throw new Error("provenance manifest: no sources");

  const warnings: string[] = [];
  const seenSources = new Set<string>();
  const frameMap = new Map<string, { sourceId: string; file: string; sha256: string; timestamp: number; scene: string }>();
  for (const s of m.sources) {
    if (!isRecord(s)) throw new Error("provenance manifest: non-object source");
    const src = s as ProvenanceSource;
    if (typeof src.sourceMediaId !== "string" || src.sourceMediaId.length === 0)
      throw new Error("provenance manifest: source missing sourceMediaId");
    if (seenSources.has(src.sourceMediaId))
      throw new Error(`provenance manifest: duplicate sourceMediaId ${src.sourceMediaId}`);
    seenSources.add(src.sourceMediaId);
    // License must be VERIFIED: an unrecorded license blocks distribution.
    if (typeof src.license !== "string" || src.license.length === 0 || UNVERIFIED_RE.test(src.license))
      throw new Error(`provenance manifest: source ${src.sourceMediaId} has no verified license`);
    if (
      typeof src.licensePageUrl !== "string" ||
      !src.licensePageUrl.startsWith("http") ||
      UNVERIFIED_RE.test(src.licensePageUrl)
    )
      throw new Error(`provenance manifest: source ${src.sourceMediaId} has no verified license page`);
    if (typeof src.author !== "string" || src.author.length === 0)
      throw new Error(`provenance manifest: source ${src.sourceMediaId} missing author`);
    if (UNVERIFIED_RE.test(src.author))
      warnings.push(`source ${src.sourceMediaId}: author unknown — attribution incomplete`);
    if (typeof src.downloadDate === "string" && UNVERIFIED_RE.test(src.downloadDate))
      warnings.push(`source ${src.sourceMediaId}: historical download date unknown (recorded as unknown, never backfilled)`);
    const st = (src as { sampleType?: unknown }).sampleType;
    if (st !== "derivative-frame-from-still" && st !== "original-still" && st !== "genuine-video")
      throw new Error(`provenance manifest: source ${src.sourceMediaId} has bad sampleType ${JSON.stringify(st)}`);
    if (m.mediaType === "static-image" && st === "genuine-video")
      throw new Error(
        `provenance manifest: source ${src.sourceMediaId} claims genuine video in a static-image dataset`,
      );
    if (!Array.isArray(src.frames) || src.frames.length === 0)
      throw new Error(`provenance manifest: source ${src.sourceMediaId} lists no frames`);
    for (const f of src.frames) {
      if (!isRecord(f)) throw new Error(`provenance manifest: source ${src.sourceMediaId} has non-object frame`);
      const fr = f as ProvenanceFrame;
      if (typeof fr.frameId !== "string" || fr.frameId.length === 0)
        throw new Error(`provenance manifest: source ${src.sourceMediaId} has frame without frameId`);
      if (frameMap.has(fr.frameId))
        throw new Error(`provenance manifest: duplicate frameId ${fr.frameId}`);
      if (typeof fr.file !== "string" || fr.file.length === 0)
        throw new Error(`provenance manifest: frame ${fr.frameId} missing file path`);
      if (typeof fr.sha256 !== "string" || !SHA256_RE.test(fr.sha256))
        throw new Error(`provenance manifest: frame ${fr.frameId} has malformed sha256`);
      if (!Number.isFinite(fr.timestamp) || (fr.timestamp as number) < 0)
        throw new Error(`provenance manifest: frame ${fr.frameId} has bad timestamp`);
      frameMap.set(fr.frameId, {
        sourceId: src.sourceMediaId,
        file: fr.file,
        sha256: fr.sha256,
        timestamp: fr.timestamp as number,
        scene: fr.scene as string,
      });
    }
  }

  // Every case must resolve to exactly one manifest frame; episode members
  // must share a scene (an episode spanning scenes is a contradictory mapping).
  const episodeScenes = new Map<string, string>();
  for (const c of cases) {
    const f = frameMap.get(c.frameId);
    if (!f) throw new Error(`provenance manifest: case ${c.caseId} references unknown frameId ${c.frameId}`);
    if (f.scene !== c.scene)
      throw new Error(
        `provenance manifest: case ${c.caseId} scene ${c.scene} contradicts manifest scene ${f.scene} for frame ${c.frameId}`,
      );
    if (c.episodeId) {
      const prev = episodeScenes.get(c.episodeId);
      if (prev !== undefined && prev !== c.scene)
        throw new Error(`provenance manifest: episode ${c.episodeId} spans scenes ${prev} and ${c.scene}`);
      episodeScenes.set(c.episodeId, c.scene);
    }
  }

  return {
    sources: seenSources.size,
    frames: frameMap.size,
    assets: new Set(cases.map((c) => c.assetId)).size,
    episodes: new Set(cases.filter((c) => c.episodeId).map((c) => c.episodeId as string)).size,
    warnings,
  };
}

/** Pure input-checksum comparison. Missing ids and hash mismatches are reported, never ignored. */
export function verifyInputChecksums(
  expected: Record<string, string>,
  actual: Record<string, string>,
): { ok: boolean; mismatches: string[]; missing: string[] } {
  const mismatches: string[] = [];
  const missing: string[] = [];
  for (const [id, hash] of Object.entries(expected)) {
    if (!(id in actual)) missing.push(id);
    else if (actual[id] !== hash) mismatches.push(id);
  }
  mismatches.sort();
  missing.sort();
  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing };
}


// ============ Eval-cache → prediction-artifact adapter (pure mapping) ============

export interface EvalCacheDefect {
  assetCategory?: unknown;
  defect?: unknown;
  title?: unknown;
  evidenceSource?: unknown;
  verification?: { verdict?: unknown } | null;
}

export interface EvalCacheEntry {
  id: string;
  model?: string;
  after?: EvalCacheDefect[] | unknown;
  error?: string;
}

export interface PredictionArtifactEnvelope {
  status: "completed";
  datasetVersion: string;
  model?: string;
  recordedAt?: string;
  provenanceDefault: "actual" | "cached";
  inputs?: Record<string, string>;
  predictions: RealPrediction[];
  notes: string[];
}

/**
 * Map recorded eval outputs (cache entries or a live run's equivalents) onto
 * benchmark frames WITHOUT inventing asset identity. Each reported defect
 * becomes a prediction keyed by its source frameId with assetId null and
 * association unresolved: eval slugs (e.g. "pole-001") are synthetic and must
 * never be presented as stable asset IDs, and single-frame eval provides no
 * boxes. Such predictions land in the report's unmappable bucket until a
 * pipeline that emits stable asset/episode references is recorded instead.
 * Entries with run errors, or frames with zero reported defects, contribute no
 * predictions (a fully empty result is a completed zero-detection run only
 * when the envelope says the run completed).
 */
export function adaptEvalCacheToArtifact(
  entries: EvalCacheEntry[],
  opts: {
    datasetVersion: string;
    model?: string;
    recordedAt?: string;
    provenanceDefault: "actual" | "cached";
    inputs?: Record<string, string>;
  },
): PredictionArtifactEnvelope {
  const predictions: RealPrediction[] = [];
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
    for (const d of e.after) {
      if (!isRecord(d)) continue;
      const category = typeof d.assetCategory === "string" ? d.assetCategory : "";
      const defectClass =
        typeof d.defect === "string" && d.defect.length > 0
          ? d.defect
          : typeof d.title === "string"
            ? d.title
            : "";
      const evidenceSource = d.evidenceSource === "voice" ? "voice" : "visual";
      const verdict =
        d.verification && isRecord(d.verification) && typeof d.verification.verdict === "string"
          ? d.verification.verdict
          : null;
      predictions.push({
        caseId: e.id,
        episodeId: null,
        assetId: null,
        category,
        defectClass,
        frameContainsDefect: evidenceSource === "visual" && category.length > 0 ? true : null,
        bbox: null,
        evidenceSource,
        assetAssociation: "unresolved",
        verification:
          verdict === "keep" || verdict === "downgrade" || verdict === "drop" || verdict === "skipped"
            ? verdict
            : null,
        provenance: opts.provenanceDefault,
      });
    }
  }
  if (skipped > 0) notes.push(`${skipped} entr${skipped === 1 ? "y" : "ies"} skipped (missing id, run error, or malformed defects)`);
  return {
    status: "completed",
    datasetVersion: opts.datasetVersion,
    model: opts.model,
    recordedAt: opts.recordedAt,
    provenanceDefault: opts.provenanceDefault,
    inputs: opts.inputs,
    predictions,
    notes,
  };
}

// ============ Run manifests: auditable execution provenance (pure) ============
//
// A run manifest binds predictions to the execution that produced them. It is
// the ONLY basis on which provenance "actual" is accepted: a caller-supplied
// label is never sufficient. The manifest is caller-assembled (see
// scripts/collect-run-manifest.ts + PREDICTIONS.md), but every check below is
// recomputed from the artifact itself — digests, dataset version, input
// checksums, stage evidence — so missing or contradictory evidence fails
// loudly instead of passing as verified inference.

export type RunStageMode = "inference" | "cache" | "fixture" | "skipped";
export type RunStageStatus = "completed" | "failed" | "skipped" | "cancelled";
export type RunStatus = "completed" | "failed" | "cancelled" | "partial";

export interface RunStage {
  key: string;
  mode: RunStageMode;
  status: RunStageStatus;
  /** True only when a real provider request was made for this stage. */
  providerRequestMade: boolean;
  /** sha256 of the saved raw provider response. Required when mode is inference. */
  responseDigest?: string;
  /** sha256 of the stage's structured output, when recorded. */
  outputDigest?: string;
  error?: string;
  note?: string;
}

export interface RunManifest {
  manifestVersion: "run-manifest-v1";
  runId: string;
  createdAt: string;
  completedAt: string | null;
  status: RunStatus;
  dataset: { id: string; version: string; inputs?: Record<string, string> };
  pipeline: { provider: string; model: string };
  stages: RunStage[];
  /** sha256 of the canonical JSON of the exact prediction array it covers. */
  predictionsDigest: string;
  notes?: string[];
}

const HEX64_RE = /^[0-9a-f]{64}$/;

/** Stable canonical JSON: sorted object keys, compact arrays. Deterministic. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Digest binding a prediction array to its run manifest. */
export function predictionsDigestOf(predictions: unknown): string {
  return sha256Hex(canonicalJson(predictions ?? []));
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{8,}/,
  /Bearer\s+\S+/i,
  /\bxox[baprs]-\S+/i,
  /api[_-]?key\s*[:=]\s*\S+/i,
  /authorization\s*[:=]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Reject manifests (or artifacts) carrying credential-like material. Pure. */
export function assertNoSecrets(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    for (const re of SECRET_PATTERNS) {
      if (re.test(value)) throw new Error(`possible credential material at ${path} (redacted from this error)`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(api[_-]?key|token|secret|authorization)$/i.test(k) && typeof v === "string" && v.length > 0)
        throw new Error(`credential field "${k}" at ${path} must never be persisted (redacted from this error)`);
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

function isIsoUtc(s: unknown): s is string {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

/**
 * Validate a run manifest. Throws on any defect. Optional linkage opts bind
 * the manifest to the artifact under evaluation:
 * - predictionsDigest: must equal manifest.predictionsDigest.
 * - datasetVersion: must equal manifest.dataset.version.
 * - inputsActual: every manifest dataset.inputs entry must match.
 */
export function validateRunManifest(
  manifest: unknown,
  opts: { predictionsDigest?: string; datasetVersion?: string; inputsActual?: Record<string, string> } = {},
): { runId: string; provider: string; model: string; inferenceStages: number; stages: number; status: RunStatus } {
  if (!isRecord(manifest)) throw new Error("run manifest: not an object");
  const m = manifest as Partial<RunManifest> & Record<string, unknown>;
  if (m.manifestVersion !== "run-manifest-v1")
    throw new Error(`run manifest: bad manifestVersion ${JSON.stringify(m.manifestVersion)}`);
  if (typeof m.runId !== "string" || m.runId.length === 0) throw new Error("run manifest: missing runId");
  if (!isIsoUtc(m.createdAt)) throw new Error("run manifest: bad createdAt");
  if (m.completedAt !== null && !isIsoUtc(m.completedAt)) throw new Error("run manifest: bad completedAt");
  if (
    m.completedAt !== null &&
    isIsoUtc(m.createdAt) &&
    Date.parse(m.completedAt as string) < Date.parse(m.createdAt as string)
  )
    throw new Error("run manifest: completedAt precedes createdAt");
  if (m.status !== "completed" && m.status !== "failed" && m.status !== "cancelled" && m.status !== "partial")
    throw new Error(`run manifest: bad status ${JSON.stringify(m.status)}`);
  if (!isRecord(m.dataset) || typeof m.dataset.id !== "string" || typeof m.dataset.version !== "string")
    throw new Error("run manifest: bad dataset linkage");
  if (!isRecord(m.pipeline) || typeof m.pipeline.provider !== "string" || typeof m.pipeline.model !== "string")
    throw new Error("run manifest: bad pipeline identification");
  if (!Array.isArray(m.stages) || m.stages.length === 0) throw new Error("run manifest: no stages");
  let inferenceStages = 0;
  for (let i = 0; i < m.stages.length; i++) {
    const s = m.stages[i] as Partial<RunStage>;
    if (!isRecord(s) || typeof s.key !== "string" || s.key.length === 0)
      throw new Error(`run manifest: stage ${i} missing key`);
    if (s.mode !== "inference" && s.mode !== "cache" && s.mode !== "fixture" && s.mode !== "skipped")
      throw new Error(`run manifest: stage ${s.key} has bad mode ${JSON.stringify(s.mode)}`);
    if (s.status !== "completed" && s.status !== "failed" && s.status !== "skipped" && s.status !== "cancelled")
      throw new Error(`run manifest: stage ${s.key} has bad status ${JSON.stringify(s.status)}`);
    if (typeof s.providerRequestMade !== "boolean")
      throw new Error(`run manifest: stage ${s.key} missing providerRequestMade`);
    if (s.responseDigest !== undefined && (typeof s.responseDigest !== "string" || !HEX64_RE.test(s.responseDigest)))
      throw new Error(`run manifest: stage ${s.key} has malformed responseDigest`);
    if (s.outputDigest !== undefined && (typeof s.outputDigest !== "string" || !HEX64_RE.test(s.outputDigest)))
      throw new Error(`run manifest: stage ${s.key} has malformed outputDigest`);
    if (s.mode === "inference") {
      if (!s.providerRequestMade)
        throw new Error(`run manifest: stage ${s.key} claims inference without a provider request`);
      // Completed inference must carry response evidence. Failed/cancelled
      // stages may lack it (the call never returned) — they fail loudly
      // elsewhere and can never back a completed run.
      if (s.status === "completed" && !s.responseDigest)
        throw new Error(`run manifest: stage ${s.key} claims completed inference without responseDigest evidence`);
      inferenceStages++;
    }
    if (s.mode !== "inference" && s.mode !== "skipped" && s.providerRequestMade && !s.responseDigest) {
      throw new Error(`run manifest: stage ${s.key} asserts a provider request without responseDigest evidence`);
    }
  }
  if (m.status === "completed") {
    if (m.completedAt === null) throw new Error("run manifest: completed run missing completedAt");
    const bad = (m.stages as RunStage[]).filter((s) => s.status === "failed" || s.status === "cancelled");
    if (bad.length > 0)
      throw new Error(`run manifest: status completed but stages failed/cancelled: ${bad.map((s) => s.key).join(", ")}`);
  }
  if (typeof m.predictionsDigest !== "string" || !HEX64_RE.test(m.predictionsDigest))
    throw new Error("run manifest: bad predictionsDigest");
  assertNoSecrets(manifest);
  if (opts.predictionsDigest !== undefined && opts.predictionsDigest !== m.predictionsDigest)
    throw new Error("run manifest: predictionsDigest does not match the artifact's predictions");
  if (opts.datasetVersion !== undefined && opts.datasetVersion !== (m.dataset as { version: string }).version)
    throw new Error(
      `run manifest: dataset version ${(m.dataset as { version: string }).version} does not match benchmark ${opts.datasetVersion}`,
    );
  if (opts.inputsActual !== undefined && isRecord((m.dataset as { inputs?: unknown }).inputs)) {
    const expected = (m.dataset as { inputs: Record<string, string> }).inputs;
    for (const [id, hash] of Object.entries(expected)) {
      if (!(id in opts.inputsActual)) throw new Error(`run manifest: input ${id} missing from benchmark media`);
      if (opts.inputsActual[id] !== hash)
        throw new Error(`run manifest: input ${id} checksum does not match benchmark media`);
    }
  }
  return {
    runId: m.runId as string,
    provider: (m.pipeline as { provider: string }).provider,
    model: (m.pipeline as { model: string }).model,
    inferenceStages,
    stages: (m.stages as unknown[]).length,
    status: m.status as RunStatus,
  };
}

export interface ActualGate {
  required: boolean;
  runId?: string;
  provider?: string;
  model?: string;
  inferenceStages?: number;
  reason: string;
}

/**
 * Enforce the actual-inference gate: predictions labeled "actual" are accepted
 * only with a valid run manifest whose linkage (digest, dataset, inputs) and
 * provider-request evidence all verify. "cached"/"hand-test" entries need no
 * manifest but are never upgraded to actual. Throws on any gap.
 */
export function assertActualProvenance(
  predictions: RealPrediction[],
  run: unknown,
  opts: { predictionsDigest: string; datasetVersion: string; inputsActual: Record<string, string> },
): ActualGate {
  const actual = predictions.filter((p) => !p.skipped && !p.error && p.provenance === "actual");
  if (actual.length === 0) return { required: false, reason: "no actual-provenance predictions; nothing to gate" };
  if (run === null || run === undefined)
    throw new Error(
      `actual inference claimed by ${actual.length} prediction(s) without a run manifest; attach the execution record or relabel provenance`,
    );
  const summary = validateRunManifest(run, opts);
  if (summary.status !== "completed")
    throw new Error(
      `run manifest status is ${JSON.stringify(summary.status)} (expected "completed"); failed, cancelled, or partial runs are never scored as actual inference`,
    );
  if (summary.inferenceStages === 0)
    throw new Error("run manifest records no inference stage with provider-request evidence; cannot sustain actual provenance");
  return {
    required: true,
    runId: summary.runId,
    provider: summary.provider,
    model: summary.model,
    inferenceStages: summary.inferenceStages,
    reason: `${actual.length} actual prediction(s) traced to run ${summary.runId} (${summary.inferenceStages} inference stage(s) with provider-request evidence)`,
  };
}

// ============ Static-image scoring (single image, frame-linked) ============
// The asset path above keys predictions by stable caseId/assetId. The static
// eval path cannot mint those: predictions arrive keyed by input frameId with
// optional boxes, and are matched to GT through the frame the model actually
// saw. Association is therefore explicitly unavailable here (never inferred
// from category strings), while detection + localization score where the
// annotations support them. Same states, same exit semantics as the asset path.

export interface StaticPrediction {
  frameId: string;
  category: string;
  defectClass: string;
  /** Normalized box in ORIGINAL submitted-image coordinates, or null. */
  bbox: BoundingBox | null;
  evidenceSource: "visual" | "voice";
  verification: "keep" | "downgrade" | "drop" | "skipped" | null;
  provenance: "actual" | "cached" | "hand-test";
  error?: boolean;
  skipped?: boolean;
}

export interface StaticArtifactValidation {
  state: "missing" | "completed" | "invalid";
  predictions: StaticPrediction[];
  run?: unknown;
  reason: string;
}

function validateStaticEntry(p: unknown, index: number): StaticPrediction {
  if (!isRecord(p)) throw new Error(`prediction artifact: entry ${index} is not an object`);
  const { frameId, category, defectClass, evidenceSource, verification, provenance } = p as Record<string, unknown>;
  if (typeof frameId !== "string" || frameId.length === 0)
    throw new Error(`prediction artifact: entry ${index} missing frameId`);
  if (typeof category !== "string" || typeof defectClass !== "string")
    throw new Error(`prediction artifact: entry ${index} missing category/defectClass`);
  if (evidenceSource !== "visual" && evidenceSource !== "voice")
    throw new Error(`prediction artifact: entry ${index} has bad evidenceSource`);
  if (verification !== null && verification !== undefined && !["keep", "downgrade", "drop", "skipped"].includes(verification as string))
    throw new Error(`prediction artifact: entry ${index} has bad verification`);
  if (!PREDICTION_PROVENANCES.includes(provenance as (typeof PREDICTION_PROVENANCES)[number]))
    throw new Error(
      `prediction artifact: entry ${index} has unknown provenance ${JSON.stringify(provenance)} (expected one of actual|cached|hand-test)`,
    );
  const entry = p as unknown as StaticPrediction;
  if (entry.bbox !== null && entry.bbox !== undefined && !isRecord(entry.bbox))
    throw new Error(`prediction artifact: entry ${index} has malformed bbox (must be null or {x,y,w,h})`);
  // Deep box validity is the scorer's job (invalid boxes fail localization,
  // never fail validation): a structurally present box is enough here.
  return entry;
}

/**
 * Validate a static-image prediction artifact. Same missing/completed/invalid
 * contract as validatePredictionArtifact, keyed by frameId instead of caseId.
 */
export function validateStaticArtifact(raw: unknown): StaticArtifactValidation {
  if (raw === null || raw === undefined)
    return {
      state: "missing",
      predictions: [],
      reason: "no prediction artifact: run never performed or artifact not mapped to this benchmark",
    };
  let list: unknown = raw;
  let run: unknown;
  if (isRecord(raw) && "predictions" in raw) {
    const status = (raw as { status?: unknown }).status;
    if (status !== "completed")
      return {
        state: "invalid",
        predictions: [],
        reason: `prediction artifact status is ${JSON.stringify(status)} (expected "completed"); a failed or pending run is not a scored result`,
      };
    list = (raw as { predictions: unknown }).predictions;
    run = (raw as { run?: unknown }).run;
  }
  if (!Array.isArray(list))
    return {
      state: "invalid",
      predictions: [],
      reason: "prediction artifact is neither a prediction array nor a {status, predictions} envelope",
    };
  try {
    const validated = list.map((p, i) => validateStaticEntry(p, i));
    if (validated.length === 0)
      return {
        state: "completed",
        predictions: [],
        run,
        reason: "explicit completed run that produced zero detections (empty prediction set)",
      };
    return {
      state: "completed",
      predictions: validated,
      run,
      reason: `completed run with ${validated.length} prediction(s)`,
    };
  } catch (err) {
    return {
      state: "invalid",
      predictions: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Require live execution evidence for every scored frame. The run manifest
 * must contain a completed inference stage keyed `frame:<id>` with
 * providerRequestMade and a responseDigest for each frameId with active
 * predictions. Throws on any gap: a cached/fixture frame must never back an
 * "actual" score.
 */
export function verifyFrameCoverage(manifest: unknown, frameIds: string[]): { covered: string[] } {
  if (!isRecord(manifest) || !Array.isArray((manifest as { stages?: unknown }).stages)) {
    throw new Error("no run manifest with per-frame execution stages; actual provenance requires frame-level evidence");
  }
  const stages = (manifest as { stages: unknown[] }).stages;
  const live = new Set(
    stages
      .filter((s) => {
        if (!isRecord(s)) return false;
        const r = s as Record<string, unknown>;
        return (
          typeof r.key === "string" &&
          r.mode === "inference" &&
          r.status === "completed" &&
          r.providerRequestMade === true &&
          typeof r.responseDigest === "string" &&
          HEX64_RE.test(r.responseDigest)
        );
      })
      .map((s) => (s as { key: string }).key),
  );
  const missing = Array.from(new Set(frameIds)).filter((id) => !live.has(`frame:${id}`)).sort();
  if (missing.length > 0) {
    throw new Error(
      `no completed live inference stage with provider-request evidence for frame(s): ${missing.join(", ")} (cached, fixture, or failed frames cannot back actual provenance)`,
    );
  }
  return { covered: Array.from(new Set(frameIds)).sort() };
}

export function scoreStaticBenchmark(
  groundTruth: RealGroundTruth[],
  predictions: StaticPrediction[] | null | undefined,
  opts: { datasetVersion?: string; executedFrames?: string[] } = {},
): AssetBenchReport {
  const gt = [...groundTruth].sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  const excluded = (c: RealGroundTruth) => (c.excludedFrom ?? []).includes("detection");
  const excludedCount = gt.length - gt.filter((c) => !excluded(c)).length;

  // ---- State A: no prediction artifact. Score NOTHING. ----
  if (predictions === null || predictions === undefined) {
    return notEvaluatedReport(gt, {
      datasetVersion: opts.datasetVersion ?? "real-v1",
      datasetType: "static-image",
      excludedCount,
    });
  }

  // ---- Coverage: which frames were actually evaluated? ----
  // A frame counts as evaluated when the run manifest records a completed
  // stage for it, OR when an explicit prediction record names it (a mapped
  // output is itself evidence the frame was seen). A frame with neither —
  // e.g. a clean frame in a partial run — was never evaluated: it must read
  // not_evaluated, never clean-PASS and never FN. Without execution evidence
  // (no manifest: unit fixtures, manifest-less cached artifacts) every frame
  // is treated as evaluated, preserving the historical contract.
  const expectedFrames = Array.from(new Set(gt.map((c) => c.frameId))).sort();
  const executed = opts.executedFrames !== undefined ? new Set(opts.executedFrames) : null;
  const activePredsEarly = [...predictions].filter((p) => !p.skipped && !p.error);
  const predictedFrames = new Set(activePredsEarly.map((p) => p.frameId));
  const isEvaluated = (frameId: string): boolean =>
    executed === null || executed.has(frameId) || predictedFrames.has(frameId);
  const unevaluatedFrames = expectedFrames.filter((f) => !isEvaluated(f));
  const coverageComplete = unevaluatedFrames.length === 0;
  const notEvaluatedRow = (c: RealGroundTruth): BenchReport["cases"][number] => ({
    caseId: c.caseId,
    scene: c.scene,
    passed: false,
    skipped: true,
    errored: false,
    expected: c.clean ? "clean (no defect)" : `${c.assetCategory}:${c.defectClass} episode=${c.episodeId ?? "n/a"}`,
    predicted: `not evaluated — frame ${c.frameId} not executed in this run`,
    mismatches: [],
  });

  const preds = [...predictions];
  const scored = gt.filter((c) => !excluded(c));
  const framesOf = new Map<string, RealGroundTruth[]>();
  for (const c of scored) {
    const l = framesOf.get(c.frameId) ?? [];
    l.push(c);
    framesOf.set(c.frameId, l);
  }

  // Episode grouping: one GT episode = one detection instance.
  const episodes = new Map<string, RealGroundTruth[]>();
  for (const c of scored) {
    if (!c.clean && c.episodeId) {
      const l = episodes.get(c.episodeId) ?? [];
      l.push(c);
      episodes.set(c.episodeId, l);
    }
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let fpOnClean = 0;
  const perClass = new Map<string, { tp: number; fp: number; fn: number }>();
  const perScene = new Map<string, { tp: number; fp: number; fn: number; cases: number }>();
  const bumpC = (k: string, f: "tp" | "fp" | "fn") => {
    const e = perClass.get(k) ?? { tp: 0, fp: 0, fn: 0 };
    e[f]++;
    perClass.set(k, e);
  };
  const bumpS = (s: string, f: "tp" | "fp" | "fn") => {
    const e = perScene.get(s) ?? { tp: 0, fp: 0, fn: 0, cases: 0 };
    e[f]++;
    perScene.set(s, e);
  };
  for (const c of scored) {
    const e = perScene.get(c.scene) ?? { tp: 0, fp: 0, fn: 0, cases: 0 };
    e.cases++;
    perScene.set(c.scene, e);
  }

  const perEpisode: AssetBenchReport["perEpisode"] = [];
  // Predictions for unknown frames cannot be mapped: reported, never scored.
  const knownFrames = new Set(gt.map((c) => c.frameId));
  const unmappable = preds.filter((p) => !p.skipped && !p.error && !knownFrames.has(p.frameId));
  const unmappedNote =
    unmappable.length > 0
      ? `no mapped prediction (${unmappable.length} unmappable prediction(s) reference unknown frames — see unmappablePredictions)`
      : null;
  let kept = 0;
  let downgraded = 0;
  let dropped = 0;
  let skippedV = 0;
  let errors = 0;
  let skipped = 0;
  let errored = 0;
  const caseRows: BenchReport["cases"] = [];

  const tallyV = (p: StaticPrediction) => {
    if (p.verification === "keep") kept++;
    else if (p.verification === "downgrade") downgraded++;
    else if (p.verification === "drop") dropped++;
    else if (p.verification === "skipped") skippedV++;
    if (p.error) errors++;
  };

  const consumedPred = new Set<StaticPrediction>();
  // Detection matches on frame + category + visual evidence ONLY. Bounding
  // boxes never gate detection: the model is asked for the visibly damaged
  // region while GT annotates the whole asset strip, so IoU between those two
  // target types cannot decide whether the defect was found. Box handling
  // lives in the asset-overlap diagnostic below, never in this gate.
  for (const [ep, members] of Array.from(episodes.entries()).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const rep = members[0];
    const scene = rep.scene;
    const memberFrames = new Set(members.map((m) => m.frameId));
    const candidates = preds.filter((p) => !p.skipped && !p.error && memberFrames.has(p.frameId));
    let hit: StaticPrediction | null = null;
    let missReason: string | null = null;
    for (const p of candidates) {
      const catOk = labelsMatch(p.category, rep.assetCategory) && (labelsMatch(p.defectClass, rep.defectClass) || norm(p.defectClass) === "");
      const frameOk = p.evidenceSource === "visual";
      if (!catOk || !frameOk) {
        missReason = !catOk
          ? `category mismatch on ${p.frameId} (got ${p.category}:${p.defectClass}, want ${rep.assetCategory}:${rep.defectClass}; box overlap never substitutes)`
          : `non-visual evidence on ${p.frameId} (a matching box alone never counts)`;
        continue;
      }
      hit = p;
      break;
    }
    if (hit) {
      tp++;
      bumpC(norm(rep.assetCategory), "tp");
      bumpS(scene, "tp");
      consumedPred.add(hit);
      perEpisode.push({ episodeId: ep, scene, cases: members.map((m) => m.caseId), status: "tp" });
      tallyV(hit);
      // Further matching observations of the same episode: consumed as
      // observed (verification tallied) but never a second TP — so a repeat
      // sighting of the defect can never become a false positive merely
      // because a different, clean asset shares the frame.
      for (const p of candidates) {
        if (p === hit || consumedPred.has(p)) continue;
        const extraOk =
          labelsMatch(p.category, rep.assetCategory) &&
          (labelsMatch(p.defectClass, rep.defectClass) || norm(p.defectClass) === "") &&
          p.evidenceSource === "visual";
        if (extraOk) {
          consumedPred.add(p);
          tallyV(p);
        }
      }
      for (const m of members) {
        if (!isEvaluated(m.frameId)) {
          caseRows.push(notEvaluatedRow(m));
          continue;
        }
        caseRows.push({ caseId: m.caseId, scene: m.scene, passed: true, skipped: false, errored: false, expected: `${rep.assetCategory}:${rep.defectClass} episode=${ep}`, predicted: `${hit.category}:${hit.defectClass} @${hit.frameId}${hit.bbox ? " with box" : ""}`, mismatches: [] });
      }
    } else if (members.some((m) => isEvaluated(m.frameId))) {
      fn++;
      bumpC(norm(rep.assetCategory), "fn");
      bumpS(scene, "fn");
      const hasPred = candidates.length > 0;
      perEpisode.push({ episodeId: ep, scene, cases: members.map((m) => m.caseId), status: hasPred ? "fp" : "unpredicted" });
      if (hasPred) {
        fp++;
        for (const p of candidates) {
          if (!consumedPred.has(p)) {
            bumpC(norm(p.category) || "unknown", "fp");
            consumedPred.add(p);
            tallyV(p);
          }
        }
      }
      for (const m of members) {
        if (!isEvaluated(m.frameId)) {
          caseRows.push(notEvaluatedRow(m));
          continue;
        }
        caseRows.push({ caseId: m.caseId, scene: m.scene, passed: false, skipped: false, errored: false, expected: `${rep.assetCategory}:${rep.defectClass} episode=${ep}`, predicted: candidates.length ? "prediction present but category/frame gates failed" : (unmappedNote ?? "no prediction (unavailable)"), mismatches: candidates.length ? [missReason ?? "no candidate satisfied category + frame-visibility gates (boxes never gate detection)"] : [unmappedNote ?? "missing prediction for defective episode"] });
      }
    } else {
      // No member frame was ever executed: not a miss, not a failure.
      // Never FN, never FP — the episode is simply unevaluated.
      perEpisode.push({ episodeId: ep, scene, cases: members.map((m) => m.caseId), status: "not_evaluated" });
      for (const m of members) caseRows.push(notEvaluatedRow(m));
    }
  }

  // Clean scored cases: any active prediction on the same frame = FP.
  // Frames never executed are not_evaluated — never clean-PASS.
  for (const c of scored) {
    if (!c.clean) continue;
    if (!isEvaluated(c.frameId)) {
      caseRows.push(notEvaluatedRow(c));
      continue;
    }
    const list = preds.filter((p) => !p.skipped && !p.error && p.frameId === c.frameId);
    for (const p of list) {
      if (consumedPred.has(p)) continue;
      fp++;
      fpOnClean++;
      bumpC(norm(p.category) || "unknown", "fp");
      bumpS(c.scene, "fp");
      tallyV(p);
    }
    const skippedHere = preds.some((p) => p.frameId === c.frameId && p.skipped && !p.error);
    const errorHere = preds.some((p) => p.frameId === c.frameId && p.error);
    if (skippedHere) skipped++;
    if (errorHere) errored++;
    // Attribution matters: predictions consumed as episode observations belong
    // to the defective case. Only unattributed predictions fail the clean case.
    const unattributed = list.filter((p) => !consumedPred.has(p));
    caseRows.push({
      caseId: c.caseId,
      scene: c.scene,
      passed: unattributed.length === 0,
      skipped: skippedHere,
      errored: errorHere,
      expected: "clean (no defect)",
      predicted:
        unattributed.length > 0
          ? unattributed.map((p) => `${p.category}:${p.defectClass}`).join(" | ")
          : list.length > 0
            ? "prediction(s) attributed to the co-located defective case (not scored here)"
            : "no prediction",
      mismatches: unattributed.length ? [`expected clean, got ${unattributed.length} prediction(s)`] : [],
    });
  }

  // Asset-strip overlap diagnostic (NOT defect-localization accuracy): the model
  // reports the visibly damaged region while GT annotates the whole asset
  // strip. IoU across those target types is reported here frame-matched for
  // engineering signal only — it never gates detection and is never presented
  // as localization accuracy. Invalid or missing model boxes are counted as
  // such: never repaired, never substituted, never scored as overlapping.
  const frameBoxOf = new Map<string, BoundingBox>();
  for (const c of scored) {
    if (!c.clean && c.bbox && c.bboxReliable && isValidNormBox(c.bbox) && !frameBoxOf.has(c.frameId)) {
      frameBoxOf.set(c.frameId, c.bbox);
    }
  }
  let overlapEval = 0;
  let overlapHit = 0;
  let overlapInvalid = 0;
  let overlapMissing = 0;
  for (const p of preds) {
    if (p.skipped || p.error || p.evidenceSource !== "visual") continue;
    if (!frameBoxOf.has(p.frameId)) continue;
    if (p.bbox === null || p.bbox === undefined) {
      overlapMissing++;
      continue;
    }
    if (!isValidNormBox(p.bbox)) {
      overlapInvalid++;
      continue;
    }
    overlapEval++;
    if (iou(p.bbox, frameBoxOf.get(p.frameId) as BoundingBox) >= BENCH_IOU_THRESHOLD) overlapHit++;
  }

  // Excluded cases: reported, never scored.
  for (const c of gt) {
    if (!excluded(c)) continue;
    caseRows.push({ caseId: c.caseId, scene: c.scene, passed: true, skipped: true, errored: false, expected: `excluded from detection (${c.observability})`, predicted: "not scored", mismatches: [] });
    skipped++;
  }
  caseRows.sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));

  const activePreds = preds.filter((p) => !p.skipped && !p.error);
  const perClassOut: Record<string, PRF> = {};
  Array.from(perClass.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .forEach(([k, v]) => {
      perClassOut[k] = prf(v.tp, v.fp, v.fn);
    });
  const perSceneOut: Record<string, PRF & { cases: number }> = {};
  Array.from(perScene.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .forEach(([k, v]) => {
      perSceneOut[k] = { ...prf(v.tp, v.fp, v.fn), cases: v.cases };
    });

  const assets = new Set(gt.map((c) => c.assetId)).size;
  const failedCases = caseRows.filter((c) => !c.passed && !c.skipped);
  // Partial runs never report a whole-benchmark verdict: without full frame
  // coverage the report is explicitly not-evaluated (exit 2), with the valid
  // evaluated-frame metrics retained below and labeled partial.
  const status: BenchStatus = !coverageComplete
    ? "not-evaluated"
    : failedCases.length === 0 ? "scored-pass" : "scored-fail";
  return {
    mode: "asset-benchmark",
    realInference: false,
    datasetVersion: opts.datasetVersion ?? "real-v1",
    datasetType: "static-image",
    iouThreshold: BENCH_IOU_THRESHOLD,
    status,
    evaluationState: activePreds.length === 0 ? "completed-zero-detections" : "completed-with-predictions",
    predictionsAvailable: true,
    predictionProvenance:
      activePreds.length === 0
        ? "explicit completed run that produced zero detections (empty prediction set)"
        : `completed run with ${activePreds.length} prediction(s); observed provenance: ${Array.from(new Set(activePreds.map((p) => p.provenance).filter(Boolean))).sort().join(", ") || "unspecified"}`,
    counts: {
      cases: gt.length,
      scenes: new Set(gt.map((c) => c.scene)).size,
      assets,
      episodes: episodes.size,
      cleanCases: gt.filter((c) => c.clean).length,
      uncertainCases: gt.filter((c) => c.observability === "uncertain").length,
      excludedFromDetection: excludedCount,
      predictions: activePreds.length,
      skipped,
      errored,
    },
    detection: {
      ...prf(tp, fp, fn),
      falsePositivesOnClean: fpOnClean,
      unit: coverageComplete
        ? "defect episode (asset occurrence); adjacent frames of one episode count once"
        : "PARTIAL RUN — defect episodes over evaluated frames only; unexecuted frames excluded, full-benchmark verdict withheld",
      unavailable: false,
      ...(coverageComplete ? {} : {
        partial: true,
        reason: `partial run: ${expectedFrames.length - unevaluatedFrames.length} of ${expectedFrames.length} frames evaluated; metrics cover evaluated frames only`,
      }),
    },
    perClass: perClassOut,
    perScene: perSceneOut,
    perEpisode,
    association: { evaluated: 0, correct: 0, accuracy: null, unresolved: 0, unresolvedRate: null, unavailable: true, reason: "static-image path emits no stable asset identity; association is never inferred from category strings" },
    evidenceFrame: { evaluated: 0, correct: 0, accuracy: null, unavailable: true, reason: "static-image path is frame-bound by construction; frame-defect match is folded into detection, not scored separately" },
    localization: { evaluated: 0, correct: 0, accuracy: null, unavailable: true, reason: "ground-truth boxes annotate the whole foreground asset strip while the model is asked for the visibly damaged region; IoU across different target types cannot verify defect-localization accuracy" },
    assetOverlap: {
      evaluated: overlapEval,
      overlapping: overlapHit,
      invalid: overlapInvalid,
      missing: overlapMissing,
      note: "asset-strip overlap diagnostic: IoU of model damage-region boxes against whole-asset GT strips, frame-matched per prediction; engineering signal only, NOT defect-localization accuracy",
    },
    voiceMatching: { evaluated: 0, correct: 0, accuracy: null, unavailable: true, reason: "static-image benchmark: no voice notes; tracking and note-interval alignment are not applicable" },
    verification: { kept, downgraded, dropped, skipped: skippedV, errors, unavailable: false },
    coverage: { assetsPresent: assets, assetsTracked: null, assetsRepresented: null, note: "Static images: assets present are annotated; tracked/represented are NOT APPLICABLE (no video tracking ran). Being present is not inspection." },
    evaluationCoverage: {
      evaluatedFrames: expectedFrames.length - unevaluatedFrames.length,
      expectedFrames: expectedFrames.length,
      complete: coverageComplete,
      unevaluatedFrames,
      note: coverageComplete
        ? "full frame coverage: every benchmark frame carries execution evidence"
        : "PARTIAL RUN: unexecuted frames are not_evaluated (never clean-PASS, never FN); detection metrics cover evaluated frames only and no whole-benchmark verdict is reported",
    },
    unmappablePredictions: {
      count: unmappable.length,
      caseIds: Array.from(new Set(unmappable.map((p) => p.frameId))).sort(),
      note: "predictions referencing unknown frames; excluded from all metrics, listed here so nothing is silently dropped",
    },
    cases: caseRows,
    limitations: [
      "Single-image defect detection only: no SAM tracking, no temporal selection, no voice-note alignment, and no complete GridSight inspection workflow are measured here.",
      "Primary detection unit is the defect episode; adjacent frames of one episode count once. Frame-level views are listed per episode, never as independent detections.",
      "Boxes are validated server-side against the submitted image; invalid or missing boxes are counted as such in the asset-overlap diagnostic and never gate detection, which matches on frame, category, and visual evidence only.",
      "Association is never inferred: predictions carry no stable asset IDs, so asset-association accuracy is unavailable by design.",
      "Uncertain annotations are excluded from detection and reported separately, never counted as success.",
      "Hand-authored test predictions (provenance hand-test) validate the scorer only and are never evidence of model performance.",
    ],
  };
}
