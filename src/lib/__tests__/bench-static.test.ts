import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EVAL_SYSTEM_PROMPT } from "../../../scripts/eval-lib";
import {
  adaptStaticCacheToArtifact,
  assertKnownFrames,
  buildStandaloneManifest,
  parseStandaloneRunLog,
  resolveRunPaths,
  selectStaticInputs,
  STATIC_BBOX_INSTRUCTION,
  STATIC_FRAME_IDS,
  validateStaticBox,
  verifyStaticInputBytes,
  type RunLogEntry,
  type StaticInputRef,
} from "../../../scripts/eval-static-lib";
import {
  scoreStaticBenchmark,
  toAssetBenchJson,
  predictionsDigestOf,
  validateRunManifest,
  validateStaticArtifact,
  verifyFrameCoverage,
  type RealGroundTruth,
} from "../bench-metrics";

const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

const gt = (over: Partial<RealGroundTruth> & { caseId: string }): RealGroundTruth => ({
  scene: "s1",
  sourceMediaId: "m1",
  frameId: "f001",
  timestamp: 0,
  assetId: "insulator-stack-A",
  assetCategory: "insulator",
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

const spred = (frameId: string, box: { x: number; y: number; w: number; h: number } | null, extra: Record<string, unknown> = {}) => ({
  frameId,
  category: "pole",
  defectClass: "rust",
  bbox: box,
  evidenceSource: "visual" as const,
  verification: "keep" as const,
  provenance: "cached" as const,
  ...extra,
});

function avail(ids: string[]): StaticInputRef[] {
  return ids.map((frameId, i) => ({
    frameId,
    file: `fixtures/eval/frames/${frameId}.jpg`,
    sha256: sha256Hex(`bytes-${i}`),
    timestamp: i,
    scene: "s",
  }));
}

describe("input selection: exact approved set, stable order", () => {
  it("returns exactly the 12 approved IDs in requested (dataset) order", () => {
    const out = selectStaticInputs(avail([...STATIC_FRAME_IDS].reverse()));
    expect(out.map((a) => a.frameId)).toEqual([...STATIC_FRAME_IDS]);
    expect(out).toHaveLength(12);
    expect(new Set(out.map((a) => a.frameId)).size).toBe(12);
  });

  it("rejects unknown, duplicate, and empty selections", () => {
    const a = avail(["f001", "f003"]);
    expect(() => selectStaticInputs(a, ["f001", "nope"])).toThrow(/unknown input frame/);
    expect(() => selectStaticInputs(a, ["f001", "f001"])).toThrow(/duplicate/);
    expect(() => selectStaticInputs(a, [])).toThrow(/refusing to evaluate nothing/);
  });

  it("supports an explicit subset (still validated, requested order honored)", () => {
    const out = selectStaticInputs(avail(["f001", "f003", "f006"]), ["f006", "f001"]);
    expect(out.map((a) => a.frameId)).toEqual(["f006", "f001"]);
  });

  it("unknown frameIds fail fast instead of scoring", () => {
    expect(() => assertKnownFrames(["f001", "f999"], ["f001"])).toThrow(/f999/);
    expect(() => assertKnownFrames(["f001"], new Set(["f001"]))).not.toThrow();
  });
});

describe("input checksum verification", () => {
  it("accepts matching bytes and rejects altered or missing checksums", () => {
    const bytes = new TextEncoder().encode("frame-bytes");
    const hex = sha256Hex(bytes);
    expect(() => verifyStaticInputBytes([{ frameId: "f001", sha256: hex, bytes }])).not.toThrow();
    expect(() =>
      verifyStaticInputBytes([{ frameId: "f001", sha256: "0".repeat(64), bytes }]),
    ).toThrow(/mismatch/);
    expect(() => verifyStaticInputBytes([{ frameId: "f001", sha256: "", bytes }])).toThrow(/missing its checksum/);
  });
});

describe("no ground-truth leakage into model prompts", () => {
  const DENY = [
    "EP-RUST", "rust-pole", "insulator-stack", "tower-left", "tower-right",
    "fence-post", "R-08", "R-09", "R-10", "R-11", "R-12",
    "slunj-yard", "insulators-closeup", "switchyard-towers",
  ];
  it("base prompt and static bbox instruction contain no GT instance identifiers", () => {
    const combined = `${EVAL_SYSTEM_PROMPT}\n\n${STATIC_BBOX_INSTRUCTION}`.toLowerCase();
    for (const term of DENY) {
      expect(combined).not.toContain(term.toLowerCase());
    }
    // Sanity: the prompt still asks for what detection needs.
    expect(combined).toContain("bounding box");
  });
});

describe("cache isolation", () => {
  it("defaults to the checked-in fixture cache (not isolated)", () => {
    const r = resolveRunPaths({ baseDir: "/repo" });
    expect(r.cacheDir).toBe("/repo/fixtures/eval/cache");
    expect(r.outDir).toBe("/repo/fixtures/eval/cache");
    expect(r.isolated).toBe(false);
  });

  it("custom dirs isolate outputs and never reference fixtures", () => {
    const r = resolveRunPaths({ cacheDir: "/tmp/run1/cache", outDir: "/tmp/run1", baseDir: "/repo" });
    expect(r.isolated).toBe(true);
    expect(r.cacheDir).toBe("/tmp/run1/cache");
    expect(r.cacheDir).not.toContain("fixtures/eval/cache");
    expect(r.outDir).not.toContain("fixtures/eval/cache");
  });

  it("an absolute path to the fixture cache is still caught, not treated as isolated", () => {
    const r = resolveRunPaths({ cacheDir: "/repo/fixtures/eval/cache", baseDir: "/repo" });
    expect(r.isolated).toBe(false);
  });

  it("relative custom dirs resolve against the base", () => {
    const r = resolveRunPaths({ cacheDir: "scratch/cache", baseDir: "/repo" });
    expect(r.cacheDir).toBe("/repo/scratch/cache");
    expect(r.isolated).toBe(true);
  });
});

describe("static box validation", () => {
  it("accepts a valid normalized box", () => {
    expect(validateStaticBox({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  it("rejects non-finite, out-of-range, degenerate, and overflowing boxes", () => {
    expect(() => validateStaticBox(null)).toThrow();
    expect(() => validateStaticBox("box")).toThrow();
    for (const bad of [
      { x: NaN, y: 0, width: 0.1, height: 0.1 },
      { x: 0, y: 0, width: Infinity, height: 0.1 },
      { x: -0.1, y: 0, width: 0.1, height: 0.1 },
      { x: 0, y: 1.1, width: 0.1, height: 0.1 },
      { x: 0, y: 0, width: 0, height: 0.1 },
      { x: 0, y: 0, width: -0.1, height: 0.1 },
      { x: 0.9, y: 0.9, width: 0.2, height: 0.2 },
      { x: 0, y: 0, width: 0.1 }, // missing height
    ]) {
      expect(() => validateStaticBox(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("static artifact validation states", () => {
  const good = {
    frameId: "f021", category: "pole", defectClass: "rust", bbox: null,
    evidenceSource: "visual" as const, verification: "keep" as const, provenance: "cached" as const,
  };

  it("missing artifact → missing (never scored)", () => {
    expect(validateStaticArtifact(null).state).toBe("missing");
    expect(validateStaticArtifact(undefined).state).toBe("missing");
  });

  it("completed run with empty predictions → completed zero-detection", () => {
    const r = validateStaticArtifact({ status: "completed", predictions: [] });
    expect(r.state).toBe("completed");
    expect(r.predictions).toEqual([]);
  });

  it("failed run status → invalid (never silently completed)", () => {
    expect(validateStaticArtifact({ status: "failed", predictions: [] }).state).toBe("invalid");
    expect(validateStaticArtifact({ status: "pending", predictions: [] }).state).toBe("invalid");
    expect(validateStaticArtifact("garbage").state).toBe("invalid");
    expect(validateStaticArtifact(42).state).toBe("invalid");
  });

  it("entries require frameId (not caseId) and known provenance", () => {
    expect(validateStaticArtifact([{ ...good, frameId: "" }]).state).toBe("invalid");
    expect(validateStaticArtifact([{ ...good, frameId: undefined }]).state).toBe("invalid");
    expect(validateStaticArtifact([{ ...good, provenance: "actual-ish" }]).state).toBe("invalid");
    // caseId is NOT required on the static path (frame linkage instead).
    const noCase = validateStaticArtifact([{ ...good }]);
    expect(noCase.state).toBe("completed");
  });

  it("run manifest passes through for bench-time linkage checks", () => {
    const r = validateStaticArtifact({ status: "completed", predictions: [], run: { manifestVersion: "run-manifest-v1" } });
    expect(r.state).toBe("completed");
    expect(r.run).toEqual({ manifestVersion: "run-manifest-v1" });
  });
});

describe("scoreStaticBenchmark: episode dedupe and localization", () => {
  const members = ["f021", "f023", "f025"].map((frameId, i) =>
    gt({ caseId: `R-0${8 + i}`, frameId, timestamp: i, bbox: { x: 0.1, y: 0, w: 0.2, h: 1 }, bboxReliable: true, assetId: "rust-pole-foreground", assetCategory: "pole" }),
  );
  const good = { x: 0.12, y: 0.05, w: 0.18, h: 0.9 };

  it("counts two frames of one episode as ONE true positive", () => {
    const r = scoreStaticBenchmark(members, [spred("f021", good), spred("f023", good)]);
    expect(r.detection.truePositives).toBe(1);
    expect(r.detection.falsePositives).toBe(0);
    expect(r.perEpisode).toHaveLength(1);
    expect(r.perEpisode[0].status).toBe("tp");
    expect(r.status).toBe("scored-pass");
    expect(r.perScene["s1"].truePositives).toBe(1); // per-scene tallies are real, never stuck at zero
    expect(r.perScene["s1"].cases).toBe(3);
  });

  it("wrong box does not count as localized TP when GT box is reliable", () => {
    const r = scoreStaticBenchmark(members, [spred("f021", { x: 0.8, y: 0.8, w: 0.05, h: 0.05 })]);
    expect(r.detection.truePositives).toBe(0);
    expect(r.detection.falsePositives).toBe(1);
    expect(r.detection.falseNegatives).toBe(1);
    expect(r.cases.every((c) => !c.passed)).toBe(true);
    expect(r.localization.evaluated).toBe(1);
    expect(r.localization.correct).toBe(0);
  });

  it("missing box withholds the TP but keeps the finding visible", () => {
    const r = scoreStaticBenchmark(members, [spred("f021", null)]);
    expect(r.detection.truePositives).toBe(0);
    expect(r.cases.find((c) => c.caseId === "R-08")?.predicted).toMatch(/present but|no mapped prediction/);
    expect(r.localization.evaluated).toBe(0);
    expect(r.localization.accuracy).toBeNull();
  });

  it("clean frames with predictions are false positives; clean without are untouched", () => {
    const clean = gt({ caseId: "R-01", frameId: "f001", clean: true, defectClass: "", episodeId: null, assetId: "tower-left", assetCategory: "tower", observability: "not-observable" });
    const fp = scoreStaticBenchmark([clean], [{ ...spred("f001", null), category: "tower" }]);
    expect(fp.detection.falsePositives).toBe(1);
    expect(fp.detection.falsePositivesOnClean).toBe(1);
    const tn = scoreStaticBenchmark([clean], []);
    expect(tn.detection.falsePositives).toBe(0);
    expect(tn.status).toBe("scored-pass");
  });

  it("uncertain annotations stay excluded; unknown frames land unmappable", () => {
    const uncertain = gt({ caseId: "R-06", frameId: "f014", clean: true, defectClass: "", episodeId: null, assetId: "t-1", observability: "uncertain", excludedFrom: ["detection"] });
    const r = scoreStaticBenchmark([uncertain], []);
    expect(r.cases[0].skipped).toBe(true);
    const ghost = scoreStaticBenchmark(members, [{
      frameId: "f999", category: "pole", defectClass: "rust", bbox: null,
      evidenceSource: "visual" as const, verification: null, provenance: "cached" as const,
    }]);
    expect(ghost.unmappablePredictions.count).toBe(1);
    expect(ghost.unmappablePredictions.caseIds).toEqual(["f999"]);
    expect(ghost.detection.truePositives).toBe(0);
    expect(ghost.detection.falsePositives).toBe(0);
  });

  it("missing artifact scores nothing (State A)", () => {
    const r = scoreStaticBenchmark(members, null);
    expect(r.status).toBe("not-evaluated");
    expect(r.detection.unavailable).toBe(true);
    expect(r.association.unavailable).toBe(true);
    expect(r.localization.unavailable).toBe(true);
    expect(r.cases.every((c) => c.skipped)).toBe(true);
  });

  it("association and frame metrics stay unavailable on the static path", () => {
    const r = scoreStaticBenchmark(members, [spred("f021", good)]);
    expect(r.association.unavailable).toBe(true);
    expect(r.association.accuracy).toBeNull();
    expect(r.evidenceFrame.unavailable).toBe(true);
    expect(r.verification.kept).toBe(1);
  });
});

describe("static adapter honesty", () => {
  const entry = (id: string, after: unknown, claimedBoxes?: unknown) => ({ id, after, claimedBoxes });

  it("keys predictions by source frame and carries validated boxes, never asset IDs", () => {
    const out = adaptStaticCacheToArtifact(
      [entry("f021", [{ assetCategory: "pole", defect: "rust", evidenceSource: "visual", verification: { verdict: "keep" } }], { "f021-1": { x: 0.1, y: 0, w: 0.2, h: 1 } })],
      { provenanceDefault: "cached" },
    );
    expect(out.predictions).toHaveLength(1);
    expect(out.predictions[0].frameId).toBe("f021");
    expect(out.predictions[0].bbox).toEqual({ x: 0.1, y: 0, w: 0.2, h: 1 });
    expect(out.predictions[0]).not.toHaveProperty("assetId");
    expect(out.predictions[0].provenance).toBe("cached");
  });

  it("invalid claimed boxes become null with a note; finding preserved", () => {
    const out = adaptStaticCacheToArtifact(
      [entry("f021", [{ assetCategory: "pole", defect: "rust" }], { "f021-1": { x: 5, y: 5, w: -1, h: 0 } })],
      { provenanceDefault: "cached" },
    );
    expect(out.predictions).toHaveLength(1);
    expect(out.predictions[0].bbox).toBeNull();
    expect(out.notes.join(" ")).toMatch(/invalid claimed box/);
  });

  it("skips errored and empty entries without fabricating zero-detection claims", () => {
    const out = adaptStaticCacheToArtifact(
      [{ id: "f001", after: [] }, { id: "f002", error: "boom", after: [] }, null as never],
      { provenanceDefault: "cached" },
    );
    expect(out.predictions).toEqual([]);
    expect(out.skipped).toBe(2);
  });
});

describe("standalone manifest without SQLite", () => {
  const logEntry = (over: Partial<RunLogEntry> & { frameId: string }): RunLogEntry => ({
    timestamp: 20,
    mode: "live",
    provider: "meta",
    model: "muse-spark-1.3",
    requests: { firstPass: 1, verify: 1 },
    responseDigest: "a".repeat(64),
    ...over,
  });

  it("builds a valid manifest from run-log entries plus predictions", () => {
    const preds = [{ frameId: "f021" }];
    const m = buildStandaloneManifest({
      runLog: [logEntry({ frameId: "f021" }), { ...logEntry({ frameId: "f003" }), mode: "cache-hit", responseDigest: undefined }],
      predictions: preds,
      datasetId: "real-v1",
      datasetVersion: "real-v1",
      inputs: { f021: sha256Hex("a"), f003: sha256Hex("b") },
      provider: "meta",
      model: "muse-spark-1.3",
      runId: "run-1",
    });
    expect(m.stages.map((s) => s.key)).toEqual(["frame:f021", "frame:f003"]);
    expect(m.stages[0].mode).toBe("inference");
    expect(m.stages[1].mode).toBe("cache");
    expect(() =>
      validateRunManifest(m, {
        predictionsDigest: predictionsDigestOf(preds),
        datasetVersion: "real-v1",
        inputsActual: { f021: sha256Hex("a"), f003: sha256Hex("b") },
      }),
    ).not.toThrow();
  });

  it("refuses live frames without response digests and mismatched digests", () => {
    expect(() =>
      buildStandaloneManifest({
        runLog: [{ ...logEntry({ frameId: "f021" }), responseDigest: undefined }],
        predictions: [],
        datasetId: "real-v1",
        datasetVersion: "real-v1",
        inputs: {},
        provider: "meta",
        model: "m",
        runId: "r",
      }),
    ).toThrow(/without responseDigest/);
    const m = buildStandaloneManifest({
      runLog: [logEntry({ frameId: "f021" })],
      predictions: [{ frameId: "f021" }],
      datasetId: "real-v1",
      datasetVersion: "real-v1",
      inputs: {},
      provider: "meta",
      model: "m",
      runId: "r",
    });
    expect(() => validateRunManifest(m, { predictionsDigest: "0".repeat(64) })).toThrow(/predictionsDigest/);
  });

  it("failed, skipped, cached, fixture, and zero-detection runs stay distinct", () => {
    const failed = buildStandaloneManifest({
      runLog: [{ ...logEntry({ frameId: "f021" }), error: "boom" }],
      predictions: [],
      datasetId: "real-v1",
      datasetVersion: "real-v1",
      inputs: {},
      provider: "meta",
      model: "m",
      runId: "r",
    });
    expect(failed.status).toBe("failed");
    expect(failed.stages[0].status).toBe("failed");
    const parsed = parseStandaloneRunLog({
      runLogVersion: 1,
      runId: "r",
      provider: "meta",
      model: "m",
      frames: [{ frameId: "f021", timestamp: 1, mode: "skipped", provider: "meta", model: "m", requests: { firstPass: 0, verify: 0 } }],
    });
    expect(parsed.frames).toHaveLength(1);
    expect(() => parseStandaloneRunLog({})).toThrow(/run log/);
    expect(() => parseStandaloneRunLog({ frames: [{ frameId: "" }] })).toThrow(/frameId/);
    expect(() => parseStandaloneRunLog({ frames: [{ frameId: "f", mode: "bogus" }] })).toThrow(/mode/);
  });
});

describe("standalone manifest timestamps anchor to execution", () => {
  const liveAt = (frameId: string, at: string): RunLogEntry => ({
    frameId, timestamp: 1, mode: "live", provider: "meta", model: "m",
    requests: { firstPass: 1, verify: 0 }, responseDigest: "a".repeat(64), at,
  });

  it("ignores late artifact-build time: bounds come from frame evidence", () => {
    // Pilot shape: frames finished 17:55:04/17:55:22, artifact built 18:03.
    // The old builder used the build clock as createdAt and failed validation.
    const m = buildStandaloneManifest({
      runLog: [liveAt("f001", "2026-10-27T17:55:04.060Z"), liveAt("f021", "2026-10-27T17:55:22.663Z")],
      predictions: [{ frameId: "f021" }],
      datasetId: "real-v1", datasetVersion: "real-v1",
      inputs: {}, provider: "meta", model: "m", runId: "r",
      recordedAt: "2026-10-27T18:03:22.330Z",
    });
    expect(m.createdAt).toBe("2026-10-27T17:55:04.060Z");
    expect(m.completedAt).toBe("2026-10-27T17:55:22.663Z");
    expect(() =>
      validateRunManifest(m, { predictionsDigest: predictionsDigestOf([{ frameId: "f021" }]) }),
    ).not.toThrow();
  });

  it("prefers a recorded run start and refuses to reorder skewed clocks", () => {
    const base = {
      runLog: [liveAt("f001", "2026-10-27T17:55:04.060Z"), liveAt("f021", "2026-10-27T17:55:22.663Z")],
      predictions: [{ frameId: "f021" }],
      datasetId: "real-v1", datasetVersion: "real-v1",
      inputs: {}, provider: "meta", model: "m", runId: "r",
      recordedAt: "2026-10-27T18:03:22.330Z",
    };
    const m = buildStandaloneManifest({ ...base, runStartedAt: "2026-10-27T17:54:59.000Z" });
    expect(m.createdAt).toBe("2026-10-27T17:54:59.000Z");
    expect(m.completedAt).toBe("2026-10-27T17:55:22.663Z");
    expect(() =>
      validateRunManifest(m, { predictionsDigest: predictionsDigestOf([{ frameId: "f021" }]) }),
    ).not.toThrow();
    // Start postdating completion is clock skew: throw, never silently swap.
    expect(() => buildStandaloneManifest({ ...base, runStartedAt: "2026-10-27T17:55:30.000Z" })).toThrow(/postdates/);
    expect(() => buildStandaloneManifest({ ...base, runStartedAt: "not-a-time" })).toThrow(/bad runStartedAt/);
  });

  it("falls back to recordedAt only when no frame carries timing", () => {
    const skipped: RunLogEntry = {
      frameId: "f001", timestamp: 1, mode: "skipped", provider: "meta", model: "m",
      requests: { firstPass: 0, verify: 0 },
    };
    const m = buildStandaloneManifest({
      runLog: [skipped],
      predictions: [],
      datasetId: "real-v1", datasetVersion: "real-v1",
      inputs: {}, provider: "meta", model: "m", runId: "r",
      recordedAt: "2026-10-27T18:03:22.330Z",
    });
    expect(m.createdAt).toBe("2026-10-27T18:03:22.330Z");
    expect(m.completedAt).toBe("2026-10-27T18:03:22.330Z");
    expect(() =>
      validateRunManifest(m, { predictionsDigest: predictionsDigestOf([]) }),
    ).not.toThrow();
  });

  it("parseStandaloneRunLog round-trips startedAt and rejects malformed values", () => {
    const frame = { frameId: "f021", timestamp: 20, mode: "live", provider: "meta", model: "m", requests: { firstPass: 1, verify: 0 } };
    expect(parseStandaloneRunLog({ frames: [frame] }).startedAt).toBeNull();
    expect(
      parseStandaloneRunLog({ startedAt: "2026-10-27T17:54:59.000Z", frames: [frame] }).startedAt,
    ).toBe("2026-10-27T17:54:59.000Z");
    expect(() => parseStandaloneRunLog({ startedAt: "not-a-time", frames: [frame] })).toThrow(/startedAt/);
  });

  it("incomplete records: failed entries fail loudly, outputDigest stays optional", () => {
    // A live frame with an execution error records a failed stage (never a
    // silent completed inference) and the manifest reports failed status.
    const m = buildStandaloneManifest({
      runLog: [{ ...liveAt("f021", "2026-10-27T17:55:22.663Z"), error: "boom", responseDigest: undefined }],
      predictions: [],
      datasetId: "real-v1", datasetVersion: "real-v1",
      inputs: {}, provider: "meta", model: "m", runId: "r",
    });
    expect(m.status).toBe("failed");
    expect(m.completedAt).toBeNull();
    // outputDigest is genuinely unavailable on this path (never recorded) and
    // optional by schema: its absence never blocks actual-provenance linkage.
    expect(m.stages[0]).not.toHaveProperty("outputDigest");
    expect(() =>
      validateRunManifest(m, { predictionsDigest: predictionsDigestOf([]) }),
    ).not.toThrow();
    // Live success without any response evidence is still refused outright.
    expect(() =>
      buildStandaloneManifest({
        runLog: [{ ...liveAt("f021", "2026-10-27T17:55:22.663Z"), responseDigest: undefined }],
        predictions: [],
        datasetId: "real-v1", datasetVersion: "real-v1",
        inputs: {}, provider: "meta", model: "m", runId: "r",
      }),
    ).toThrow(/without responseDigest/);
  });
});

describe("failed, skipped, cached, and zero-detection runs stay distinct", () => {
  const live = (id: string) => ({
    frameId: id, timestamp: 1, mode: "live" as const, provider: "meta", model: "m",
    requests: { firstPass: 1 as const, verify: 0 }, responseDigest: "a".repeat(64),
  });
  const cached = (id: string): RunLogEntry => ({
    frameId: id, timestamp: 1, mode: "cache-hit", provider: "meta", model: "m", requests: { firstPass: 0, verify: 0 },
  });

  it("cache-hit frames never satisfy the actual gate; skipped frames are recorded, not scored", () => {
    const m = buildStandaloneManifest({
      runLog: [live("f021"), cached("f003")],
      predictions: [], datasetId: "real-v1", datasetVersion: "real-v1",
      inputs: {}, provider: "meta", model: "m", runId: "r",
    });
    expect(m.status).toBe("completed");
    expect(m.stages.find((s) => s.key === "frame:f021")).toMatchObject({ mode: "inference", status: "completed" });
    expect(m.stages.find((s) => s.key === "frame:f003")).toMatchObject({ mode: "cache", status: "completed" });
    // Live frame passes; cached frame fails the actual gate.
    expect(verifyFrameCoverage(m, ["f021"])).toEqual({ covered: ["f021"] });
    expect(() => verifyFrameCoverage(m, ["f021", "f003"])).toThrow(/f003/);
  });

  it("zero detections with a completed run scores as zero, not as missing", () => {
    const r = scoreStaticBenchmark(
      [gt({ caseId: "d", frameId: "f001", episodeId: "EP-1" })],
      [],
    );
    expect(r.status).toBe("scored-fail");
    expect(r.evaluationState).toBe("completed-zero-detections");
    expect(r.detection.falseNegatives).toBe(1);
    expect(r.detection.precision).toBeNull();
  });

  it("manifest linkage mismatches are rejected, not scored", () => {
    const m = buildStandaloneManifest({
      runLog: [live("f021")],
      predictions: [{ frameId: "f021" }],
      datasetId: "real-v1",
      datasetVersion: "real-v1",
      inputs: { f021: sha256Hex("a") },
      provider: "meta",
      model: "m",
      runId: "r",
    });
    expect(() =>
      validateRunManifest({ ...m, predictionsDigest: "0".repeat(64) }, { predictionsDigest: predictionsDigestOf([{ frameId: "f021" }]) }),
    ).toThrow(/predictionsDigest/);
    expect(() =>
      validateRunManifest(m, { predictionsDigest: predictionsDigestOf([{ frameId: "f021" }]), datasetVersion: "real-v2" }),
    ).toThrow(/dataset version/);
    expect(() =>
      validateRunManifest(m, { predictionsDigest: predictionsDigestOf([{ frameId: "f021" }]), inputsActual: { f021: sha256Hex("other") } }),
    ).toThrow(/checksum/);
  });
});

describe("frame coverage gate", () => {
  const liveEntry = (frameId: string): RunLogEntry => ({
    frameId, timestamp: 1, mode: "live", provider: "meta", model: "m",
    requests: { firstPass: 1, verify: 0 }, responseDigest: "a".repeat(64),
  });

  function manifestFor(frames: RunLogEntry[]) {
    return buildStandaloneManifest({
      runLog: frames, predictions: [], datasetId: "real-v1", datasetVersion: "real-v1",
      inputs: {}, provider: "meta", model: "m", runId: "r",
    });
  }

  it("requires completed live stages for every scored frame", () => {
    const m = manifestFor([
      liveEntry("f021"),
      { frameId: "f003", timestamp: 2, mode: "cache-hit", provider: "meta", model: "m", requests: { firstPass: 0, verify: 0 } },
    ]);
    expect(verifyFrameCoverage(m, ["f021"])).toEqual({ covered: ["f021"] });
    expect(() => verifyFrameCoverage(m, ["f021", "f003"])).toThrow(/f003/);
    expect(() => verifyFrameCoverage(m, ["f999"])).toThrow(/f999/);
    expect(() => verifyFrameCoverage(null, ["f021"])).toThrow();
  });
});

describe("deterministic output", () => {
  it("produces stable JSON regardless of input order", () => {
    const a = [gt({ caseId: "b" }), gt({ caseId: "a", episodeId: "EP-0" })];
    const r1 = toAssetBenchJson(scoreStaticBenchmark(a, null));
    const r2 = toAssetBenchJson(scoreStaticBenchmark([...a].reverse(), null));
    expect(r1).toBe(r2);
  });

  it("rejects manifests carrying secrets at build time", () => {
    expect(() =>
      buildStandaloneManifest({
        runLog: [{ frameId: "f001", timestamp: 1, mode: "live", provider: "meta", model: "m", requests: { firstPass: 1, verify: 0 }, responseDigest: "a".repeat(64) }],
        predictions: [],
        datasetId: "real-v1",
        datasetVersion: "real-v1",
        inputs: {},
        provider: "meta",
        model: "sk-abc123XYZ7890qrs-leaked",
        runId: "r",
      }),
    ).toThrow(/credential/);
  });
});
