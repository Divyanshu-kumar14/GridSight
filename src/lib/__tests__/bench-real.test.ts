import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  iou,
  scoreAssetBenchmark,
  toAssetBenchJson,
  validateRealDataset,
  type RealGroundTruth,
  type RealPrediction,
} from "../bench-metrics";

const gt = (over: Partial<RealGroundTruth> & { caseId: string }): RealGroundTruth => ({
  scene: "s",
  sourceMediaId: "m",
  frameId: "f",
  timestamp: 0,
  assetId: "a-1",
  assetCategory: "pole",
  clean: false,
  defectClass: "rust",
  visualDescription: "d",
  bbox: null,
  bboxReliable: false,
  observability: "observable",
  episodeId: "EP-1",
  excludedFrom: [],
  annotationNotes: "",
  ...over,
});

const pred = (over: Partial<RealPrediction> & { caseId: string }): RealPrediction => ({
  episodeId: "EP-1",
  assetId: "a-1",
  category: "pole",
  defectClass: "rust",
  frameContainsDefect: true,
  bbox: null,
  evidenceSource: "visual",
  assetAssociation: "confirmed",
  verification: "keep",
  provenance: "hand-test",
  ...over,
});

describe("real dataset validation", () => {
  it("accepts the shipped real-v1 file with 12 cases, 3 scenes, 7 assets, 1 episode", () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "fixtures/benchmark/real-v1/cases.json"), "utf8"));
    const stats = validateRealDataset(raw.cases);
    expect(raw.cases).toHaveLength(12);
    expect(stats.scenes).toBe(3);
    expect(stats.assets).toBe(6);
    expect(stats.episodes).toBe(1);
    const ids = new Set(raw.cases.map((c: { caseId: string }) => c.caseId));
    expect(ids.size).toBe(12);
  });

  it("fails clearly on duplicate IDs, invalid boxes, and bad frame refs", () => {
    const base = [gt({ caseId: "a" }), gt({ caseId: "b", episodeId: "EP-2" })];
    expect(() => validateRealDataset([base[0], base[0]])).toThrow(/duplicate caseId/);
    expect(() => validateRealDataset([{ ...base[0], bbox: { x: 5, y: 5, w: -1, h: 0 } }])).toThrow(/invalid bbox/);
    expect(() => validateRealDataset([{ ...base[0], timestamp: -1 }])).toThrow(/timestamp/);
    expect(() => validateRealDataset([])).toThrow(/no cases/);
  });

  it("rejects clean cases carrying an episode and defective observables missing one", () => {
    expect(() => validateRealDataset([gt({ caseId: "c", clean: true, episodeId: "EP-X" })])).toThrow(/episodeId/);
    expect(() => validateRealDataset([gt({ caseId: "d", episodeId: null })])).toThrow(/episodeId/);
  });
});

describe("asset-level dedupe", () => {
  it("counts five adjacent frames of one episode as ONE tp, not five", () => {
    const members = ["f1", "f2", "f3", "f4", "f5"].map((f, i) =>
      gt({ caseId: `c${i}`, frameId: f, episodeId: "EP-RUST", bbox: { x: 0.1, y: 0, w: 0.2, h: 1 }, bboxReliable: true }),
    );
    const r = scoreAssetBenchmark(members, [pred({ caseId: "c1", bbox: { x: 0.1, y: 0, w: 0.2, h: 1 } })]);
    expect(r.detection.truePositives).toBe(1);
    expect(r.detection.falsePositives).toBe(0);
    expect(r.counts.episodes).toBe(1);
    expect(r.perEpisode).toHaveLength(1);
    expect(r.perEpisode[0].status).toBe("tp");
  });

  it("reports clean true negatives for a completed zero-detection run", () => {
    const r = scoreAssetBenchmark([gt({ caseId: "c", clean: true, assetId: "t-1", episodeId: null, observability: "not-observable" })], []);
    expect(r.status).toBe("scored-pass");
    expect(r.evaluationState).toBe("completed-zero-detections");
    expect(r.predictionsAvailable).toBe(true);
    expect(r.detection.falsePositives).toBe(0);
    expect(r.detection.falsePositivesOnClean).toBe(0);
    expect(r.cases[0].passed).toBe(true);
  });

  it("excludes uncertain annotations from detection and reports them separately", () => {
    const r = scoreAssetBenchmark(
      [gt({ caseId: "u", clean: true, assetId: "t-9", observability: "uncertain", excludedFrom: ["detection"] })],
      [],
    );
    expect(r.counts.excludedFromDetection).toBe(1);
    expect(r.counts.uncertainCases).toBe(1);
    expect(r.cases[0].skipped).toBe(true);
  });
});

describe("association, frame, box, missing predictions", () => {
  it("fails wrong-asset predictions (exact ID is part of the TP gate)", () => {
    const r = scoreAssetBenchmark(
      [gt({ caseId: "a", assetId: "pole-RIGHT", bbox: { x: 0.1, y: 0, w: 0.2, h: 1 }, bboxReliable: true })],
      [pred({ caseId: "a", assetId: "pole-WRONG", bbox: { x: 0.1, y: 0, w: 0.2, h: 1 } })],
    );
    expect(r.detection.truePositives).toBe(0);
    expect(r.detection.falsePositives).toBe(1);
    expect(r.cases[0].passed).toBe(false);
    expect(r.cases[0].mismatches.join(" ")).toMatch(/association/);
  });

  it("fails label-match when the frame does not contain the defect or IoU is low", () => {
    const base = gt({ caseId: "w", bbox: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, bboxReliable: true });
    const badFrame = scoreAssetBenchmark([base], [pred({ caseId: "w", frameContainsDefect: false, bbox: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 } })]);
    expect(badFrame.detection.truePositives).toBe(0);
    expect(badFrame.cases[0].passed).toBe(false);
    const badBox = scoreAssetBenchmark([base], [pred({ caseId: "w", bbox: { x: 0.8, y: 0.8, w: 0.05, h: 0.05 } })]);
    expect(badBox.detection.truePositives).toBe(0);
    // No hit means localization has nothing correctly detected to score: null with reason, never a fake 0.
    expect(badBox.localization.accuracy).toBeNull();
    expect(badBox.localization.reason).toMatch(/no reliable GT boxes|no scored episodes/i);
    expect(badBox.cases[0].passed).toBe(false);
    expect(iou({ x: 0.8, y: 0.8, w: 0.05, h: 0.05 }, { x: 0.3, y: 0.3, w: 0.2, h: 0.2 })).toBeLessThan(0.5);
  });

  it("reports unavailable accuracy honestly when no predictions exist", () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "fixtures/benchmark/real-v1/cases.json"), "utf8"));
    const r = scoreAssetBenchmark(raw.cases, null);
    expect(r.status).toBe("not-evaluated");
    expect(r.evaluationState).toBe("predictions-unavailable");
    expect(r.predictionsAvailable).toBe(false);
    expect(r.predictionProvenance).toMatch(/NOT measured/);
    // Nothing evaluated: every performance metric unavailable, never a measured zero.
    expect(r.detection.precision).toBeNull();
    expect(r.detection.recall).toBeNull();
    expect(r.detection.f1).toBeNull();
    expect(r.detection.unavailable).toBe(true);
    expect(r.association.unavailable).toBe(true);
    expect(r.association.accuracy).toBeNull();
    expect(r.evidenceFrame.unavailable).toBe(true);
    expect(r.localization.unavailable).toBe(true);
    expect(r.verification.unavailable).toBe(true);
    expect(r.coverage.assetsTracked).toBeNull();
    expect(r.coverage.assetsRepresented).toBeNull();
    expect(r.voiceMatching.reason).toMatch(/not applicable/i);
    // No defect labeled FN and no clean labeled PASS without evaluation.
    expect(r.cases.filter((c) => !c.skipped)).toHaveLength(0);
    expect(r.cases.every((c) => c.skipped)).toBe(true);
  });

  it("marks tracking/temporal/note-alignment unavailable for static images", () => {
    const r = scoreAssetBenchmark([gt({ caseId: "s" })], []);
    expect(r.coverage.note).toMatch(/NOT APPLICABLE|not inspection/i);
    expect(r.voiceMatching.accuracy).toBeNull();
  });
});

describe("provenance, determinism, type separation", () => {
  it("records static-image provenance and never claims live inference", () => {
    const r = scoreAssetBenchmark([gt({ caseId: "p" })], []);
    expect(r.mode).toBe("asset-benchmark");
    expect(r.realInference).toBe(false);
    expect(r.datasetType).toBe("static-image");
    expect(r.limitations.join(" ")).toMatch(/Static-image|hand-test/i);
  });

  it("produces deterministic JSON with stable ordering", () => {
    const a = [gt({ caseId: "b" }), gt({ caseId: "a", episodeId: "EP-0" })];
    const r1 = toAssetBenchJson(scoreAssetBenchmark(a, []));
    const r2 = toAssetBenchJson(scoreAssetBenchmark([...a].reverse(), []));
    expect(r1).toBe(r2);
  });

  it("separates synthetic, cached, and live results (provenance labels)", () => {
    const r = scoreAssetBenchmark(
      [gt({ caseId: "h", bbox: { x: 0, y: 0, w: 0.5, h: 0.5 }, bboxReliable: true })],
      [pred({ caseId: "h", bbox: { x: 0, y: 0, w: 0.5, h: 0.5 }, provenance: "hand-test" })],
    );
    expect(r.predictionsAvailable).toBe(true);
    expect(r.predictionProvenance).toMatch(/hand-test/);
    // Cached eval artifacts lack boxes/stable IDs by design and are never mapped here.
    expect(r.perEpisode[0].status).toBe("tp");
  });
});
