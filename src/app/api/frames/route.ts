import { NextResponse } from "next/server";
import { z } from "zod";
import { extractThumbnails } from "@/lib/frames";
import { getSession, getTracking } from "@/lib/store";

// POST /api/frames { sessionId } → extract first-seen crops (cap 20).
// 200 { thumbs: [{ objectId, url }] } · 400/404 · no video → { thumbs: [] } (never 500 for that).
export async function POST(req: Request): Promise<NextResponse> {
  const body: unknown = await req.json().catch(() => null);
  const parsed = z.object({ sessionId: z.string().min(1) }).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Expected JSON { sessionId }." } },
      { status: 400 },
    );
  }
  const { sessionId } = parsed.data;
  if (!getSession(sessionId)) {
    return NextResponse.json(
      { error: { code: "not_found", message: `Unknown session ${sessionId}.` } },
      { status: 404 },
    );
  }
  const thumbs = await extractThumbnails(sessionId, getTracking(sessionId));
  return NextResponse.json({
    thumbs: thumbs.map((t) => ({ objectId: t.objectId, url: `/api/frames/${sessionId}/${t.file}` })),
  });
}
