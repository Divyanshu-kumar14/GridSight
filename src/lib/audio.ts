import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import type { TranscriptSegment } from "./types";

const execFileAsync = promisify(execFile);

// Contract: audio helpers for Muse Voice Transcribe.
// Limits: ≤32MB, ≤10min, mono 16-bit PCM WAV 16kHz (converted via ffmpeg).
// Normal: valid file → normalized wav path. Empty/invalid → throws with 400-safe message.

export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
export const MAX_AUDIO_SEC = 600;
const ACCEPTED_EXT = [".wav", ".mp3", ".m4a", ".ogg", ".webm"];

export function assertAudioValid(sizeBytes: number, filename: string): void {
  const lower = filename.toLowerCase();
  if (!ACCEPTED_EXT.some((ext) => lower.endsWith(ext))) {
    throw new Error(
      `Unsupported audio type "${filename}". Use WAV/MP3/M4A/OGG/WebM.`,
    );
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error("Empty audio file.");
  }
  if (sizeBytes > MAX_AUDIO_BYTES) {
    throw new Error("Audio exceeds 32MB limit.");
  }
}

export function needsConversion(filename: string): boolean {
  return !filename.toLowerCase().endsWith(".wav");
}

// Converts any accepted input to mono 16-bit PCM WAV 16kHz (Transcribe contract).
export async function normalizeToWav(inputPath: string, outputPath: string): Promise<string> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-sample_fmt",
      "s16",
      outputPath,
    ]);
    return outputPath;
  } catch (err) {
    throw new Error(`Audio conversion failed: ${short(err)} — is ffmpeg installed?`);
  }
}

export async function probeAudioDurationSec(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    const sec = Number(stdout.trim());
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  } catch {
    return null; // duration unknown — route proceeds, Meta enforces its own cap
  }
}

// Finds the stored audio file for a session (upload route saves {sessionId}-{name}).
export async function findSessionAudio(sessionId: string, audioDir: string): Promise<string | null> {
  const entries = await readdir(audioDir).catch(() => [] as string[]);
  const hit = entries.filter((e) => e.startsWith(sessionId)).sort()[0];
  return hit ? `${audioDir}/${hit}` : null;
}

// ============ Transcribe response mapping ============

export interface RawSegment {
  speaker?: unknown;
  start?: unknown;
  end?: unknown;
  text?: unknown;
}

interface RawTurn {
  speaker?: unknown;
  startMs?: unknown;
  endMs?: unknown;
  transcript?: unknown;
}

// Meta file-transcription turns use ms timestamps and `transcript` text;
// normalize to the segment shape so the shared guard below applies.
function turnToSegmentShape(turn: unknown): RawSegment {
  const t = (turn ?? {}) as RawTurn;
  const startMs = Number(t.startMs);
  const endMs = Number(t.endMs);
  return {
    speaker: t.speaker,
    start: Number.isFinite(startMs) ? startMs / 1000 : NaN,
    end: Number.isFinite(endMs) ? endMs / 1000 : NaN,
    text: t.transcript,
  };
}

// Accepts {segments:[...]}, Meta's {turns:[...]} (startMs/endMs/transcript/
// speaker, per dev.meta.ai/docs/speech-to-text), or a bare array. Normal:
// mapped with trimmed text. Empty: [] → []. Invalid entries (non-numeric
// times, empty text) dropped, never crash.
export function buildTranscriptSegments(raw: unknown, sessionId: string): TranscriptSegment[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { segments?: unknown }).segments)
      ? ((raw as { segments: unknown[] }).segments as unknown[])
      : raw && typeof raw === "object" && Array.isArray((raw as { turns?: unknown }).turns)
        ? ((raw as { turns: unknown[] }).turns.map(turnToSegmentShape) as unknown[])
        : [];
  const out: TranscriptSegment[] = [];
  list.forEach((item, i) => {
    const seg = (item ?? {}) as RawSegment;
    const start = Number(seg.start);
    const end = Number(seg.end);
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    if (!Number.isFinite(start) || !Number.isFinite(end) || text === "") return;
    out.push({
      id: `${sessionId}-seg-${String(i).padStart(3, "0")}`,
      sessionId,
      speaker: typeof seg.speaker === "string" && seg.speaker ? seg.speaker : "SPEAKER_0",
      startTime: start,
      endTime: end,
      text,
    });
  });
  return out;
}

export function summarizeSegments(segments: TranscriptSegment[]): {
  totalDuration: number;
  speakerCount: number;
} {
  let totalDuration = 0;
  const speakers = new Set<string>();
  for (const s of segments) {
    totalDuration = Math.max(totalDuration, s.endTime);
    speakers.add(s.speaker);
  }
  return { totalDuration, speakerCount: speakers.size };
}

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 160);
}
