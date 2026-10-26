import { NextResponse } from "next/server";
import { z } from "zod";
import { getMetaClient } from "@/lib/meta-client";
import {
  TAGGING_SYSTEM_PROMPT,
  buildTaggingPayload,
  fallbackTag,
  validateTaggedNotes,
} from "@/lib/tagging";
import {
  getSession,
  getTracking,
  getTranscript,
  setTaggedNotes,
  setTracking,
  setTranscript,
  updateSession,
} from "@/lib/store";
import { demoTagged, demoTracking, demoTranscript } from "@/lib/demo-fixture";

// POST /api/tag-assets — { sessionId } → align segments to objects via Spark 1.3.
// 200 {taggedNotes, matchedCount, unmatchedCount, fallback} · 400 no transcript · 404 session.
// Spark failure → deterministic fallback (demo-safe, flagged). USE_CACHED → fallback, zero burn.
const bodySchema = z.object({ sessionId: z.string().min(1) });

export async function POST(req: Request): Promise<NextResponse> {
  const body: unknown = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Expected JSON { sessionId }." } },
      { status: 400 },
    );
  }
  const { sessionId } = parsed.data;
  const session = getSession(sessionId);
  if (!session) {
    return NextResponse.json(
      { error: { code: "not_found", message: `Unknown session ${sessionId}.` } },
      { status: 404 },
    );
  }

  const objects = getTracking(sessionId);
  const segments = getTranscript(sessionId);
  if (segments.length === 0) {
    return NextResponse.json(
      { error: { code: "no_transcript", message: "No transcript for this session. Transcribe first." } },
      { status: 400 },
    );
  }

  updateSession(sessionId, { status: "tagging" });

  const persist = (notes: ReturnType<typeof fallbackTag>, fallback: boolean) => {
    setTaggedNotes(sessionId, notes);
    updateSession(sessionId, { status: "generating" });
    const matchedCount = notes.filter((n) => n.matchedAssetId !== null).length;
    return NextResponse.json({
      sessionId,
      taggedNotes: notes,
      matchedCount,
      unmatchedCount: notes.length - matchedCount,
      fallback,
    });
  };

  if (process.env.USE_CACHED === "true") {
    // Prime the store from the golden dataset so a fresh cached session works end-to-end.
    if (getTracking(sessionId).length === 0) {
      setTracking(sessionId, await demoTracking(sessionId));
    }
    if (getTranscript(sessionId).length === 0) {
      setTranscript(sessionId, await demoTranscript(sessionId));
    }
    return persist(await demoTagged(sessionId), true);
  }

  try {
    const client = getMetaClient();
    const res = await client.chat.completions.create({
      model: "muse-spark-1.3",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: TAGGING_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(buildTaggingPayload(objects, segments)) },
      ],
    });
    const text = res.choices[0]?.message?.content ?? "";
    const notes = validateTaggedNotes(parseLenient(text));
    return persist(notes, false);
  } catch {
    return persist(fallbackTag(objects, segments), true);
  }
}

// Strips ```json fences some models add; then JSON.parse (throws → fallback).
function parseLenient(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return JSON.parse((fenced ? fenced[1] : text).trim());
}
