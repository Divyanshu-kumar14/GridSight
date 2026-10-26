import { z } from "zod";
import type { TaggedNote, TrackedObject, TranscriptSegment } from "./types";

// Contract: Spark asset-tagging support (PRD Appendix A) + deterministic fallback.
// Normal: prompt builder serializes compactly; fallback links obvious matches.
// Empty: no objects or no segments → all unmatched (never crash).
// Invalid: Spark JSON failing schema → caller falls back, never persists garbage.

export const TAGGING_SYSTEM_PROMPT = `You are GridSight's asset tagging engine. You receive:
1. A list of tracked objects from SAM 3.1 video segmentation, each with an object ID, category, and frame timestamps.
2. A list of transcript segments from the inspector's voice notes, each with start/end timestamps and text.

Your job: Match each transcript segment to the most relevant tracked object.

Matching rules:
- Match by timestamp proximity: the segment's time range should overlap or be near the object's visible frames
- Match by semantic content: if the inspector says "third insulator" or "transformer T4", match to the corresponding object
- If no confident match exists, set matchedAssetId to null
- Assign a confidence score (0.0-1.0) and explain the match reason

Output a JSON array of TaggedNote objects.`;

// Compact serialization for the Spark user message (keeps the 1M window mostly empty).
export function buildTaggingPayload(
  objects: TrackedObject[],
  segments: TranscriptSegment[],
): { objects: unknown[]; segments: unknown[] } {
  return {
    objects: objects.map((o) => ({
      id: o.id,
      category: o.category,
      firstSeen: o.frames[0]?.timestamp ?? 0,
      lastSeen: o.frames[o.frames.length - 1]?.timestamp ?? 0,
      frameCount: o.totalFrameCount,
    })),
    segments: segments.map((s) => ({
      id: s.id,
      start: s.startTime,
      end: s.endTime,
      text: s.text,
    })),
  };
}

// ============ Schema validation ============

const taggedNoteSchema = z.object({
  segmentId: z.string().min(1),
  text: z.string(),
  speaker: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  matchedAssetId: z.string().nullable(),
  matchedCategory: z.string().nullable(),
  matchConfidence: z.number().min(0).max(1),
  matchReason: z.string(),
});

// Accepts a bare array or {taggedNotes:[...]}. Throws on any invalid entry.
export function validateTaggedNotes(raw: unknown): TaggedNote[] {
  const list: unknown = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { taggedNotes?: unknown }).taggedNotes)
      ? (raw as { taggedNotes: unknown }).taggedNotes
      : raw;
  const parsed = z.array(taggedNoteSchema).safeParse(list);
  if (!parsed.success) {
    throw new Error(`Invalid TaggedNote payload: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}

// ============ Deterministic fallback matcher ============
// Score: keyword hit (segment mentions category) = 0.6 base, +0.3 temporal overlap.
// Temporal-only overlap = 0.4. Neither → unmatched (null, 0.0).
// Pure + offline — also serves USE_CACHED demos.

export function fallbackTag(
  objects: TrackedObject[],
  segments: TranscriptSegment[],
): TaggedNote[] {
  return segments.map((s) => {
    const text = s.text.toLowerCase();
    let best: TrackedObject | null = null;
    let bestScore = 0;
    let bestReason = "";
    for (const o of objects) {
      const cat = o.category.toLowerCase();
      const keyword = text.includes(cat) || text.includes(`${cat}s`);
      const objStart = o.frames[0]?.timestamp ?? 0;
      const objEnd = o.frames[o.frames.length - 1]?.timestamp ?? 0;
      const overlap = Math.max(0, Math.min(s.endTime, objEnd) - Math.max(s.startTime, objStart));
      if (keyword && overlap > 0) {
        const score = 0.9;
        if (score > bestScore) {
          bestScore = score;
          best = o;
          bestReason = `Mentions "${o.category}" and timestamps overlap its visible range`;
        }
      } else if (keyword) {
        if (0.6 > bestScore) {
          bestScore = 0.6;
          best = o;
          bestReason = `Mentions "${o.category}" (no timestamp overlap)`;
        }
      } else if (overlap > 0) {
        if (0.4 > bestScore) {
          bestScore = 0.4;
          best = o;
          bestReason = `Timestamp overlaps "${o.id}" visible range`;
        }
      }
    }
    if (!best) {
      return {
        segmentId: s.id,
        text: s.text,
        speaker: s.speaker,
        startTime: s.startTime,
        endTime: s.endTime,
        matchedAssetId: null,
        matchedCategory: null,
        matchConfidence: 0,
        matchReason: "No overlapping asset or category mention found",
      } satisfies TaggedNote;
    }
    return {
      segmentId: s.id,
      text: s.text,
      speaker: s.speaker,
      startTime: s.startTime,
      endTime: s.endTime,
      matchedAssetId: best.id,
      matchedCategory: best.category,
      matchConfidence: bestScore,
      matchReason: bestReason,
    } satisfies TaggedNote;
  });
}
