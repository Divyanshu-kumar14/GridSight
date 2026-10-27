import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Contract: server-side ffmpeg helpers (Phase 2+ thumbnails / durations).
// Normal: valid video path → duration/frame. Empty/missing file → throws.
// Invalid: ffmpeg binary missing → throws with install hint (never silent 0).
// NOTE: not yet wired into routes; Phase 2 ships the helper + loud errors.

export async function probeDurationSec(videoPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    const sec = Number(stdout.trim());
    if (!Number.isFinite(sec) || sec <= 0) throw new Error(`unparseable duration: ${stdout.trim()}`);
    return sec;
  } catch (err) {
    throw new Error(
      `probeDurationSec failed (${videoPath}): ${msg(err)} — is ffmpeg/ffprobe installed?`,
    );
  }
}

// Key frames go to a multimodal model, not to a viewer: a 4K JPEG is ~2MB and
// base64 inflates it 33%, so 8 frames would exceed typical request limits.
// 1280px long edge at q=4 is ~60–150KB — still enough to see corrosion/cracks.
export const KEY_FRAME_MAX_EDGE = 1280;
export const KEY_FRAME_QUALITY = 4;

// Pure: the scale filter is the whole fix — keep it testable so nobody
// "simplifies" it back to full resolution.
export function buildKeyFrameFilter(maxEdge: number = KEY_FRAME_MAX_EDGE): string {
  return `scale='min(${maxEdge},iw)':-2`;
}

export async function extractFrame(
  videoPath: string,
  timestampSec: number,
  outPath: string,
  maxEdge: number = KEY_FRAME_MAX_EDGE,
): Promise<string> {
  if (!Number.isFinite(timestampSec) || timestampSec < 0) {
    throw new Error(`extractFrame: invalid timestamp ${timestampSec}.`);
  }
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      String(timestampSec),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      buildKeyFrameFilter(maxEdge),
      "-q:v",
      String(KEY_FRAME_QUALITY),
      outPath,
    ]);
    return outPath;
  } catch (err) {
    throw new Error(`extractFrame failed: ${msg(err)} — is ffmpeg installed?`);
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}

function parseFpsToken(token: string): number | null {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(token.trim());
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0 || num <= 0) return null;
  return num / den;
}

// Probe native frame rate (needed to convert SAM frame indices to seconds).
export async function probeFps(videoPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=avg_frame_rate",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    const fps = parseFpsToken(stdout);
    if (fps === null || fps <= 0 || fps > 240) throw new Error(`unparseable fps: ${stdout.trim()}`);
    return fps;
  } catch (err) {
    throw new Error(
      `probeFps failed (${videoPath}): ${msg(err)} — is ffprobe installed?`,
    );
  }
}

export interface VideoDimensions {
  width: number;
  height: number;
}

// Probe native pixel dimensions (needed to convert normalized bboxes → crop pixels).
export async function probeDimensions(videoPath: string): Promise<VideoDimensions> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      videoPath,
    ]);
    const [w, h] = stdout.trim().split(",").map(Number);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      throw new Error(`unparseable dimensions: ${stdout.trim()}`);
    }
    return { width: w, height: h };
  } catch (err) {
    throw new Error(
      `probeDimensions failed (${videoPath}): ${msg(err)} — is ffprobe installed?`,
    );
  }
}
