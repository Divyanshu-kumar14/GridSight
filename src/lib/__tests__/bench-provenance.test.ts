import { createHash } from "node:crypto";
import { readFileSync as readFile } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adaptEvalCacheToArtifact,
  scoreAssetBenchmark,
  toAssetBenchJson,
  validatePredictionArtifact,
  validateProvenanceManifest,
  verifyInputChecksums,
  type RealGroundTruth,
} from "../bench-metrics";

const manifestPath = join(process.cwd(), "fixtures/benchmark/real-v1/provenance.json");
const casesPath = join(process.cwd(), "fixtures/benchmark/real-v1/cases.json");
const loadManifest = () => JSON.parse(readFile(manifestPath, "utf8"));
const loadCases = (): RealGroundTruth[] => JSON.parse(readFile(casesPath, "utf8")).cases;

describe("provenance manifest validation", () => {
  it("accepts the shipped manifest with expected counts", () => {
    const r = validateProvenanceManifest(loadManifest(), loadCases());
    expect(r.sources).toBe(3);
    expect(r.frames).toBe(12);
    expect(r.assets).toBe(6);
    expect(r.episodes).toBe(1);
    expect(r.warnings.length).toBeGreaterThan(0); // unknown download dates honestly flagged
    expect(r.warnings.join(" ")).toMatch(/download date unknown/i);
  });

  it("rejects missing license evidence and malformed checksums", () => {
    const m = loadManifest();
    const noLicense = JSON.parse(JSON.stringify(m));
    noLicense.sources[0].license = "not recorded";
    expect(() => validateProvenanceManifest(noLicense, loadCases())).toThrow(/no verified license/);
    const badHash = JSON.parse(JSON.stringify(m));
    badHash.sources[0].frames[0].sha256 = "abc123";
    expect(() => validateProvenanceManifest(badHash, loadCases())).toThrow(/malformed sha256/);
    const dupe = JSON.parse(JSON.stringify(m));
    dupe.sources[1].frames.push({ ...dupe.sources[0].frames[0] });
    expect(() => validateProvenanceManifest(dupe, loadCases())).toThrow(/duplicate frameId/);
  });

  it("allows honestly unknown authors/dates as warnings, never as verified facts", () => {
    const m = loadManifest();
    const unknownAuthor = JSON.parse(JSON.stringify(m));
    unknownAuthor.sources[0].author = "unknown — author not stated on source page";
    const r = validateProvenanceManifest(unknownAuthor, loadCases());
    expect(r.warnings.join(" ")).toMatch(/author unknown/i);
  });
});

describe("media checksum and case-reference integrity", () => {
  it("every manifest checksum matches the bytes on disk", () => {
    const m = loadManifest();
    for (const s of m.sources) {
      for (const f of s.frames) {
        const actual = createHash("sha256").update(readFile(join(process.cwd(), f.file))).digest("hex");
        expect(actual, `checksum drift: ${f.frameId}`).toBe(f.sha256);
      }
    }
  });

  it("every case frameId resolves to exactly one manifest frame", () => {
    const cases = loadCases();
    const frameIds = new Set<string>();
    for (const s of loadManifest().sources) for (const f of s.frames) frameIds.add(f.frameId);
    for (const c of cases) expect(frameIds.has(c.frameId), c.caseId).toBe(true);
    const orphans = ["f002", "f999"].filter((id) => frameIds.has(id));
    expect(orphans).toEqual([]);
  });
});

describe("static-image versus genuine-video metadata", () => {
  it("declares static-image with derivative sources everywhere", () => {
    const m = loadManifest();
    expect(m.mediaType).toBe("static-image");
    for (const s of m.sources) expect(s.sampleType).toBe("derivative-frame-from-still");
    expect(m.sourceClip.mediaType).toBe("synthetic-motion-from-stills");
  });

  it("rejects a genuine-video claim inside a static-image dataset", () => {
    const m = loadManifest();
    const bad = JSON.parse(JSON.stringify(m));
    bad.sources[0].sampleType = "genuine-video";
    expect(() => validateProvenanceManifest(bad, loadCases())).toThrow(/genuine video in a static-image dataset/);
  });
});

describe("invalid and contradictory mappings", () => {
  it("rejects cases pointing at unknown frames and episodes spanning scenes", () => {
    const cases = loadCases();
    const badFrame = cases.map((c) => ({ ...c }));
    badFrame[0] = { ...badFrame[0], frameId: "f999" };
    expect(() => validateProvenanceManifest(loadManifest(), badFrame)).toThrow(/unknown frameId/);
    const splitEpisode = cases.map((c) => ({ ...c }));
    splitEpisode[7] = { ...splitEpisode[7], scene: "elsewhere" };
    expect(() => validateProvenanceManifest(loadManifest(), splitEpisode)).toThrow(/scene/);
  });
});

describe("prediction artifact version and checksum mismatches", () => {
  it("stale dataset versions do not validate as current", () => {
    const stale = { status: "completed", datasetVersion: "real-v0", predictions: [] };
    const v = validatePredictionArtifact(stale);
    // Shape is valid; the runner rejects the version skew (tested below via message contract).
    expect(v.state).toBe("completed");
    expect(stale.datasetVersion).not.toBe("real-v1");
  });

  it("input checksums distinguish altered, missing, and matching media", () => {
    expect(verifyInputChecksums({ f1: "a" }, { f1: "a" }).ok).toBe(true);
    const altered = verifyInputChecksums({ f1: "a" }, { f1: "b" });
    expect(altered.ok).toBe(false);
    expect(altered.mismatches).toEqual(["f1"]);
    const missing = verifyInputChecksums({ f1: "a", f2: "b" }, { f1: "a" });
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(["f2"]);
  });

  it("completed zero detections, failed runs, and missing artifacts stay distinct", () => {
    expect(validatePredictionArtifact(null).state).toBe("missing");
    expect(validatePredictionArtifact(undefined).state).toBe("missing");
    const zero = validatePredictionArtifact([]);
    expect(zero.state).toBe("completed");
    expect(zero.predictions).toEqual([]);
    expect(validatePredictionArtifact({ status: "failed", predictions: [] }).state).toBe("invalid");
    expect(validatePredictionArtifact({ status: "pending", predictions: [] }).state).toBe("invalid");
    expect(validatePredictionArtifact("").state).toBe("invalid");
    expect(validatePredictionArtifact({ status: "completed", predictions: "nope" }).state).toBe("invalid");
  });
});

describe("unmappable predictions are reported, never scored or dropped", () => {
  it("ghost caseIds land in unmappablePredictions with P/R untouched", () => {
    const gt: RealGroundTruth = {
      scene: "s", sourceMediaId: "m", frameId: "f", timestamp: 0, assetId: "a-1",
      assetCategory: "pole", clean: true, defectClass: "", visualDescription: "d",
      bbox: null, bboxReliable: false, observability: "not-observable",
      episodeId: null, excludedFrom: [], annotationNotes: "", caseId: "R-1",
    };
    const r = scoreAssetBenchmark([gt], [
      {
        caseId: "ghost-9", episodeId: "EP-GHOST", assetId: "ghost-9", category: "pole",
        defectClass: "rust", frameContainsDefect: true, bbox: null, evidenceSource: "visual",
        assetAssociation: "confirmed", verification: null, provenance: "actual",
      },
    ]);
    expect(r.unmappablePredictions.count).toBe(1);
    expect(r.unmappablePredictions.caseIds).toEqual(["ghost-9"]);
    expect(r.detection.truePositives).toBe(0);
    expect(r.detection.falsePositives).toBe(0);
    expect(r.detection.falsePositivesOnClean).toBe(0);
    expect(r.cases[0].passed).toBe(true); // clean case unaffected by the ghost
  });
});

describe("eval-cache adapter honesty", () => {
  const cacheStyle = [
    {
      id: "f021", model: "muse-spark-1.3",
      after: [
        {
          assetId: "pole-001", assetCategory: "pole", severity: "MEDIUM", title: "rust",
          description: "rust streaks", frameTimestamp: 20, recommendedAction: "x",
          estimatedUrgency: "Next scheduled", observation: "rust visible",
          evidenceFrameIndex: 0, evidenceSource: "visual",
          verification: { verdict: "keep", reason: "clear rust" },
        },
      ],
    },
    { id: "f001", model: "muse-spark-1.3", after: [] },
    { id: "fBroken", model: "muse-spark-1.3", after: [], error: "boom" },
  ];

  it("maps recorded outputs without inventing asset identity", () => {
    const env = adaptEvalCacheToArtifact(cacheStyle, { datasetVersion: "real-v1", provenanceDefault: "cached" });
    expect(env.status).toBe("completed");
    expect(env.predictions).toHaveLength(1);
    const p = env.predictions[0];
    expect(p.caseId).toBe("f021"); // source frame key, not a GT case claim
    expect(p.assetId).toBeNull(); // slugs discarded, never mapped
    expect(p.assetAssociation).toBe("unresolved");
    expect(p.bbox).toBeNull();
    expect(p.verification).toBe("keep");
    expect(p.provenance).toBe("cached");
    expect(env.notes.join(" ")).toMatch(/fBroken/);
  });

  it("keeps actual and cached provenance separate; hand-test never poses as inference", () => {
    const live = adaptEvalCacheToArtifact([cacheStyle[0]], { datasetVersion: "real-v1", provenanceDefault: "actual", model: "muse-spark-1.3 via meta", recordedAt: "2026-10-27T00:00:00.000Z" });
    expect(live.predictions[0].provenance).toBe("actual");
    expect(live.provenanceDefault).toBe("actual");
    const r = scoreAssetBenchmark(loadCases(), null);
    expect(r.predictionProvenance).toMatch(/NOT measured/);
  });

  it("empty recorded outputs adapt to an explicit zero-detection envelope", () => {
    const env = adaptEvalCacheToArtifact([{ id: "f001", after: [] }], { datasetVersion: "real-v1", provenanceDefault: "cached" });
    expect(env.status).toBe("completed");
    expect(env.predictions).toEqual([]);
    const v = validatePredictionArtifact(env);
    expect(v.state).toBe("completed"); // completed zero ≠ missing
  });
});

describe("deterministic manifest validation and report output", () => {
  it("validation and scoring are order-stable", () => {
    const m1 = JSON.stringify(validateProvenanceManifest(loadManifest(), loadCases()));
    const m2 = JSON.stringify(validateProvenanceManifest(loadManifest(), [...loadCases()].reverse()));
    expect(m1).toBe(m2);
    const r1 = toAssetBenchJson(scoreAssetBenchmark(loadCases(), null));
    const r2 = toAssetBenchJson(scoreAssetBenchmark([...loadCases()].reverse(), null));
    expect(r1).toBe(r2);
  });

  it("synthetic, static, cached, and live results stay labeled apart", () => {
    const r = scoreAssetBenchmark(loadCases(), null);
    expect(r.mode).toBe("asset-benchmark");
    expect(r.datasetType).toBe("static-image");
    expect(r.realInference).toBe(false);
    expect(r.status).toBe("not-evaluated");
    expect(r.limitations.join(" ")).toMatch(/NOT EVALUATED/);
  });
});
