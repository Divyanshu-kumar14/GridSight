import { describe, expect, it } from "vitest";
import { buildReportCsv, reportCsvFilename } from "../export";
import type { DefectReport } from "../types";

const report = (titles: string[]): DefectReport => ({
  id: "rep-1",
  sessionId: "s1",
  inspection: {
    substationId: "sub",
    substationName: "East",
    date: "2026-01-01",
    inspector: "Carlos",
    totalAssetsTracked: 2,
    totalDefectsFound: titles.length,
    coveragePercent: 100,
  },
  summary: "s",
  defects: titles.map((t, i) => ({
    id: `d${i}`,
    assetId: "insulator-001",
    assetCategory: "insulator",
    severity: "HIGH" as const,
    title: t,
    description: "d",
    frameTimestamp: i,
    recommendedAction: "Fix, monitor",
    estimatedUrgency: "Monitor" as const,
  })),
  statistics: { critical: 0, high: titles.length, medium: 0, low: 0, byCategory: {} },
  generatedAt: "2026-01-01T00:00:00Z",
});

describe("buildReportCsv", () => {
  it("emits header + rows", () => {
    const csv = buildReportCsv(report(["Corrosion"]));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("id,assetId,assetCategory,severity,title,frameTimestamp,recommendedAction,urgency,voiceNoteExcerpt");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Corrosion");
  });

  it("quotes commas and doubles quotes", () => {
    const csv = buildReportCsv(report(['Bad "rust", spreading']));
    expect(csv).toContain('"Bad ""rust"", spreading"');
    expect(csv).toContain('"Fix, monitor"');
  });

  it("header-only for empty defects", () => {
    expect(buildReportCsv(report([])).trim().split("\n")).toHaveLength(1);
  });
});

describe("reportCsvFilename", () => {
  it("uses session prefix", () => {
    expect(reportCsvFilename("abcdef123")).toBe("gridsight-report-abcdef12.csv");
  });
});
