import type { DefectReport } from "./types";

// Contract: CSV export of a defect report (support feature; PDF deferred — see report page).
// Normal: header + one row per defect, RFC-4180 quoted. Empty: header only.

const HEADER = [
  "id",
  "assetId",
  "assetCategory",
  "severity",
  "title",
  "frameTimestamp",
  "recommendedAction",
  "urgency",
  "voiceNoteExcerpt",
];

function cell(v: string | number | undefined): string {
  const s = v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildReportCsv(report: DefectReport): string {
  const lines = [HEADER.join(",")];
  for (const d of report.defects) {
    lines.push(
      [
        cell(d.id),
        cell(d.assetId),
        cell(d.assetCategory),
        cell(d.severity),
        cell(d.title),
        cell(d.frameTimestamp),
        cell(d.recommendedAction),
        cell(d.estimatedUrgency),
        cell(d.voiceNoteExcerpt ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function reportCsvFilename(sessionId: string): string {
  return `gridsight-report-${sessionId.slice(0, 8)}.csv`;
}
