import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { z } from "zod";
import { uploadVideoToFiles } from "@/lib/sam";
import { KEY_FRAME_MAX_EDGE, probeDurationSec, probeFps } from "@/lib/ffmpeg";
import { createSession, ensureScratchDirs, scratchDir } from "@/lib/store";

const execFileAsync = promisify(execFile);

// POST /api/upload — multipart: video* (MP4/MOV ≤500MB), audio?, substationName?, inspectorName?.
// Metadata is optional — empty values become "Not provided" (never invented).
// 201 { sessionId, videoFileId, videoDuration, videoFps } · 400 validation · 502 upstream.
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

const metaSchema = z.object({
  substationName: z.string().max(200).optional().default(""),
  inspectorName: z.string().max(200).optional().default(""),
});

function cleanName(v: unknown): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, 200) : "Not provided";
}

export async function POST(req: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Expected multipart/form-data." } },
      { status: 400 },
    );
  }

  const video = form.get("video");
  const audio = form.get("audio");
  const parsed = metaSchema.safeParse({
    substationName: form.get("substationName"),
    inspectorName: form.get("inspectorName"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_metadata", message: "substationName and inspectorName are required.", issues: parsed.error.issues } },
      { status: 400 },
    );
  }
  if (!(video instanceof Blob)) {
    return NextResponse.json(
      { error: { code: "missing_video", message: "Field 'video' (MP4/MOV) is required." } },
      { status: 400 },
    );
  }
  const filename =
    typeof (video as File).name === "string" && (video as File).name
      ? (video as File).name
      : "upload.mp4";
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".mp4") && !lower.endsWith(".mov")) {
    return NextResponse.json(
      { error: { code: "unsupported_type", message: "Only MP4/MOV are supported." } },
      { status: 400 },
    );
  }
  if (video.size > MAX_VIDEO_BYTES) {
    return NextResponse.json(
      { error: { code: "too_large", message: "Video exceeds 500MB limit." } },
      { status: 400 },
    );
  }

  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const substationName = cleanName(parsed.success ? parsed.data.substationName : "");
  const inspectorName = cleanName(parsed.success ? parsed.data.inspectorName : "");

  // Offline demo mode: skip Files upload entirely (zero burn), session works end-to-end.
  if (process.env.USE_CACHED === "true") {
    createSession({
      id: sessionId,
      substationName,
      inspectorName,
      date: now,
      status: "tracking",
      videoFileId: `cached-${sessionId}`,
      videoFileName: filename,
      videoDurationSec: 45,
      videoFps: 30,
      voiceFileId: undefined,
      createdAt: now,
      updatedAt: now,
    });
    return NextResponse.json(
      { sessionId, videoFileId: `cached-${sessionId}`, videoDuration: 45, videoFps: 30 },
      { status: 201 },
    );
  }

  try {
    const buffer = Buffer.from(await video.arrayBuffer());
    ensureScratchDirs();
    // Persist server-side so ffmpeg can extract key frames (best-effort).
    const savedPath = `${scratchDir()}/video/${sessionId}-${filename}`;
    await writeFile(savedPath, buffer).catch(() => null);
    // Pre-transcode to 720p/15fps/H.264 before the Files upload: smaller
    // upload (15-30s saved) and SAM sees exactly what we probed. Failure
    // falls back silently to the original — never break the upload.
    const compressedPath = `${scratchDir()}/video/${sessionId}-compressed.mp4`;
    let uploadPath = savedPath;
    let uploadBuffer = buffer;
    let uploadName = filename;
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        savedPath,
        "-vf",
        `scale='min(${KEY_FRAME_MAX_EDGE},iw)':-2,fps=15`,
        "-c:v",
        "libx264",
        "-crf",
        "26",
        "-preset",
        "fast",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        compressedPath,
      ]);
      const compressedBytes = await readFile(compressedPath);
      uploadPath = compressedPath;
      uploadBuffer = compressedBytes;
      uploadName = `${sessionId}-compressed.mp4`;
    } catch (e) {
      console.error("upload transcode fallback to original:", e instanceof Error ? e.message : e);
      await unlink(compressedPath).catch(() => null);
      uploadPath = savedPath;
      uploadBuffer = buffer;
      uploadName = filename;
    }
    // Probe real duration + fps from the file SAM will actually receive, so
    // the report/timeline math uses these, not guesses (best-effort, warned).
    let videoDurationSec = 0;
    let videoFps = 30;
    try {
      videoDurationSec = await probeDurationSec(uploadPath);
    } catch (e) {
      console.error("upload probe duration:", e instanceof Error ? e.message : e);
    }
    try {
      videoFps = await probeFps(uploadPath);
    } catch (e) {
      console.error("upload probe fps:", e instanceof Error ? e.message : e);
    }
    const videoFileId = await uploadVideoToFiles(uploadBuffer, uploadName);
    // No orphan temps: keep the file SAM received as the session video for
    // later key-frame/thumbnail extraction; delete the other.
    if (uploadPath === compressedPath) {
      await unlink(savedPath).catch(() => null);
    } else {
      await unlink(compressedPath).catch(() => null);
    }

    let voiceFileId: string | undefined;
    if (audio instanceof Blob && audio.size > 0) {
      ensureScratchDirs();
      const audioName = typeof (audio as File).name === "string" && (audio as File).name
        ? (audio as File).name
        : "voice-memo";
      await writeFile(
        `${scratchDir()}/audio/${sessionId}-${audioName}`,
        Buffer.from(await audio.arrayBuffer()),
      );
      voiceFileId = `local-${sessionId}`;
    }

    createSession({
      id: sessionId,
      substationName,
      inspectorName,
      date: now,
      status: "tracking",
      videoFileId,
      videoFileName: filename,
      videoDurationSec,
      videoFps,
      voiceFileId,
      createdAt: now,
      updatedAt: now,
    });

    return NextResponse.json(
      { sessionId, videoFileId, voiceFileId, videoDuration: videoDurationSec, videoFps },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          code: "upstream_failed",
          message: err instanceof Error ? err.message.slice(0, 300) : "Files upload failed.",
        },
      },
      { status: 502 },
    );
  }
}
