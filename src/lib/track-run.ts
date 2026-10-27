// Standalone prompt-loop orchestration for POST /api/track (pure sequencing,
// no network, no database). Extracted so the loss paths are unit-testable with
// mocked SAM streams: per-prompt persistence, prompt-boundary cancel checks,
// a server-side time budget, and closed-stream detection.
//
// Evidence (2026-10-28 SAM debug): one prompt streamed 60M chars / 470 frames
// while others returned nothing, and the 5-minute client abort landed mid-run.
// The old loop persisted only after ALL prompts, checked cancel only inside
// the progress callback (never fires on empty streams), and let a late send
// failure discard every parsed record. This loop persists after each prompt
// so a late failure, cancel, or budget timeout keeps earlier prompts.
import { buildTrackedObjects, mergeAndDedupe, type RawDetection } from "./sam";
import type { TrackedObject } from "./types";

/** Internal sentinel: cooperative cancel, converted to a "cancelled" outcome (never surfaced). */
export const TRACK_CANCELLED = "__CANCELLED__";

/** Backstop so one oversized multi-prompt run cannot burn quota forever. */
export const TRACK_BUDGET_MS = 10 * 60 * 1000;

export interface TrackPromptFn {
  (
    fileId: string,
    category: string,
    onProgress?: (p: { frameIndex: number; totalSoFar: number }) => void,
  ): Promise<{ frameIndex: number; detections: RawDetection[] }[]>;
}

export interface TrackRunDeps {
  sessionId: string;
  fileId: string;
  fps: number;
  prompts: string[];
  trackPrompt: TrackPromptFn;
  /** Persist merged-so-far (called after every prompt). Must never throw away prior prompts. */
  persist: (objects: TrackedObject[]) => void;
  /** Cooperative cancel flag (cheap to poll: checked before every prompt). */
  isCancelled: () => boolean;
  /** Per-frame progress hook. May throw TRACK_CANCELLED to abort. */
  onFrame: (info: { prompt: string; promptIndex: number; frameIndex: number; totalSoFar: number }) => void;
  /** Per-prompt completion hook. May throw (e.g. closed SSE stream). */
  onPromptDone: (info: { prompt: string; count: number }) => void;
  now?: () => number;
  budgetMs?: number;
}

export type TrackRunStatus = "complete" | "cancelled" | "timeout";

export interface TrackRunOutcome {
  status: TrackRunStatus;
  /** Merged objects from completed prompts (safe to persist and show). */
  objects: TrackedObject[];
  completedPrompts: number;
}

/**
 * True when a send/stream failure means only that the client went away
 * (observed: "Invalid state: Controller is already closed"). Such failures
 * must be reported as a disconnect with partial counts — never as a model
 * error, and never a reason to discard persisted prompts.
 */
export function isStreamClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already closed/i.test(msg);
}

export async function runTrackPrompts(deps: TrackRunDeps): Promise<TrackRunOutcome> {
  const { sessionId, fileId, fps, prompts, trackPrompt, persist, isCancelled, onFrame, onPromptDone } = deps;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? TRACK_BUDGET_MS;
  const startedAt = now();
  const categories = prompts.map((p) => p.trim().toLowerCase());
  const groups: TrackedObject[][] = [];
  let merged: TrackedObject[] = [];
  for (let pi = 0; pi < categories.length; pi++) {
    if (isCancelled()) {
      return { status: "cancelled", objects: merged, completedPrompts: pi };
    }
    if (now() - startedAt > budgetMs) {
      return { status: "timeout", objects: merged, completedPrompts: pi };
    }
    const category = categories[pi];
    let raw: { frameIndex: number; detections: RawDetection[] }[];
    try {
      raw = await trackPrompt(fileId, category, (p) => {
        onFrame({ prompt: category, promptIndex: pi, frameIndex: p.frameIndex, totalSoFar: p.totalSoFar });
      });
    } catch (err) {
      if (err instanceof Error && err.message === TRACK_CANCELLED) {
        return { status: "cancelled", objects: merged, completedPrompts: pi };
      }
      throw err;
    }
    const objects = buildTrackedObjects({ sessionId, category, frames: raw, fps });
    groups.push(objects);
    merged = mergeAndDedupe(groups);
    persist(merged);
    onPromptDone({ prompt: category, count: objects.length });
  }
  return { status: "complete", objects: merged, completedPrompts: categories.length };
}
