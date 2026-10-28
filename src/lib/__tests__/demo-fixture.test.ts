import { describe, expect, it } from "vitest";
import { buildTranscriptSegments } from "../audio";
import { demoReport, demoTagged, demoTracking, demoTranscript, loadDemoJson } from "../demo-fixture";
import { rollupStats, sortDefects, validateReport } from "../report";
import { validateTaggedNotes } from "../tagging";

// Golden-dataset guard: fixtures validate through our own schemas AND link up.
describe("demo fixtures", () => {
  it("tracking loads with stable structure", async () => {
    const objs = await demoTracking("s1");
    expect(objs).toHaveLength(6);
    expect(objs.every((o) => o.sessionId === "s1")).toBe(true);
    expect(objs.find((o) => o.id === "insulator-003")?.totalFrameCount).toBe(3);
  });

  it("transcript builds 3 diarized segments", async () => {
    const segs = await demoTranscript("s1");
    expect(segs).toHaveLength(3);
    expect(new Set(segs.map((s) => s.speaker)).size).toBeGreaterThanOrEqual(1);
    expect(segs[0].id).toBe("s1-seg-000");
  });

  it("tagged notes match transcript ids and tracked assets", async () => {
    const sid = "s1";
    const [segs, notes, objs] = await Promise.all([
      demoTranscript(sid),
      demoTagged(sid),
      demoTracking(sid),
    ]);
    expect(validateTaggedNotes(notes)).toHaveLength(3);
    const segIds = new Set(segs.map((s) => s.id));
    const assetIds = new Set(objs.map((o) => o.id));
    for (const n of notes) {
      expect(segIds.has(n.segmentId)).toBe(true);
      if (n.matchedAssetId) expect(assetIds.has(n.matchedAssetId)).toBe(true);
    }
    expect(notes.filter((n) => n.matchedAssetId).length).toBe(3);
  });

  it("report validates, sorts, and references real assets", async () => {
    const [report, objs] = await Promise.all([demoReport("s1"), demoTracking("s1")]);
    expect(validateReport(report, { id: report.id, sessionId: "s1" }).defects).toHaveLength(2);
    const assetIds = new Set(objs.map((o) => o.id));
    for (const d of report.defects) expect(assetIds.has(d.assetId)).toBe(true);
    expect(report.defects.map((d) => d.severity)).toEqual(
      sortDefects(report.defects).map((d) => d.severity),
    );
    const { verification: _v, ...statsCore } = report.statistics;
    void _v;
    expect(statsCore).toEqual(rollupStats(report.defects));
    expect(report.statistics.verification).toEqual({ kept: 1, downgraded: 1, dropped: 0, skipped: 0 });
    expect(report.inspection.totalAssetsTracked).toBe(objs.length);
  });

  it("raw transcript fixture parses through the standard builder", async () => {
    const raw = await loadDemoJson("transcript");
    expect(buildTranscriptSegments(raw, "demo")).toHaveLength(3);
  });
});
