import { describe, expect, it } from "vitest";
import {
  exitCodeForStatus,
  scoreAssetBenchmark,
  toAssetBenchJson,
  validatePredictionArtifact,
  type RealGroundTruth,
  type RealPrediction,
} from "../bench-metrics";

// Manually calculated toy fixtures (never the scorer itself establishing truth).
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
  provenance: "actual",
  ...over,
});

describe("evaluation states: unavailable vs zero-detection vs scored", () => {
  it("1. ground truth with no artifact: all performance metrics unavailable", () => {
    const r = scoreAssetBenchmark([gt({ caseId: "d" })], null);
    expect(r.status).toBe("not-evaluated");
    expect(r.evaluationState).toBe("predictions-unavailable");
    expect(r.predictionsAvailable).toBe(false);
    expect(r.detection.precision).toBeNull();
    expect(r.detection.recall).toBeNull();
    expect(r.detection.f1).toBeNull();
    expect(r.detection.unavailable).toBe(true);
    expect(r.association.unavailable).toBe(true);
    expect(r.association.accuracy).toBeNull();
    expect(r.evidenceFrame.unavailable).toBe(true);
    expect(r.localization.unavailable).toBe(true);
    expect(r.verification.unavailable).toBe(true);
    expect(r.voiceMatching.accuracy).toBeNull();
  });

  it("2. null artifact plus accidental empty array: still unavailable, never zero-detection", () => {
    // null/undefined means missing. An empty array is a DIFFERENT claim (see 3).
    const rNull = scoreAssetBenchmark([gt({ caseId: "d" })], null);
    const rUndef = scoreAssetBenchmark([gt({ caseId: "d" })], undefined);
    for (const r of [rNull, rUndef]) {
      expect(r.status).toBe("not-evaluated");
      expect(r.detection.unavailable).toBe(true);
      expect(r.detection.recall).toBeNull(); // never 0.00 merely because nothing ran
    }
  });

  it("3. a completed run with an empty prediction array scores as zero detections", () => {
    const r = scoreAssetBenchmark([gt({ caseId: "d" })], []);
    expect(r.status).toBe("scored-fail");
    expect(r.evaluationState).toBe("completed-zero-detections");
    expect(r.predictionsAvailable).toBe(true); // artifact exists; it is empty
    expect(r.detection.falsePositives).toBe(0);
  });

  it("4. defect plus completed zero-detection run: false negative and zero recall", () => {
    const r = scoreAssetBenchmark([gt({ caseId: "d" })], []);
    expect(r.detection.falseNegatives).toBe(1);
    expect(r.detection.recall).toBe(0); // hand-computed: 0 TP / 1 episode
    expect(r.perEpisode[0].status).toBe("unpredicted");
  });

  it("5. zero predicted positives: precision unavailable, never zero", () => {
    const r = scoreAssetBenchmark([gt({ caseId: "d" })], []);
    expect(r.detection.precision).toBeNull(); // 0/0 is undefined, not 0.00
    expect(r.detection.f1).toBeNull();
  });

  it("6. clean case with unavailable predictions: not evaluated, never PASS", () => {
    const r = scoreAssetBenchmark(
      [gt({ caseId: "c", clean: true, assetId: "t-1", episodeId: null, observability: "not-observable" })],
      null,
    );
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0].passed).toBe(false);
    expect(r.cases[0].skipped).toBe(true);
    expect(r.cases[0].predicted).toMatch(/not evaluated/i);
    expect(r.detection.falsePositivesOnClean).toBe(0);
  });

  it("7. clean case with valid actual predictions and no finding: correctly evaluated", () => {
    const r = scoreAssetBenchmark(
      [gt({ caseId: "c", clean: true, assetId: "t-1", episodeId: null, observability: "not-observable" })],
      [],
    );
    expect(r.status).toBe("scored-pass");
    expect(r.evaluationState).toBe("completed-zero-detections");
    expect(r.cases[0].passed).toBe(true);
    expect(r.cases[0].skipped).toBe(false);
  });

  it("8. missing, malformed, stale, and unmappable artifacts are distinguished", () => {
    expect(validatePredictionArtifact(null).state).toBe("missing");
    expect(validatePredictionArtifact(undefined).state).toBe("missing");
    expect(validatePredictionArtifact([]).state).toBe("completed");
    expect(validatePredictionArtifact({ status: "completed", predictions: [] }).state).toBe("completed");
    // Failed/pending runs are not scored results.
    expect(validatePredictionArtifact({ status: "failed", predictions: [] }).state).toBe("invalid");
    expect(validatePredictionArtifact({ status: "completed", predictions: "nope" }).state).toBe("invalid");
    // Empty file / garbage / wrong shape.
    expect(validatePredictionArtifact("").state).toBe("invalid");
    expect(validatePredictionArtifact(42).state).toBe("invalid");
    expect(validatePredictionArtifact([{ caseId: "", category: "pole", defectClass: "rust", provenance: "actual" }]).state).toBe("invalid");
    expect(validatePredictionArtifact([{ caseId: "x", category: "pole", defectClass: "rust", provenance: "dreamt-it" }]).state).toBe("invalid");
    // Cached outputs that cannot be mapped are rejected at the gate only if malformed;
    // a well-formed cached entry validates but is labeled cached, never actual.
    const cached = validatePredictionArtifact([
      { caseId: "f021", category: "pole", defectClass: "rust", provenance: "cached" },
    ]);
    expect(cached.state).toBe("completed");
    // Unmappable caseIds are flagged in the report, never silently dropped or scored.
    const r = scoreAssetBenchmark(
      [gt({ caseId: "known" })],
      [pred({ caseId: "ghost", episodeId: "EP-GHOST", assetId: "ghost-1" })],
    );
    expect(r.unmappablePredictions.count).toBe(1);
    expect(r.unmappablePredictions.caseIds).toEqual(["ghost"]);
    expect(r.detection.truePositives).toBe(0);
    expect(r.detection.falsePositives).toBe(0); // unmappable excluded from P/R
  });

  it("9. hand-test predictions validate the scorer but never pose as real inference", () => {
    const r = scoreAssetBenchmark(
      [gt({ caseId: "h", bbox: { x: 0, y: 0, w: 0.5, h: 0.5 }, bboxReliable: true })],
      [pred({ caseId: "h", bbox: { x: 0, y: 0, w: 0.5, h: 0.5 }, provenance: "hand-test" })],
    );
    expect(r.perEpisode[0].status).toBe("tp");
    expect(r.realInference).toBe(false);
    expect(r.predictionProvenance).toMatch(/hand-test/);
    expect(r.predictionProvenance).not.toMatch(/actual pipeline/i);
  });

  it("10. JSON status, terminal status, metric availability, and exit code agree", () => {
    const cases: Array<[string, RealGroundTruth[], RealPrediction[] | null, number]> = [
      ["scored-pass", [gt({ caseId: "c", clean: true, assetId: "t", episodeId: null, observability: "not-observable" })], [], 0],
      ["scored-fail", [gt({ caseId: "d" })], [], 1],
      ["not-evaluated", [gt({ caseId: "d" })], null, 2],
    ];
    for (const [status, g, p, code] of cases) {
      const r = scoreAssetBenchmark(g, p);
      expect(r.status).toBe(status);
      expect(exitCodeForStatus(r.status)).toBe(code);
      const json = JSON.parse(toAssetBenchJson(r));
      expect(json.status).toBe(status);
      if (status === "not-evaluated") {
        expect(json.detection.unavailable).toBe(true);
        expect(json.detection.recall).toBeNull();
      }
    }
    expect(exitCodeForStatus("input-error")).toBe(3);
  });

  it("11. synthetic scoring and asset-level dedupe are unchanged", () => {
    // Five frames, one episode, one matching prediction: exactly one TP.
    const members = ["f1", "f2", "f3", "f4", "f5"].map((f, i) =>
      gt({ caseId: `c${i}`, frameId: f, episodeId: "EP-RUST", bbox: { x: 0.1, y: 0, w: 0.2, h: 1 }, bboxReliable: true }),
    );
    const r = scoreAssetBenchmark(members, [pred({ caseId: "c1", bbox: { x: 0.1, y: 0, w: 0.2, h: 1 } })]);
    expect(r.status).toBe("scored-pass");
    expect(r.detection.truePositives).toBe(1);
    expect(r.detection.falsePositives).toBe(0);
    expect(r.perEpisode).toHaveLength(1);
    // Wrong asset still fails after the state refactor.
    const wrong = scoreAssetBenchmark(
      [gt({ caseId: "a", assetId: "pole-RIGHT", bbox: { x: 0.1, y: 0, w: 0.2, h: 1 }, bboxReliable: true })],
      [pred({ caseId: "a", assetId: "pole-WRONG", bbox: { x: 0.1, y: 0, w: 0.2, h: 1 } })],
    );
    expect(wrong.detection.truePositives).toBe(0);
    expect(wrong.status).toBe("scored-fail");
  });

  it("12. deterministic reports and backward-compatible supported fixtures", () => {
    const a = [gt({ caseId: "b" }), gt({ caseId: "a", episodeId: "EP-0" })];
    expect(toAssetBenchJson(scoreAssetBenchmark(a, null))).toBe(
      toAssetBenchJson(scoreAssetBenchmark([...a].reverse(), null)),
    );
    // Legacy callers passing [] get explicit zero-detection semantics, not missing-data.
    const zero = scoreAssetBenchmark(a, []);
    expect(zero.evaluationState).toBe("completed-zero-detections");
    expect(zero.status).toBe("scored-fail"); // EP-0 unpredicted
  });
});
