import { describe, expect, it } from "vitest";
import {
  computeAssetReview,
  computeEvidenceCoverage,
  needsHumanReview,
  validateReport,
} from "../report";
import { buildReportCsv } from "../export";
import type { Defect, TrackedObject } from "../types";

const obj = (id: string, ts: number[]): TrackedObject => ({
  id,
  sessionId: "s",
  category: "insulator",
  color: "#fff",
  firstSeenFrame: 0,
  lastSeenFrame: ts.length,
  totalFrameCount: ts.length,
  frames: ts.map((t, i) => ({
    frameIndex: i,
    timestamp: t,
    bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    confidence: 1,
  })),
});

const defect = (id: string, patch: Partial<Defect> = {}): Defect => ({
  id,
  assetId: "insulator-001",
  assetCategory: "insulator",
  severity: "HIGH",
  title: "t",
  description: "d",
  frameTimestamp: 5,
  recommendedAction: "fix",
  estimatedUrgency: "Monitor",
  ...patch,
});

describe("honest coverage ledger", () => {
  it("populates extended breakdown fields for new reports", () => {
    const cov = computeEvidenceCoverage(
      [obj("a-001", [5]), obj("b-001", [50])],
      [{ timestamp: 5, base64: "AAA" }],
      [
        defect("v", { evidenceSource: "visual", verification: { verdict: "keep", reason: "ok" } }),
        defect("s", { evidenceSource: "voice", assetAssociation: "unresolved" }),
      ],
    );
    expect(cov.totalAssetsTracked).toBe(2);
    expect(cov.assetsRepresented).toBe(1);
    expect(cov.assetsNotRepresented).toBe(1);
    expect(cov.visualFindings).toBe(1);
    expect(cov.voiceOnlyFindings).toBe(1);
    expect(cov.verificationKept).toBe(1);
    expect(cov.verificationSkipped).toBe(0);
    expect(cov.unresolvedAssociations).toBe(1);
  });

  it("empty findings produce zero ledger — never proof of defect-free", () => {
    const cov = computeEvidenceCoverage([obj("a-001", [5])], [{ timestamp: 5, base64: "A" }], []);
    expect(cov.visualFindings).toBe(0);
    expect(cov.voiceOnlyFindings).toBe(0);
    expect(cov.verificationSkipped).toBe(0);
    expect(cov.needsReview).toBe(0);
  });

  it("skipped verification keeps the finding (never deletes)", () => {
    const cov = computeEvidenceCoverage(
      [obj("a-001", [5])],
      [{ timestamp: 5, base64: "A" }],
      [defect("v", { evidenceSource: "visual", verification: { verdict: "skipped", reason: "boom" } })],
    );
    expect(cov.verificationSkipped).toBe(1);
    expect(cov.visualFindings).toBe(1);
  });

  it("old fixtures without extended fields still validate (backwards compat)", () => {
    const legacy = {
      id: "rep-1",
      sessionId: "s1",
      inspection: {
        substationId: "sub",
        substationName: "East",
        date: "2026-01-01",
        inspector: "Carlos",
        totalAssetsTracked: 1,
        totalDefectsFound: 0,
        coveragePercent: 100,
      },
      summary: "ok",
      defects: [],
      statistics: { critical: 0, high: 0, medium: 0, low: 0, byCategory: {} },
      evidenceCoverage: {
        totalAssetsTracked: 1,
        assetsRepresented: 1,
        visualFindings: 0,
        voiceOnlyFindings: 0,
        verificationSkipped: 0,
      },
      generatedAt: "2026-01-01T00:00:00Z",
    };
    expect(() => validateReport(legacy, { id: "rep-1", sessionId: "s1" })).not.toThrow();
  });
});

describe("needsHumanReview", () => {
  it("flags unresolved association even when AI re-checked", () => {
    expect(
      needsHumanReview(
        defect("u", {
          evidenceSource: "visual",
          assetAssociation: "unresolved",
          verification: { verdict: "keep", reason: "ok" },
        }),
      ),
    ).toBe(true);
  });

  it("flags visual findings without a re-check verdict", () => {
    expect(needsHumanReview(defect("v", { evidenceSource: "visual" }))).toBe(true);
  });

  it("flags high-severity voice-only claims", () => {
    expect(
      needsHumanReview(defect("h", { evidenceSource: "voice", severity: "CRITICAL" })),
    ).toBe(true);
  });

  it("does not flag kept + confirmed visual findings", () => {
    expect(
      needsHumanReview(
        defect("ok", {
          evidenceSource: "visual",
          assetAssociation: "confirmed",
          verification: { verdict: "keep", reason: "ok" },
        }),
      ),
    ).toBe(false);
  });

  it("reviewed findings stop needing review", () => {
    expect(
      needsHumanReview(
        defect("r", {
          evidenceSource: "visual",
          assetAssociation: "unresolved",
          verification: { verdict: "skipped", reason: "x" },
          humanReview: { status: "confirmed", updatedAt: "2026-01-01T00:00:00Z" },
        }),
      ),
    ).toBe(false);
    expect(
      needsHumanReview(
        defect("n", {
          evidenceSource: "voice",
          severity: "LOW",
          humanReview: { status: "needs-inspection", updatedAt: "2026-01-01T00:00:00Z" },
        }),
      ),
    ).toBe(true);
  });
});

describe("computeAssetReview", () => {
  it("marks represented vs not-represented honestly", () => {
    const out = computeAssetReview(
      [obj("a-001", [5]), obj("b-001", [50])],
      [{ timestamp: 5, base64: "A" }],
      [defect("d1", { assetId: "a-001", evidenceSource: "visual", verification: { verdict: "keep", reason: "ok" }, assetAssociation: "confirmed" })],
    );
    const a = out.find((r) => r.assetId === "a-001");
    const b = out.find((r) => r.assetId === "b-001");
    expect(a?.representedInEvidence).toBe(true);
    expect(a?.states).toContain("Evidence represented");
    expect(b?.representedInEvidence).toBe(false);
    expect(b?.states).toContain("Not represented in selected evidence");
    expect(b?.findingCount).toBe(0);
  });

  it("never borrows another asset's box: unresolved stays unresolved", () => {
    const out = computeAssetReview(
      [obj("a-001", [5])],
      [{ timestamp: 5, base64: "A" }],
      [defect("ghost", { assetId: "ghost-001", evidenceSource: "visual" })],
    );
    // ghost asset is not a tracked object → no review row for it; tracked asset has no findings.
    expect(out).toHaveLength(1);
    expect(out[0].findingCount).toBe(0);
  });
});

describe("human review validation + CSV integrity", () => {
  it("accepts a valid human review through validateReport", () => {
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
      summary: "s",
      defects: [
        {
          ...defect("d1"),
          evidenceSource: "visual",
          humanReview: { status: "confirmed", note: "seen on site", updatedAt: "2026-01-02T00:00:00Z" },
        },
      ],
      statistics: { critical: 0, high: 1, medium: 0, low: 0, byCategory: {} },
      generatedAt: "2026-01-01T00:00:00Z",
    };
    const out = validateReport(base, { id: "rep-1", sessionId: "s1" });
    expect(out.defects[0].humanReview?.status).toBe("confirmed");
  });

  it("rejects invalid human review status", () => {
    const bad = {
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
      summary: "s",
      defects: [
        { ...defect("d1"), humanReview: { status: "maybe", updatedAt: "x" } },
      ],
      statistics: { critical: 0, high: 1, medium: 0, low: 0, byCategory: {} },
      generatedAt: "2026-01-01T00:00:00Z",
    };
    expect(() => validateReport(bad, { id: "rep-1", sessionId: "s1" })).toThrow();
  });

  it("CSV export ignores human review but keeps evidence provenance", () => {
    const report = {
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
      summary: "s",
      defects: [
        {
          ...defect("d1"),
          evidenceSource: "visual" as const,
          observation: "rust",
          humanReview: { status: "confirmed" as const, updatedAt: "2026-01-02T00:00:00Z" },
        },
      ],
      statistics: { critical: 0, high: 1, medium: 0, low: 0, byCategory: {} },
      generatedAt: "2026-01-01T00:00:00Z",
    };
    const csv = buildReportCsv(report);
    expect(csv).toContain("visual");
    expect(csv).toContain("rust");
  });
});
