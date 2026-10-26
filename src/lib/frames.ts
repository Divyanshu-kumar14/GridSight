import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { probeDimensions } from "./ffmpeg";
import { scratchDir } from "./store";
import type { BoundingBox, TrackedObject } from "./types";

const execFileAsync = promisify(execFile);

// Contract: per-asset frame thumbnails (first-seen frame, bbox crop).
// Normal: objects with frames + video present → [{objectId, file}]. Empty: no video/
// no objects → []. Single failures skip loudly (console) without failing the batch.
export const MAX_THUMBS = 20;

export function isSafeThumbName(name: string): boolean {
  return /^[\w-]+\.jpg$/.test(name);
}

// Pure: object ids contain spaces ("transmission tower-003") which break URLs
// and the strict thumb-name guard — slugify for filenames, never for display.
export function slugObjectId(id: string): string {
  return id.replace(/[^\w-]/g, "_");
}

// Pure: normalized bbox + native dims → ffmpeg crop filter (clamped, ≥2px).
export function buildCropFilter(bbox: BoundingBox, width: number, height: number, size = 256): string {
  const x = Math.max(0, Math.floor(bbox.x * width));
  const y = Math.max(0, Math.floor(bbox.y * height));
  const w = Math.max(2, Math.floor(bbox.w * width));
  const h = Math.max(2, Math.floor(bbox.h * height));
  return `crop=${w}:${h}:${x}:${y},scale=${size}:-1`;
}

export async function findSessionVideo(sessionId: string): Promise<string | null> {
  const entries = await readdir(`${scratchDir()}/video`).catch(() => [] as string[]);
  const hit = entries.filter((e) => e.startsWith(sessionId)).sort()[0];
  return hit ? `${scratchDir()}/video/${hit}` : null;
}

export interface Thumb {
  objectId: string;
  file: string;
}

export async function extractThumbnails(
  sessionId: string,
  objects: TrackedObject[],
  cap: number = MAX_THUMBS,
): Promise<Thumb[]> {
  const videoPath = await findSessionVideo(sessionId);
  if (!videoPath || objects.length === 0) return [];
  let dims;
  try {
    dims = await probeDimensions(videoPath);
  } catch (e) {
    console.error("thumbnails: probe failed:", e instanceof Error ? e.message : e);
    return [];
  }
  const out: Thumb[] = [];
  for (const o of objects.slice(0, Math.max(0, cap))) {
    const first = o.frames[0];
    if (!first) continue;
    const file = `${sessionId}-thumb-${slugObjectId(o.id)}.jpg`;
    const outPath = `${scratchDir()}/frames/${file}`;
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss",
        String(first.timestamp),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        buildCropFilter(first.bbox, dims.width, dims.height),
        outPath,
      ]);
      out.push({ objectId: o.id, file });
    } catch (e) {
      console.error(`thumbnail ${o.id} skipped:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}
