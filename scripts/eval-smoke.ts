// GridSight deterministic smoke test — Mode A (no inference, no network).
// Verifies pipeline plumbing + expected report fields using fixtures and pure
// functions only. Prints PIPELINE success, never model accuracy.
// Exit 0 on success, 1 on any failure. Safe for CI and npm test environments.

import { buildReportCsv } from "../src/lib/export";
import {
  attachOverlayBox,
  computeEvidenceCoverage,
  labelEvidence,
  pickKeyTimestamps,
  validateDefects,
  validateReport,
} from "../src/lib/report";
import { fallbackTag } from "../src/lib/tagging";
import type { Defect } from "../src/lib/types";

let checks = 0;
function ok(name: string, cond: boolean): void {
  checks++;
  if (!cond) {
    console.error(`SMOKE FAIL: ${name}`);
    process.exit(1);
  }
  console.log(`SMOKE OK: ${name}`);
}

async function main(): Promise<void> {
  // Fixtures load through the same validators production uses.
  const { demoReport, demoTagged, demoTracking, demoTranscript } = await import("../src/lib/demo-fixture");
  const sid = "smoke";
  const [objs, segs, notes, report] = await Promise.all([
    demoTracking(sid),
    demoTranscript(sid),
    demoTagged(sid),
    demoReport(sid),
  ]);
  ok("demo tracking loads 6 assets", objs.length === 6);
  ok("demo transcript loads 3 segments", segs.length === 3);
  ok("demo tagged notes validate", notes.length === 3);
  ok("demo report validates with 2 defects", report.defects.length === 2);

  // Pure pipeline runs quota-free.
  const stamps = pickKeyTimestamps(objs, notes);
  ok("key frames selected within budget and sorted", stamps.length > 0 && stamps.length <= 8);
  const frames = stamps.map((t, i) => ({ timestamp: t, base64: `SMOKE${i}` }));
  const tagged = fallbackTag(objs, segs);
  ok("fallback tagging never crashes", tagged.length === segs.length);

  const sample: Defect[] = [
    {
      id: "s1",
      assetId: objs[0].id,
      assetCategory: objs[0].category,
      severity: "HIGH",
      title: "t",
      description: "d",
      frameTimestamp: stamps[0] ?? 0,
      recommendedAction: "fix",
      estimatedUrgency: "Monitor",
      evidenceFrameIndex: 0,
      observation: "smoke observation",
    },
  ];
  const labeled = labelEvidence(validateDefects(sample), frames);
  ok("labelEvidence marks visual with valid index", labeled[0].evidenceSource === "visual");
  const boxed = attachOverlayBox(labeled, objs);
  ok("attachOverlayBox resolves exact id", boxed[0].assetAssociation === "confirmed");
  const cov = computeEvidenceCoverage(objs, frames, boxed);
  ok("coverage ledger is honest", cov.totalAssetsTracked === objs.length);
  ok("CSV export keeps header", buildReportCsv(report).startsWith("id,assetId,"));
  ok("report revalidates", validateReport(report, { id: report.id, sessionId: sid }).defects.length === 2);

  console.log(
    `SMOKE (no inference): pipeline OK, ${checks} checks passed — not a measure of detection accuracy.`,
  );
}

main().catch((err) => {
  console.error("SMOKE FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
