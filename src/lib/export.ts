import type { DefectReport } from "./types";

// Contract: CSV export of a defect report (support feature; PDF deferred — see report page).
// Normal: header + one row per defect, RFC-4180 quoted. Empty: header only.

const HEADER = [
  "id",
  "assetId",
  "assetCategory",
  "severity",
  "evidenceSource",
  "title",
  "frameTimestamp",
  "observation",
  "recommendedAction",
  "urgency",
  "voiceNoteExcerpt",
];

function cell(v: string | number | undefined): string {
  const s = v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Evidence provenance must survive export: an assessor reading the CSV has to
// know whether a row was seen on a frame or only reported by voice. Legacy rows
// without the field default to "voice" — never claim visual evidence we lack.
export function buildReportCsv(report: DefectReport): string {
  const lines = [HEADER.join(",")];
  for (const d of report.defects) {
    lines.push(
      [
        cell(d.id),
        cell(d.assetId),
        cell(d.assetCategory),
        cell(d.severity),
        cell(d.evidenceSource ?? "voice"),
        cell(d.title),
        cell(d.frameTimestamp),
        cell(d.observation ?? ""),
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
