import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { demoReport, demoTagged, demoTracking, demoTranscript } from "@/lib/demo-fixture";
import {
  createSession,
  ensureScratchDirs,
  scratchDir,
  setReport,
  setTaggedNotes,
  setTracking,
  setTranscript,
} from "@/lib/store";

// POST /api/demo-session — validated sample-session endpoint (zero inference).
// Creates a fresh session populated from frozen fixtures, marked isSample=true.
// Works without API keys or billable calls. The sample report is clearly marked
// as cached data and must never be attributed to a user's uploaded video.
// 201 { sessionId, sample: true } · 500 missing fixture (fails visibly, never half-loaded).
export async function POST(): Promise<NextResponse> {
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  try {
    createSession({
      id: sessionId,
      substationName: "East Bus Substation (sample)",
      inspectorName: "Sample — not a real inspector",
      date: now,
      status: "complete",
      videoFileId: `sample-${sessionId}`,
      videoFileName: "sample — no playable video",
      videoDurationSec: 45,
      videoFps: 30,
      voiceFileId: undefined,
      isSample: true,
      createdAt: now,
      updatedAt: now,
    });
    const [objects, segments, tagged, report] = await Promise.all([
      demoTracking(sessionId),
      demoTranscript(sessionId),
      demoTagged(sessionId),
      demoReport(sessionId),
    ]);
    setTracking(sessionId, objects);
    setTranscript(sessionId, segments);
    setTaggedNotes(sessionId, tagged);
    setReport(sessionId, report);
    ensureScratchDirs();
    await writeFile(`${scratchDir()}/reports/${sessionId}.json`, JSON.stringify(report, null, 2)).catch(
      () => null,
    );
    return NextResponse.json({ sessionId, sample: true, cached: true }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          code: "sample_unavailable",
          message: err instanceof Error ? err.message.slice(0, 300) : "Sample fixtures unavailable.",
        },
      },
      { status: 500 },
    );
  }
}
