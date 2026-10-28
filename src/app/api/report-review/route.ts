import { readFile, writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getReport, getSession, setReport, ensureScratchDirs, scratchDir } from "@/lib/store";
import { validateReport } from "@/lib/report";

// POST /api/report-review — human review of a single finding.
// Body: { sessionId, defectId, status: confirmed|rejected|needs-inspection,
//         note?, correctedAssetId?, correctedDescription?, correctedAction? }
// Rules: validated; unknown finding → 404; cross-session → 404 (session owns report);
// preserves all stored fields except humanReview; verification untouched.
const bodySchema = z.object({
  sessionId: z.string().min(1).max(200),
  defectId: z.string().min(1).max(200),
  status: z.enum(["confirmed", "rejected", "needs-inspection"]),
  note: z.string().max(2000).optional(),
  correctedAssetId: z.string().min(1).max(120).optional(),
  correctedDescription: z.string().min(1).max(5000).optional(),
  correctedAction: z.string().min(1).max(2000).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  const body: unknown = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_body",
          message: "Expected { sessionId, defectId, status } with optional note/corrections.",
          issues: parsed.error.issues,
        },
      },
      { status: 400 },
    );
  }
  const { sessionId, defectId, status, note, correctedAssetId, correctedDescription, correctedAction } =
    parsed.data;

  const session = getSession(sessionId);
  if (!session) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Unknown session." } },
      { status: 404 },
    );
  }
  let report = getReport(sessionId);
  if (!report) {
    // Fall back to scratch snapshot (same contract as generate-report GET).
    const file = await readFile(`${scratchDir()}/reports/${sessionId}.json`, "utf8").catch(() => null);
    if (file) {
      try {
        report = validateReport(JSON.parse(file) as unknown, {
          id: `rep-${sessionId.slice(0, 8)}`,
          sessionId,
        });
        setReport(sessionId, report);
      } catch {
        report = undefined;
      }
    }
  }
  if (!report) {
    return NextResponse.json(
      { error: { code: "not_found", message: "No report for this session yet." } },
      { status: 404 },
    );
  }
  // Session ownership: the report's own sessionId must match (prevents one
  // session modifying another's report even if IDs are guessed).
  if (report.sessionId !== sessionId) {
    return NextResponse.json(
      { error: { code: "not_found", message: "No report for this session yet." } },
      { status: 404 },
    );
  }
  const idx = report.defects.findIndex((d) => d.id === defectId);
  if (idx < 0) {
    return NextResponse.json(
      { error: { code: "unknown_finding", message: `Unknown finding ${defectId}.` } },
      { status: 404 },
    );
  }

  const updatedAt = new Date().toISOString();
  const next = {
    ...report,
    defects: report.defects.map((d, i) =>
      i === idx
        ? {
            ...d,
            humanReview: {
              status,
              ...(typeof note === "string" && note.trim() ? { note: note.trim().slice(0, 2000) } : {}),
              ...(correctedAssetId ? { correctedAssetId: correctedAssetId.trim() } : {}),
              ...(correctedDescription ? { correctedDescription: correctedDescription.trim() } : {}),
              ...(correctedAction ? { correctedAction: correctedAction.trim() } : {}),
              updatedAt,
            },
          }
        : d,
    ),
  };
  // Re-validate before persisting (fail loudly, never store garbage).
  const validated = validateReport(next, { id: report.id, sessionId });
  setReport(sessionId, validated);
  ensureScratchDirs();
  await writeFile(`${scratchDir()}/reports/${sessionId}.json`, JSON.stringify(validated, null, 2)).catch(
    () => null,
  );
  return NextResponse.json({ defect: validated.defects[idx] });
}
