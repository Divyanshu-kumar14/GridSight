import { describe, expect, it } from "vitest";
import {
  BENCH_IOU_THRESHOLD,
  iou,
  scoreBenchmark,
  toBenchJson,
  type BenchCaseInput,
} from "../bench-metrics";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

const gt = (over: Partial<BenchCaseInput["groundTruth"]> & { caseId: string }) => ({
  scene: "s1",
  description: "t",
  clean: false,
  category: "pole",
  defect: "rust",
  assetId: "pole-001",
  evidenceFrame: 1,
  bbox: box(0.1, 0.1, 0.2, 0.2),
  ...over,
});

const pred = (over: Partial<BenchCaseInput["predictions"][number]> & { caseId: string }) => ({
  category: "pole",
  defect: "rust",
  assetId: "pole-001",
  evidenceFrame: 1,
  bbox: box(0.1, 0.1, 0.2, 0.2),
  evidenceSource: "visual" as const,
  assetAssociation: "confirmed" as const,
  verification: "keep" as const,
  ...over,
});

describe("iou", () => {
  it("scores identical boxes as 1 and disjoint as 0", () => {
    expect(iou(box(0, 0, 0.5, 0.5), box(0, 0, 0.5, 0.5))).toBeCloseTo(1);
    expect(iou(box(0, 0, 0.1, 0.1), box(0.9, 0.9, 0.1, 0.1))).toBe(0);
  });

  it("computes a half-overlap toy example correctly", () => {
    // Two 0.2x0.2 boxes offset by 0.1 in x: inter=0.02, union=0.06 → 1/3.
    expect(iou(box(0, 0, 0.2, 0.2), box(0.1, 0, 0.2, 0.2))).toBeCloseTo(1 / 3, 5);
  });

  it("returns 0 for invalid boxes and documents the 0.5 threshold", () => {
    expect(BENCH_IOU_THRESHOLD).toBe(0.5);
    expect(iou(null, box(0, 0, 0.1, 0.1))).toBe(0);
    expect(iou(box(0, 0, 0, 0), box(0, 0, 0.1, 0.1))).toBe(0);
  });
});

describe("detection PRF", () => {
  it("scores empty predictions and empty ground truth as null, never fake zero", () => {
    const r = scoreBenchmark([]);
    expect(r.detection.precision).toBeNull();
    expect(r.detection.recall).toBeNull();
    expect(r.detection.f1).toBeNull();
    expect(r.counts.cases).toBe(0);
  });

  it("matches a hand-calculated example: 1 TP, 1 FP, 1 FN", () => {
    const inputs: BenchCaseInput[] = [
      { groundTruth: gt({ caseId: "c1" }), predictions: [pred({ caseId: "c1" })] },
      {
        groundTruth: gt({ caseId: "c2", clean: true, defect: "", assetId: null, evidenceFrame: null, bbox: null }),
        predictions: [pred({ caseId: "c2", assetId: "pole-001" })],
      },
      { groundTruth: gt({ caseId: "c3" }), predictions: [] },
    ];
    const r = scoreBenchmark(inputs);
    expect(r.detection.truePositives).toBe(1);
    expect(r.detection.falsePositives).toBe(1);
    expect(r.detection.falseNegatives).toBe(1);
    expect(r.detection.precision).toBeCloseTo(0.5);
    expect(r.detection.recall).toBeCloseTo(0.5);
    expect(r.detection.f1).toBeCloseTo(0.5);
    expect(r.detection.falsePositivesOnClean).toBe(1);
  });
});

describe("duplicates and repeated frames", () => {
  it("counts a duplicate prediction for the same case as FP (dedupe documented)", () => {
    const inputs: BenchCaseInput[] = [
      {
        groundTruth: gt({ caseId: "dup" }),
        predictions: [pred({ caseId: "dup" }), pred({ caseId: "dup" })],
      },
    ];
    const r = scoreBenchmark(inputs);
    expect(r.detection.truePositives).toBe(1);
    expect(r.detection.falsePositives).toBe(1);
    expect(r.cases[0].passed).toBe(false);
  });
});

describe("missing labels, skipped, errors", () => {
  it("skipped cases pass without predictions and do not inflate scores", () => {
    const inputs: BenchCaseInput[] = [
      {
        groundTruth: gt({ caseId: "sk" }),
        predictions: [{ caseId: "sk", category: "", defect: "", assetId: null, evidenceFrame: null, bbox: null, evidenceSource: "voice", assetAssociation: null, verification: null, skipped: true }],
      },
    ];
    const r = scoreBenchmark(inputs);
    expect(r.counts.skipped).toBe(1);
    expect(r.detection.truePositives).toBe(0);
    expect(r.cases[0].skipped).toBe(true);
  });

  it("errored predictions are visible and fail the case", () => {
    const inputs: BenchCaseInput[] = [
      {
        groundTruth: gt({ caseId: "er" }),
        predictions: [{ caseId: "er", category: "", defect: "", assetId: null, evidenceFrame: null, bbox: null, evidenceSource: "voice", assetAssociation: null, verification: null, error: true }],
      },
    ];
    const r = scoreBenchmark(inputs);
    expect(r.counts.errored).toBe(1);
    expect(r.verification.errors).toBe(1);
    expect(r.cases[0].errored).toBe(true);
  });
});

describe("association and evidence correctness", () => {
  it("marks unresolved associations explicitly and scores accuracy only where GT links exist", () => {
    const inputs: BenchCaseInput[] = [
      {
        groundTruth: gt({ caseId: "u1", assetId: null, evidenceFrame: null, bbox: null, voiceAssetId: null }),
        predictions: [pred({ caseId: "u1", assetId: null, evidenceFrame: null, bbox: null, evidenceSource: "voice", assetAssociation: "unresolved", verification: null })],
      },
    ];
    const r = scoreBenchmark(inputs);
    expect(r.association.evaluated).toBe(0);
    expect(r.association.accuracy).toBeNull();
    expect(r.association.reason).toMatch(/no cases with a reliable GT asset link/);
  });

  it("fails label-match when the frame is wrong", () => {
    const inputs: BenchCaseInput[] = [
      {
        groundTruth: gt({ caseId: "wf" }),
        predictions: [pred({ caseId: "wf", evidenceFrame: 0, bbox: box(0, 0, 0.1, 0.1) })],
      },
    ];
    const r = scoreBenchmark(inputs);
    expect(r.detection.truePositives).toBe(0);
    expect(r.detection.falsePositives).toBe(1);
    expect(r.evidenceFrame.accuracy).toBe(0);
  });

  it("fails label-match when IoU is below threshold", () => {
    const inputs: BenchCaseInput[] = [
      {
        groundTruth: gt({ caseId: "wb" }),
        predictions: [pred({ caseId: "wb", bbox: box(0.8, 0.8, 0.1, 0.1) })],
      },
    ];
    const r = scoreBenchmark(inputs);
    expect(r.detection.truePositives).toBe(0);
    expect(r.cases[0].mismatches.join(" ")).toMatch(/duplicate|label|frame/i);
  });
});

describe("mode separation and determinism", () => {
  it("never claims live inference in the ground-truth benchmark", () => {
    const r = scoreBenchmark([{ groundTruth: gt({ caseId: "m" }), predictions: [pred({ caseId: "m" })] }]);
    expect(r.mode).toBe("ground-truth-benchmark");
    expect(r.realInference).toBe(false);
  });

  it("produces deterministic JSON with stable case ordering", () => {
    const a: BenchCaseInput[] = [
      { groundTruth: gt({ caseId: "b" }), predictions: [] },
      { groundTruth: gt({ caseId: "a" }), predictions: [] },
    ];
    const r1 = toBenchJson(scoreBenchmark(a));
    const r2 = toBenchJson(scoreBenchmark([...a].reverse()));
    expect(r1).toBe(r2);
    expect(JSON.parse(r1).cases.map((c: { caseId: string }) => c.caseId)).toEqual(["a", "b"]);
  });
});
