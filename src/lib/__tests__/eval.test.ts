import { describe, expect, it } from "vitest";
import {
  matchDefect,
  parseEvalDefects,
  score,
  toDefect,
  type FrameResult,
} from "../../../scripts/eval-lib";
import type { Defect } from "../types";

const defect = (id: string, category: string): Defect => ({
  id,
  assetId: `${category}-001`,
  assetCategory: category,
  severity: "HIGH",
  title: "t",
  description: "d",
  frameTimestamp: 1,
  recommendedAction: "fix",
  estimatedUrgency: "Monitor",
});

const run = (
  id: string,
  truth: FrameResult["truth"],
  before: Defect[],
  after: Defect[] = before,
): FrameResult => ({ id, truth, reported: after, reportedBeforeVerify: before });

describe("score", () => {
  it("returns undefined ratios as null, never NaN or a fake zero, on empty input", () => {
    expect(score([], "before")).toEqual({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: null,
      recall: null,
    });
    expect(score([], "after")).toEqual({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: null,
      recall: null,
    });
  });

  it("scores a perfect match as 1.0 / 1.0", () => {
    const runs = [run("f1", [{ category: "insulator", defect: "cracked_skirt" }], [defect("d1", "insulator")])];
    expect(score(runs, "before")).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
    });
  });

  it("counts every unmatched report on a clean frame as a false positive", () => {
    const runs = [
      run("f1", [], [defect("d1", "insulator"), defect("d2", "transformer")]),
      run("f2", [], []),
    ];
    const m = score(runs, "before");
    expect(m.truePositives).toBe(0);
    expect(m.falsePositives).toBe(2);
    expect(m.falseNegatives).toBe(0);
    expect(m.precision).toBe(0);
    expect(m.recall).toBeNull(); // nothing to find → undefined, not 0
  });

  it("does not double-count duplicate truth entries", () => {
    const runs = [
      run(
        "f1",
        [
          { category: "pole", defect: "rust" },
          { category: "pole", defect: "rust" },
        ],
        [defect("d1", "pole")],
      ),
    ];
    const m = score(runs, "before");
    expect(m.truePositives).toBe(1);
    expect(m.falseNegatives).toBe(1);
  });

  it("separates before and after modes", () => {
    const runs = [
      run(
        "f1",
        [{ category: "pole", defect: "rust" }],
        [defect("d1", "pole"), defect("d2", "transformer")],
        [defect("d1", "pole")],
      ),
    ];
    expect(score(runs, "before").falsePositives).toBe(1);
    expect(score(runs, "after").falsePositives).toBe(0);
    expect(score(runs, "after").precision).toBe(1);
  });
});

describe("matchDefect", () => {
  it("matches case-insensitively", () => {
    expect(matchDefect(defect("d", "Insulator"), [{ category: "insulator", defect: "x" }])).toBe(true);
  });

  it("matches on substring in either direction", () => {
    expect(matchDefect(defect("d", "steel pole"), [{ category: "pole", defect: "rust" }])).toBe(true);
    expect(matchDefect(defect("d", "pole"), [{ category: "steel pole", defect: "rust" }])).toBe(true);
  });

  it("rejects non-matches and empty categories", () => {
    expect(matchDefect(defect("d", "transformer"), [{ category: "pole", defect: "rust" }])).toBe(false);
    expect(matchDefect(defect("d", ""), [{ category: "pole", defect: "rust" }])).toBe(false);
    expect(matchDefect(defect("d", "pole"), [{ category: "", defect: "rust" }])).toBe(false);
    expect(matchDefect(defect("d", "pole"), [])).toBe(false);
  });
});

describe("parseEvalDefects", () => {
  const one = [{ category: "pole", defect: "rust", severity: "HIGH", observation: "Rust streaks run down the pole." }];

  it("reads the documented envelope", () => {
    expect(parseEvalDefects(JSON.stringify({ defects: one }))).toEqual(one);
  });

  it("reads a bare array", () => {
    expect(parseEvalDefects(JSON.stringify(one))).toEqual(one);
  });

  it("reads fenced JSON", () => {
    expect(parseEvalDefects("```json\n" + JSON.stringify({ defects: one }) + "\n```")).toEqual(one);
  });

  it("reads JSON wrapped in prose", () => {
    expect(parseEvalDefects(`Sure. ${JSON.stringify({ defects: one })} Done.`)).toEqual(one);
  });

  it("returns an empty array for a clean frame", () => {
    expect(parseEvalDefects('{"defects":[]}')).toEqual([]);
  });

  it("throws on unparseable or off-schema output", () => {
    expect(() => parseEvalDefects("not json at all")).toThrow();
    expect(() => parseEvalDefects('{"defects":[{"category":"pole"}]}')).toThrow();
    expect(() => parseEvalDefects('{"defects":[{"category":"pole","defect":"rust","severity":"SEVERE","observation":"x"}]}')).toThrow();
  });
});

describe("toDefect", () => {
  const raw = { category: "Steel Pole", defect: "rust", severity: "CRITICAL" as const, observation: "Rust on the shaft." };

  it("maps to a Defect the scorer can match", () => {
    const d = toDefect(raw, 12.5, "f021-1");
    expect(d.assetCategory).toBe("Steel Pole");
    expect(d.assetId).toBe("steel-pole-001");
    expect(d.frameTimestamp).toBe(12.5);
    expect(d.severity).toBe("CRITICAL");
    expect(d.estimatedUrgency).toBe("Immediate");
    expect(matchDefect(d, [{ category: "pole", defect: "rust" }])).toBe(true);
  });

  it("cites frame 0 so verification can audit it", () => {
    expect(toDefect(raw, 0, "x").evidenceFrameIndex).toBe(0);
    expect(toDefect(raw, 0, "x").observation).toBe("Rust on the shaft.");
  });

  it("falls back to a safe slug for unusable categories", () => {
    expect(toDefect({ ...raw, category: "!!!" }, 0, "x").assetId).toBe("asset-001");
  });
});
