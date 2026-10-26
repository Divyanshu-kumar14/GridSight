import { NextResponse } from "next/server";
import { getSession, listSessions } from "@/lib/store";

// GET /api/sessions → every inspection, newest first, with rollup counts.
// GET /api/sessions?sessionId= → single session meta (fps/duration for playback).
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
    return NextResponse.json({ session: s });
  }
  return NextResponse.json({ sessions: listSessions() });
}
