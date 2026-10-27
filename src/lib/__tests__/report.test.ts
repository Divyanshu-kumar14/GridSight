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
  it("prefers mentioned objects, caps at 8", () => {
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
    const objs = Array.from({ length: 12 }, (_, i) => mk(i));
    const out = pickKeyTimestamps(objs as never, [
      { matchedAssetId: "insulator-011" },
    ] as never);
    expect(out).toHaveLength(8);
    expect(out[0]).toBe(11); // mentioned object first
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

describe("attachOverlayBox", () => {
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

  it("picks nearest-frame bbox by asset id, falls back to category", () => {
    const byId = attachOverlayBox(
      [{ ...defect("a", "HIGH"), assetId: "insulator-003", frameTimestamp: 19 }],
      objs as never,
    );
    expect(byId[0].overlayBox).toEqual({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 });
    const byCat = attachOverlayBox(
      [{ ...defect("b", "HIGH"), assetId: "nope", assetCategory: "insulator", frameTimestamp: 1 }],
      objs as never,
    );
    expect(byCat[0].overlayBox).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  it("leaves defects untouched with no matching object", () => {
    const out = attachOverlayBox([defect("c", "HIGH")], []);
    expect(out[0].overlayBox).toBeUndefined();
  });
});
