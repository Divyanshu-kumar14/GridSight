import { describe, expect, it } from "vitest";
import { annotateDefects, buildAnnotationPrompt, selectAnnotatable } from "../images";
import type { Defect } from "../types";

const defect = (id: string, severity: Defect["severity"], withFrame: boolean): Defect => ({
  id,
  assetId: "insulator-001",
  assetCategory: "insulator",
  severity,
  title: "Corrosion",
  description: "Rust near cap",
  frameTimestamp: 5,
  ...(withFrame ? { frameCapture: "AAA" } : {}),
  recommendedAction: "Replace",
  estimatedUrgency: "Monitor",
});

describe("selectAnnotatable", () => {
  it("picks CRITICAL/HIGH with frames, severity-first, capped", () => {
    const defs = [
      defect("low", "LOW", true),
      defect("med", "MEDIUM", true),
      defect("high-noframe", "HIGH", false),
      defect("high", "HIGH", true),
      defect("crit", "CRITICAL", true),
    ];
    expect(selectAnnotatable(defs).map((d) => d.id)).toEqual(["crit", "high"]);
  });

  it("caps at 5", () => {
    const defs = Array.from({ length: 8 }, (_, i) => defect(`c${i}`, "CRITICAL", true));
    expect(selectAnnotatable(defs)).toHaveLength(5);
  });

  it("returns [] when nothing annotatable", () => {
    expect(selectAnnotatable([defect("a", "LOW", false)])).toEqual([]);
    expect(selectAnnotatable([])).toEqual([]);
  });
});

describe("buildAnnotationPrompt", () => {
  it("names asset, severity, and title", () => {
    const p = buildAnnotationPrompt(defect("x", "CRITICAL", true));
    expect(p).toMatch(/insulator-001/);
    expect(p).toMatch(/CRITICAL/);
    expect(p).toMatch(/Corrosion/);
  });
});

describe("annotateDefects", () => {
  it("attaches outputs, skips failures without throwing", async () => {
    const defs = [defect("crit", "CRITICAL", true), defect("high", "HIGH", true)];
    const out = await annotateDefects(defs, async (frame) => (frame === "AAA" ? "ZZZ" : null));
    expect(out.find((d) => d.id === "crit")?.annotatedImage).toBe("ZZZ");
  });

  it("leaves defects untouched when all edits fail", async () => {
    const defs = [defect("crit", "CRITICAL", true)];
    const out = await annotateDefects(defs, async () => {
      throw new Error("upstream down");
    });
    expect(out[0].annotatedImage).toBeUndefined();
  });

  it("is a no-op with no annotatable defects (editFn never called)", async () => {
    let called = 0;
    const out = await annotateDefects([defect("a", "LOW", false)], async () => {
      called++;
      return "x";
    });
    expect(called).toBe(0);
    expect(out).toHaveLength(1);
  });
});
