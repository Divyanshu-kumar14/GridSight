import { describe, expect, it } from "vitest";
import {
  assertActualProvenance,
  assertNoSecrets,
  canonicalJson,
  predictionsDigestOf,
  sha256Hex,
  validatePredictionArtifact,
  validateRunManifest,
  type RealPrediction,
  type RunManifest,
} from "../bench-metrics";

const sha = (s: string) => sha256Hex(s);

function stage(over: Partial<RunManifest["stages"][number]> & { key: string }): RunManifest["stages"][number] {
  return { mode: "inference", status: "completed", providerRequestMade: true, ...over } as RunManifest["stages"][number];
}

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    manifestVersion: "run-manifest-v1",
    runId: "run-001",
    createdAt: "2026-10-01T10:00:00.000Z",
    completedAt: "2026-10-01T10:05:00.000Z",
    status: "completed",
    dataset: { id: "real-v1", version: "real-v1", inputs: { f021: sha("frame-bytes") } },
    pipeline: { provider: "meta", model: "muse-spark-1.3" },
    stages: [stage({ key: "report-generation", responseDigest: sha("raw-response") })],
    predictionsDigest: predictionsDigestOf([]),
    ...over,
  };
}

const actualPred = (over: Partial<RealPrediction> & { caseId: string }): RealPrediction => ({
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

const INPUTS = { f021: sha("frame-bytes") };

describe("run manifest validation", () => {
  it("accepts a valid completed execution with provider-request evidence", () => {
    const preds = [actualPred({ caseId: "R-08" })];
    const m = manifest({ predictionsDigest: predictionsDigestOf(preds) });
    const summary = validateRunManifest(m, { predictionsDigest: predictionsDigestOf(preds), datasetVersion: "real-v1", inputsActual: INPUTS });
    expect(summary.runId).toBe("run-001");
    expect(summary.inferenceStages).toBe(1);
    expect(summary.status).toBe("completed");
    const gate = assertActualProvenance(preds, m, { predictionsDigest: predictionsDigestOf(preds), datasetVersion: "real-v1", inputsActual: INPUTS });
    expect(gate.required).toBe(true);
    expect(gate.runId).toBe("run-001");
  });

  it("accepts a completed zero-prediction run (digest of the empty set)", () => {
    const m = manifest({ predictionsDigest: predictionsDigestOf([]) });
    expect(() =>
      assertActualProvenance([], m, { predictionsDigest: predictionsDigestOf([]), datasetVersion: "real-v1", inputsActual: INPUTS }),
    ).not.toThrow(); // no actual entries: nothing to gate
    // An explicit zero-detection artifact still validates as completed.
    expect(validatePredictionArtifact({ status: "completed", predictions: [] }).state).toBe("completed");
  });

  it("rejects actual claims with no run manifest", () => {
    expect(() =>
      assertActualProvenance([actualPred({ caseId: "R-08" })], null, { predictionsDigest: "x", datasetVersion: "real-v1", inputsActual: INPUTS }),
    ).toThrow(/without a run manifest/);
    expect(() =>
      assertActualProvenance([actualPred({ caseId: "R-08" })], undefined, { predictionsDigest: "x", datasetVersion: "real-v1", inputsActual: INPUTS }),
    ).toThrow(/without a run manifest/);
  });

  it("rejects an actual label with no valid execution record", () => {
    // Manifest whose only stages are cache: no provider evidence.
    const m = manifest({
      stages: [{ key: "report-generation", mode: "cache", status: "completed", providerRequestMade: false }],
      predictionsDigest: predictionsDigestOf([actualPred({ caseId: "R-08" })]),
    });
    expect(() =>
      assertActualProvenance([actualPred({ caseId: "R-08" })], m, { predictionsDigest: m.predictionsDigest, datasetVersion: "real-v1", inputsActual: INPUTS }),
    ).toThrow(/no inference stage with provider-request evidence/);
    // Inference claimed without a response digest is not evidence.
    const m2 = manifest({
      stages: [{ key: "report-generation", mode: "inference", status: "completed", providerRequestMade: false }],
    });
    expect(() => validateRunManifest(m2)).toThrow(/without a provider request/);
  });

  it("never upgrades cached or test-fixture output to actual", () => {
    const cached = [{ ...actualPred({ caseId: "R-08" }), provenance: "cached" as const }];
    // Cached entries need no manifest and pass the gate silently.
    expect(assertActualProvenance(cached, null, { predictionsDigest: "x", datasetVersion: "real-v1", inputsActual: INPUTS }).required).toBe(false);
    // But relabeling them actual without a manifest fails.
    const relabeled = [{ ...cached[0], provenance: "actual" as const }];
    expect(() => assertActualProvenance(relabeled, null, { predictionsDigest: "x", datasetVersion: "real-v1", inputsActual: INPUTS })).toThrow(/without a run manifest/);
    const hand = [{ ...actualPred({ caseId: "R-08" }), provenance: "hand-test" as const }];
    expect(assertActualProvenance(hand, null, { predictionsDigest: "x", datasetVersion: "real-v1", inputsActual: INPUTS }).required).toBe(false);
  });

  it("rejects failed, cancelled, and incomplete runs as actual evidence", () => {
    const failed = manifest({ status: "failed", completedAt: null, stages: [stage({ key: "report-generation", status: "failed", responseDigest: sha("r"), error: "boom" })] });
    expect(() =>
      assertActualProvenance([actualPred({ caseId: "x" })], failed, { predictionsDigest: failed.predictionsDigest, datasetVersion: "real-v1", inputsActual: INPUTS }),
    ).toThrow(/failed/);
    const cancelled = manifest({ status: "cancelled", completedAt: null });
    expect(() => validateRunManifest(cancelled)).not.toThrow(); // shape valid...
    expect(() =>
      assertActualProvenance([actualPred({ caseId: "x" })], cancelled, { predictionsDigest: cancelled.predictionsDigest, datasetVersion: "real-v1", inputsActual: INPUTS }),
    ).toThrow(/cancelled/); // ...but never scored as actual inference
    const missingCompletion = manifest({ status: "completed", completedAt: null });
    expect(() => validateRunManifest(missingCompletion)).toThrow(/missing completedAt|completed run missing completedAt/);
  });

  it("rejects mismatched input checksums and dataset versions", () => {
    const preds = [actualPred({ caseId: "R-08" })];
    const m = manifest({ predictionsDigest: predictionsDigestOf(preds) });
    expect(() =>
      assertActualProvenance(preds, m, { predictionsDigest: m.predictionsDigest, datasetVersion: "real-v2", inputsActual: INPUTS }),
    ).toThrow(/dataset/);
    expect(() =>
      assertActualProvenance(preds, m, { predictionsDigest: m.predictionsDigest, datasetVersion: "real-v1", inputsActual: { f021: sha("other-bytes") } }),
    ).toThrow(/checksum/);
  });

  it("rejects prediction-output digest mismatches", () => {
    const m = manifest({ predictionsDigest: sha("something-else") });
    expect(() =>
      assertActualProvenance([actualPred({ caseId: "R-08" })], m, { predictionsDigest: predictionsDigestOf([actualPred({ caseId: "R-08" })]), datasetVersion: "real-v1", inputsActual: INPUTS }),
    ).toThrow(/predictionsDigest/);
  });

  it("keeps unmappable and missing-asset references explicit under actual provenance", () => {
    // An actual prediction that cannot name a stable asset stays unmappable;
    // actual provenance never bypasses the mapping gate (asserted at score time).
    const ghost = actualPred({ caseId: "ghost-9", episodeId: "EP-GHOST", assetId: null, assetAssociation: "unresolved" });
    const m = manifest({ predictionsDigest: predictionsDigestOf([ghost]) });
    const gate = assertActualProvenance([ghost], m, { predictionsDigest: m.predictionsDigest, datasetVersion: "real-v1", inputsActual: INPUTS });
    expect(gate.required).toBe(true); // linkage verified...
    expect(ghost.assetId).toBeNull(); // ...yet identity remains unknown (scorer buckets it unmappable)
  });

  it("redacts credentials: manifests carrying secrets are rejected", () => {
    expect(() => assertNoSecrets({ note: "key sk-abc123XYZ7890qrs" })).toThrow(/credential/);
    expect(() => assertNoSecrets({ headers: "Bearer abc.def.ghi" })).toThrow(/credential/);
    expect(() => assertNoSecrets({ api_key: "x" })).toThrow(/credential/);
    expect(() => assertNoSecrets({ provider: "meta", model: "muse-spark-1.3", runId: "r1" })).not.toThrow();
    const leaky = manifest({ notes: ["used MODEL_API_KEY=sk-live-1234567890abcdef"] });
    expect(() => validateRunManifest(leaky)).toThrow(/credential/);
  });

  it("is deterministic and backward compatible with run-less artifacts", () => {
    const m = manifest();
    expect(canonicalJson({ b: 1, a: [3, 2, { z: 1, y: 2 }] })).toBe(canonicalJson({ a: [3, 2, { y: 2, z: 1 }], b: 1 }));
    expect(validateRunManifest(JSON.parse(JSON.stringify(m)))).toEqual(validateRunManifest(m));
    // Old artifacts (no run field, non-actual provenance) validate exactly as before.
    expect(validatePredictionArtifact({ status: "completed", predictions: [] }).state).toBe("completed");
    expect(validatePredictionArtifact(null).state).toBe("missing");
  });
});
