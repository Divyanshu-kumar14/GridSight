import { NextResponse } from "next/server";
import { getReport, getSession, getTaggedNotes, getTracking, getTranscript, listSessions } from "@/lib/store";
import { getJobs } from "@/lib/jobs";

// GET /api/sessions → every inspection, newest first, with rollup counts.
// GET /api/sessions?sessionId= → single session meta (fps/duration for playback)
//   plus persisted tracking objects and the latest track job status, so a
//   reloaded or timed-out page can restore saved partials instead of showing
//   an empty workspace.
export async function GET(req: Request): Promise<NextResponse> {
  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
  if (sessionId) {
    const s = getSession(sessionId);
    if (!s) {
      return NextResponse.json(
        { error: { code: "not_found", message: "Unknown session." } },
        { status: 404 },
      );
    }
    const trackJob = getJobs(sessionId).find((j) => j.kind === "track") ?? null;
    const transcript = getTranscript(sessionId);
    const tagged = getTaggedNotes(sessionId);
    const report = getReport(sessionId);
    return NextResponse.json({
      session: s,
      tracking: getTracking(sessionId),
      transcript,
      tagged,
      hasReport: !!report,
      trackJob: trackJob
        ? { status: trackJob.status, error: trackJob.error, progress: trackJob.progress, total: trackJob.total }
        : null,
    });
  }
  return NextResponse.json({ sessions: listSessions() });
}
