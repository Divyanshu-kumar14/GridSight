import { writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertAudioValid,
  buildTranscriptSegments,
  findSessionAudio,
  needsConversion,
  normalizeToWav,
  probeAudioDurationSec,
  summarizeSegments,
  MAX_AUDIO_SEC,
} from "@/lib/audio";
import { ensureScratchDirs, getSession, scratchDir, setTranscript, updateSession } from "@/lib/store";
import { demoTranscript } from "@/lib/demo-fixture";
import { ASR_MODEL, ASR_TRANSCRIBE_PATH, META_BASE_URL } from "@/lib/models";

// POST /api/transcribe — JSON {sessionId} (stored audio) or multipart {sessionId + audio}.
// 200 {segments, totalDuration, speakerCount} · 400 validation · 404 no session/audio · 502 upstream.
// USE_CACHED=true → offline fixture, zero Meta burn.
const jsonSchema = z.object({ sessionId: z.string().min(1) });

const TRANSCRIBE_URL = `${META_BASE_URL}${ASR_TRANSCRIBE_PATH}`;

export async function POST(req: Request): Promise<NextResponse> {
  const contentType = req.headers.get("content-type") ?? "";

  let sessionId: string;
  let uploadedAudio: { buffer: Buffer; filename: string } | null = null;

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const id = form.get("sessionId");
      const audio = form.get("audio");
      const parsed = jsonSchema.safeParse({ sessionId: typeof id === "string" ? id : "" });
      if (!parsed.success) {
        return NextResponse.json(
          { error: { code: "invalid_body", message: "Field 'sessionId' is required." } },
          { status: 400 },
        );
      }
      sessionId = parsed.data.sessionId;
      if (!(audio instanceof Blob) || audio.size === 0) {
        return NextResponse.json(
          { error: { code: "missing_audio", message: "Field 'audio' is required." } },
          { status: 400 },
        );
      }
      const filename = typeof (audio as File).name === "string" && (audio as File).name
        ? (audio as File).name
        : "voice-memo";
      assertAudioValid(audio.size, filename);
      uploadedAudio = { buffer: Buffer.from(await audio.arrayBuffer()), filename };
    } else {
      const body: unknown = await req.json().catch(() => null);
      const parsed = jsonSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: { code: "invalid_body", message: "Expected JSON { sessionId } or multipart with audio." } },
          { status: 400 },
        );
      }
      sessionId = parsed.data.sessionId;
    }
  } catch (err) {
    return NextResponse.json(
      { error: { code: "bad_request", message: err instanceof Error ? err.message : "Bad request." } },
      { status: 400 },
    );
  }

  const session = getSession(sessionId);
  if (!session) {
    return NextResponse.json(
      { error: { code: "not_found", message: `Unknown session ${sessionId}.` } },
      { status: 404 },
    );
  }

  // Cached demo path — no ffmpeg, no network.
  if (process.env.USE_CACHED === "true") {
    try {
      const segments = await demoTranscript(sessionId);
      setTranscript(sessionId, segments);
      updateSession(sessionId, { status: "tagging" });
      return NextResponse.json({ sessionId, ...summarizeSegments(segments), segments, cached: true });
    } catch {
      return NextResponse.json(
        { error: { code: "fixture_missing", message: "Cached fixture unavailable." } },
        { status: 500 },
      );
    }
  }

  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: { code: "misconfigured", message: "MODEL_API_KEY is not set." } },
      { status: 500 },
    );
  }

  try {
    updateSession(sessionId, { status: "transcribing" });
    ensureScratchDirs();
    const audioDir = `${scratchDir()}/audio`;

    let audioPath: string;
    if (uploadedAudio) {
      audioPath = `${audioDir}/${sessionId}-${uploadedAudio.filename}`;
      await writeFile(audioPath, uploadedAudio.buffer);
    } else {
      const found = await findSessionAudio(sessionId, audioDir);
      if (!found) {
        updateSession(sessionId, { status: "error" });
        return NextResponse.json(
          { error: { code: "no_audio", message: "No voice memo stored for this session. Upload audio first." } },
          { status: 404 },
        );
      }
      audioPath = found;
    }

    const wavPath = needsConversion(audioPath)
      ? await normalizeToWav(audioPath, `${audioDir}/${sessionId}-norm.wav`)
      : audioPath;

    const duration = await probeAudioDurationSec(wavPath);
    if (duration !== null && duration > MAX_AUDIO_SEC) {
      updateSession(sessionId, { status: "error" });
      return NextResponse.json(
        { error: { code: "too_long", message: "Audio exceeds 10 minutes." } },
        { status: 400 },
      );
    }

    const { readFile } = await import("node:fs/promises");
    const wavBytes = await readFile(wavPath);
    const form = new FormData();
    // Meta Model API file-transcription contract
    // (dev.meta.ai/docs/speech-to-text): multipart with a JSON `request`
    // part plus the WAV `audio` part. OpenAI-style parts
    // (file/model/mode/language) are rejected with 400:
    // "Both a 'request' and an 'audio' part are required".
    form.append(
      "request",
      new Blob(
        [JSON.stringify({ mode: "DIARIZATION", model: ASR_MODEL, audioEncoding: "WAV" })],
        { type: "application/json" },
      ),
    );
    form.append("audio", new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" }), "voice.wav");

    const upstream = await fetch(
      `${TRANSCRIBE_URL}?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      },
    );
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 300);
      throw new Error(`Transcribe upstream ${upstream.status}.${detail ? ` ${detail}` : ""}`);
    }
    const raw: unknown = await upstream.json();
    const segments = buildTranscriptSegments(raw, sessionId);
    setTranscript(sessionId, segments);
    updateSession(sessionId, { status: "tagging" });
    return NextResponse.json({ sessionId, ...summarizeSegments(segments), segments });
  } catch (err) {
    updateSession(sessionId, { status: "error" });
    return NextResponse.json(
      { error: { code: "upstream_failed", message: err instanceof Error ? err.message.slice(0, 300) : "Transcription failed." } },
      { status: 502 },
    );
  }
}
