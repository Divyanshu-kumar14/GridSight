import { describe, expect, it } from "vitest";
import {
  attachFrameCaptures,
  attachOverlayBox,
  coveragePercent,
  labelEvidence,
  pickKeyTimestamps,
  rollupStats,
  sortDefects,
  validateDefects,
  validateReport,
} from "../report";
import type { Defect } from "../types";

const defect = (id: string, severity: Defect["severity"], cat = "insulator", t = 5): Defect => ({
  id,
  assetId: `${cat}-001`,
  assetCategory: cat,
  severity,
  title: `${severity} issue`,
  description: "detail",
  frameTimestamp: t,
  recommendedAction: "fix it",
  estimatedUrgency: severity === "CRITICAL" ? "Immediate" : "Monitor",
});

describe("sortDefects", () => {
  it("orders CRITICAL > HIGH > MEDIUM > LOW", () => {
    const out = sortDefects([
      defect("l", "LOW"),
      defect("c", "CRITICAL"),
      defect("m", "MEDIUM"),
      defect("h", "HIGH"),
    ]).map((d) => d.severity);
    expect(out).toEqual(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
  });

  it("handles empty input", () => {
    expect(sortDefects([])).toEqual([]);
  });
});

describe("rollupStats", () => {
  it("counts severities and categories accurately", () => {
    const stats = rollupStats([
      defect("a", "CRITICAL", "insulator"),
      defect("b", "HIGH", "insulator"),
      defect("c", "LOW", "transformer"),
    ]);
    expect(stats).toEqual({
      critical: 1,
      high: 1,
      medium: 0,
      low: 1,
      byCategory: { insulator: 2, transformer: 1 },
    });
  });

  it("zeroes on empty", () => {
    expect(rollupStats([])).toEqual({ critical: 0, high: 0, medium: 0, low: 0, byCategory: {} });
  });
});

describe("coveragePercent", () => {
  const obj = (frames: number) => ({
    id: "x",
    sessionId: "s",
    category: "insulator",
    color: "#fff",
    firstSeenFrame: 0,
    lastSeenFrame: frames,
    totalFrameCount: frames,
    frames: Array.from({ length: frames }, (_, i) => ({
      frameIndex: i,
      timestamp: i,
      bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
      confidence: 1,
    })),
  });

  it("counts stable tracks (≥3 frames)", () => {
    expect(coveragePercent([obj(5), obj(1), obj(4), obj(2)] as never)).toBe(50);
  });

  it("is 0 with no objects, 100 when all stable", () => {
    expect(coveragePercent([])).toBe(0);
    expect(coveragePercent([obj(3)] as never)).toBe(100);
  });
});

describe("attachFrameCaptures", () => {
  it("attaches nearest frame by timestamp, keeps existing captures", () => {
    const frames = [
      { timestamp: 10, base64: "AAA" },
      { timestamp: 30, base64: "BBB" },
    ];
    const keep = { ...defect("k", "HIGH", "insulator", 29), frameCapture: "OWN" };
    const out = attachFrameCaptures([defect("a", "HIGH", "insulator", 12), keep], frames);
    expect(out[0].frameCapture).toBe("AAA");
    expect(out[1].frameCapture).toBe("OWN");
  });

  it("leaves defects untouched with no frames", () => {
    const out = attachFrameCaptures([defect("a", "LOW")], []);
    expect(out[0].frameCapture).toBeUndefined();
  });
});

describe("pickKeyTimestamps", () => {
  const mk = (i: number) => ({
    id: `insulator-${String(i).padStart(3, "0")}`,
    sessionId: "s",
    category: "insulator",
    color: "#fff",
    firstSeenFrame: i,
    lastSeenFrame: i + 1,
    totalFrameCount: 2,
    frames: [{ frameIndex: i, timestamp: i, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 }],
  });

  it("prefers mentioned objects, caps at 8, returns chronological order", () => {
    const objs = Array.from({ length: 12 }, (_, i) => mk(i));
    const out = pickKeyTimestamps(objs as never, [
      { matchedAssetId: "insulator-011" },
    ] as never);
    expect(out).toHaveLength(8);
    expect(out).toContain(11); // mentioned object included
    expect([...out].sort((a, b) => a - b)).toEqual(out); // stable chronological mapping
  });

  it("selects a later frame relevant to a voice note, not first-seen", () => {
    const obj = {
      id: "insulator-001",
      sessionId: "s",
      category: "insulator",
      color: "#fff",
      firstSeenFrame: 0,
      lastSeenFrame: 20,
      totalFrameCount: 3,
      frames: [
        { frameIndex: 0, timestamp: 0, bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, confidence: 1 },
        { frameIndex: 10, timestamp: 10, bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, confidence: 1 },
        { frameIndex: 20, timestamp: 20, bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, confidence: 1 },
      ],
    };
    const out = pickKeyTimestamps([obj] as never, [
      { matchedAssetId: "insulator-001", startTime: 18, endTime: 22, matchConfidence: 0.9 },
    ] as never);
    expect(out).toEqual([20]);
  });

  it("uses the median track frame for unmentioned assets, not first-seen", () => {
    const obj = {
      id: "pole-001",
      sessionId: "s",
      category: "pole",
      color: "#fff",
      firstSeenFrame: 0,
      lastSeenFrame: 30,
      totalFrameCount: 3,
      frames: [
        { frameIndex: 0, timestamp: 0, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 },
        { frameIndex: 15, timestamp: 15, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 },
        { frameIndex: 30, timestamp: 30, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 },
      ],
    };
    expect(pickKeyTimestamps([obj] as never, [] as never)).toEqual([15]);
  });

  it("dedupes near-identical timestamps", () => {
    const mkAt = (id: string, t: number) => ({
      id,
      sessionId: "s",
      category: "insulator",
      color: "#fff",
      firstSeenFrame: 0,
      lastSeenFrame: 1,
      totalFrameCount: 1,
      frames: [{ frameIndex: 0, timestamp: t, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 }],
    });
    const out = pickKeyTimestamps(
      [mkAt("a-001", 5), mkAt("b-001", 5.2)] as never,
      [
        { matchedAssetId: "a-001", startTime: 5, endTime: 5.5, matchConfidence: 0.9 },
        { matchedAssetId: "b-001", startTime: 5, endTime: 5.5, matchConfidence: 0.5 },
      ] as never,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(5);
  });

  it("handles missing transcripts and unmatched notes without crashing", () => {
    const objs = [mk(0), mk(1)];
    expect(pickKeyTimestamps(objs as never, [] as never)).toHaveLength(2);
    expect(
      pickKeyTimestamps(objs as never, [{ matchedAssetId: null }] as never),
    ).toHaveLength(2);
    expect(
      pickKeyTimestamps(objs as never, [{ matchedAssetId: "ghost-999" }] as never),
    ).toHaveLength(2);
    expect(pickKeyTimestamps(objs as never, undefined as never)).toHaveLength(2);
  });

  it("returns no invalid frames for empty tracking", () => {
    expect(pickKeyTimestamps([], [{ matchedAssetId: "a-001" }] as never)).toEqual([]);
    expect(pickKeyTimestamps([] as never, [] as never)).toEqual([]);
  });

  it("ignores invalid observations and timestamps safely", () => {
    const bad = {
      id: "bad-001",
      sessionId: "s",
      category: "insulator",
      color: "#fff",
      firstSeenFrame: 0,
      lastSeenFrame: 1,
      totalFrameCount: 2,
      frames: [
        { frameIndex: 0, timestamp: NaN, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 },
        { frameIndex: 1, timestamp: 5, bbox: { x: 2, y: 2, w: -1, h: 0 }, confidence: 1 },
      ],
    };
    const good = mk(10);
    const out = pickKeyTimestamps([bad, good] as never, [] as never);
    expect(out).toEqual([10]);
  });

  it("spreads across the timeline instead of clustering at the start", () => {
    const objs = Array.from({ length: 10 }, (_, i) => mk(i * 10));
    const out = pickKeyTimestamps(objs as never, [] as never);
    expect(out).toHaveLength(8);
    expect(Math.max(...out) - Math.min(...out)).toBeGreaterThan(10);
  });

  it("keeps evidence indices mapped to the exact frame order", () => {
    const obj = {
      id: "insulator-001",
      sessionId: "s",
      category: "insulator",
      color: "#fff",
      firstSeenFrame: 0,
      lastSeenFrame: 20,
      totalFrameCount: 3,
      frames: [
        { frameIndex: 0, timestamp: 0, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 },
        { frameIndex: 10, timestamp: 10, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 },
        { frameIndex: 20, timestamp: 20, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 },
      ],
    };
    const stamps = pickKeyTimestamps([obj] as never, [
      { matchedAssetId: "insulator-001", startTime: 19, endTime: 21, matchConfidence: 1 },
    ] as never);
    const frames = stamps.map((t, i) => ({ timestamp: t, base64: `F${i}` }));
    const d = {
      ...defect("v", "HIGH", "insulator", 20),
      evidenceFrameIndex: 0,
      observation: "rust",
    };
    const labeled = labelEvidence([d], frames);
    expect(labeled[0].evidenceSource).toBe("visual");
    // Cited index resolves to the same timestamp that was selected.
    expect(frames[labeled[0].evidenceFrameIndex as number].timestamp).toBe(stamps[0]);
    expect(labeled[0].frameCapture).toBe(frames[0].base64);
  });
});

describe("validateReport", () => {
  const base = {
    id: "rep-1",
    sessionId: "s1",
    inspection: {
      substationId: "sub",
      substationName: "East",
      date: "2026-01-01",
      inspector: "Carlos",
      totalAssetsTracked: 1,
      totalDefectsFound: 1,
      coveragePercent: 100,
    },
    summary: "One issue found.",
    defects: [{ ...defect("d1", "HIGH") }],
    statistics: { critical: 0, high: 1, medium: 0, low: 0, byCategory: { insulator: 1 } },
    generatedAt: "2026-01-01T00:00:00Z",
  };

  it("accepts a full valid report", () => {
    expect(validateReport(base, { id: "rep-1", sessionId: "s1" }).defects).toHaveLength(1);
  });

  it("rejects hallucinated severity", () => {
    expect(() =>
      validateReport(
        { ...base, defects: [{ ...defect("d1", "HIGH"), severity: "URGENT" }] },
        { id: "rep-1", sessionId: "s1" },
      ),
    ).toThrow();
  });

  it("rejects defects missing required fields", () => {
    expect(() =>
      validateReport({ ...base, defects: [{ id: "x" }] }, { id: "rep-1", sessionId: "s1" }),
    ).toThrow();
  });

  it("rejects empty object", () => {
    expect(() => validateReport({}, { id: "rep-1", sessionId: "s1" })).toThrow();
  });
});

describe("validateDefects (envelope-tolerant)", () => {
  const defect = {
    id: "d1",
    assetId: "a-001",
    assetCategory: "insulator",
    severity: "HIGH",
    title: "t",
    description: "d",
    frameTimestamp: 5,
    recommendedAction: "fix",
    estimatedUrgency: "Monitor",
  };

  it("accepts a bare array and {defects} without an envelope", () => {
    expect(validateDefects([defect])).toHaveLength(1);
    expect(validateDefects({ defects: [defect] })).toHaveLength(1);
  });

  it("rejects bad defects without requiring the envelope", () => {
    expect(() => validateDefects([{ ...defect, severity: "URGENT" }])).toThrow();
    expect(() => validateDefects({ nope: true })).toThrow();
    expect(() => validateDefects([])).not.toThrow();
  });
});

describe("labelEvidence (server-side, never trusts the model)", () => {
  const frames = [
    { timestamp: 10, base64: "AAA" },
    { timestamp: 20, base64: "BBB" },
  ];

  it("marks visual only with valid frame index + observation, pins cited frame", () => {
    const d = {
      ...defect("v", "HIGH", "insulator", 19),
      evidenceFrameIndex: 1,
      observation: "rust at cap",
      evidenceSource: "visual" as const,
      frameCapture: "WRONG",
    };
    const out = labelEvidence([d], frames);
    expect(out[0].evidenceSource).toBe("visual");
    expect(out[0].frameCapture).toBe("BBB"); // pinned to cited frame, model value overwritten
  });

  it("marks voice when index is out of range, observation missing, or both absent", () => {
    const badIdx = { ...defect("b", "HIGH"), evidenceFrameIndex: 9, observation: "x" };
    const noObs = { ...defect("c", "HIGH"), evidenceFrameIndex: 0 };
    const none = defect("n", "HIGH");
    const out = labelEvidence([badIdx, noObs, none], frames);
    expect(out.map((d) => d.evidenceSource)).toEqual(["voice", "voice", "voice"]);
  });

  it("model-claimed visual with no frames resolves to voice", () => {
    const d = { ...defect("z", "HIGH"), evidenceFrameIndex: 0, observation: "x" };
    expect(labelEvidence([d], [])[0].evidenceSource).toBe("voice");
  });
});

describe("sortDefects visual-first", () => {
  it("orders visual before voice within the same severity", () => {
    const voice = { ...defect("v", "HIGH"), evidenceSource: "voice" as const };
    const visual = { ...defect("s", "HIGH"), evidenceSource: "visual" as const };
    expect(sortDefects([voice, visual]).map((d) => d.id)).toEqual(["s", "v"]);
  });

  it("severity still dominates evidence source", () => {
    const voiceCrit = { ...defect("c", "CRITICAL"), evidenceSource: "voice" as const };
    const visualLow = { ...defect("l", "LOW"), evidenceSource: "visual" as const };
    expect(sortDefects([visualLow, voiceCrit]).map((d) => d.id)).toEqual(["c", "l"]);
  });
});

describe("attachOverlayBox (exact ID only, never category fallback)", () => {
  const objs = [
    {
      id: "insulator-003",
      sessionId: "s",
      category: "insulator",
      color: "#fff",
      firstSeenFrame: 0,
      lastSeenFrame: 20,
      totalFrameCount: 2,
      frames: [
        { frameIndex: 0, timestamp: 0, bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, confidence: 1 },
        { frameIndex: 20, timestamp: 20, bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, confidence: 1 },
      ],
    },
  ];

  it("attaches the nearest-frame bbox for an exact asset id", () => {
    const byId = attachOverlayBox(
      [{ ...defect("a", "HIGH"), assetId: "insulator-003", frameTimestamp: 19 }],
      objs as never,
    );
    expect(byId[0].overlayBox).toEqual({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 });
    expect(byId[0].assetAssociation).toBe("confirmed");
  });

  it("never borrows another object's box for an unknown id", () => {
    const out = attachOverlayBox(
      [{ ...defect("b", "HIGH"), assetId: "nope", assetCategory: "insulator", frameTimestamp: 1 }],
      objs as never,
    );
    expect(out[0].overlayBox).toBeUndefined();
    expect(out[0].assetAssociation).toBe("unresolved");
  });

  it("does not cross-associate assets sharing a category", () => {
    const two = [
      {
        id: "insulator-001",
        sessionId: "s",
        category: "insulator",
        color: "#fff",
        firstSeenFrame: 0,
        lastSeenFrame: 1,
        totalFrameCount: 1,
        frames: [{ frameIndex: 0, timestamp: 0, bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, confidence: 1 }],
      },
      {
        id: "insulator-002",
        sessionId: "s",
        category: "insulator",
        color: "#fff",
        firstSeenFrame: 0,
        lastSeenFrame: 1,
        totalFrameCount: 1,
        frames: [{ frameIndex: 0, timestamp: 0, bbox: { x: 0.7, y: 0.7, w: 0.1, h: 0.1 }, confidence: 1 }],
      },
    ];
    const out = attachOverlayBox(
      [{ ...defect("c", "HIGH"), assetId: "insulator-002", assetCategory: "insulator", frameTimestamp: 0 }],
      two as never,
    );
    expect(out[0].overlayBox).toEqual({ x: 0.7, y: 0.7, w: 0.1, h: 0.1 });
    expect(out[0].assetAssociation).toBe("confirmed");
  });

  it("preserves an unresolved finding instead of deleting it", () => {
    const d = {
      ...defect("u", "HIGH"),
      assetId: "ghost-001",
      evidenceSource: "visual" as const,
      observation: "rust",
      evidenceFrameIndex: 0,
    };
    const out = attachOverlayBox([d], objs as never);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("u");
    expect(out[0].evidenceSource).toBe("visual"); // association never demotes evidence
    expect(out[0].assetAssociation).toBe("unresolved");
    expect(out[0].overlayBox).toBeUndefined();
  });

  it("never renders an invalid bounding box", () => {
    const badObjs = [
      {
        id: "bad-001",
        sessionId: "s",
        category: "insulator",
        color: "#fff",
        firstSeenFrame: 0,
        lastSeenFrame: 1,
        totalFrameCount: 1,
        frames: [{ frameIndex: 0, timestamp: 0, bbox: { x: 5, y: 5, w: -1, h: 0 }, confidence: 1 }],
      },
    ];
    const out = attachOverlayBox(
      [{ ...defect("v", "HIGH"), assetId: "bad-001", frameTimestamp: 0 }],
      badObjs as never,
    );
    expect(out[0].overlayBox).toBeUndefined();
    expect(out[0].assetAssociation).toBe("unresolved");
  });

  it("uses the nearest observation within the same asset track", () => {
    const out = attachOverlayBox(
      [{ ...defect("n", "HIGH"), assetId: "insulator-003", frameTimestamp: 1 }],
      objs as never,
    );
    expect(out[0].overlayBox).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  it("marks empty tracking as unresolved without a box", () => {
    const out = attachOverlayBox([defect("c", "HIGH")], []);
    expect(out[0].overlayBox).toBeUndefined();
    expect(out[0].assetAssociation).toBe("unresolved");
  });

  it("keeps visual evidence when the asset link is unresolved", () => {
    const d = {
      ...defect("w", "HIGH"),
      assetId: "unknown-1",
      evidenceSource: "visual" as const,
      observation: "crack visible",
      evidenceFrameIndex: 0,
    };
    const out = attachOverlayBox([d], objs as never);
    expect(out[0].evidenceSource).toBe("visual");
    expect(out[0].observation).toBe("crack visible");
  });

  it("accepts the server-computed association field through validation", () => {
    const d = {
      ...defect("z", "HIGH"),
      assetId: "insulator-003",
      assetAssociation: "confirmed" as const,
      overlayBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    };
    expect(validateDefects([d])[0].assetAssociation).toBe("confirmed");
    const legacy = { ...defect("y", "HIGH") };
    delete (legacy as Partial<Defect>).assetAssociation;
    expect(validateDefects([legacy])[0].assetAssociation).toBeUndefined();
  });
});

describe("computeEvidenceCoverage", () => {
  it("computes honest counts from server data", async () => {
    const { computeEvidenceCoverage } = await import("../report");
    const objs = [
      {
        id: "a-001",
        sessionId: "s",
        category: "insulator",
        color: "#fff",
        firstSeenFrame: 0,
        lastSeenFrame: 1,
        totalFrameCount: 1,
        frames: [{ frameIndex: 0, timestamp: 5, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 }],
      },
      {
        id: "b-001",
        sessionId: "s",
        category: "pole",
        color: "#fff",
        firstSeenFrame: 0,
        lastSeenFrame: 1,
        totalFrameCount: 1,
        frames: [{ frameIndex: 0, timestamp: 50, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 }],
      },
    ];
    const frames = [{ timestamp: 5, base64: "AAA" }];
    const defects = [
      { ...defect("v", "HIGH"), evidenceSource: "visual" as const },
      { ...defect("s", "LOW"), evidenceSource: "voice" as const, verification: { verdict: "skipped" as const, reason: "x" } },
    ];
    const cov = computeEvidenceCoverage(objs as never, frames, defects);
    expect(cov.totalAssetsTracked).toBe(2);
    expect(cov.assetsRepresented).toBe(1);
    expect(cov.visualFindings).toBe(1);
    expect(cov.voiceOnlyFindings).toBe(1);
    // The visual defect has no verification verdict → counted as skipped.
    expect(cov.verificationSkipped).toBe(1);
  });
});
