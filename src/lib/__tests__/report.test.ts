import { describe, expect, it } from "vitest";
import {
  attachFrameCaptures,
  coveragePercent,
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
