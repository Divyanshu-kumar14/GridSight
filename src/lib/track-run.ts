// Standalone prompt-loop orchestration for POST /api/track (pure sequencing,
// no network, no database). Extracted so the loss paths are unit-testable with
// mocked SAM streams: per-prompt persistence, prompt-boundary cancel checks,
// a server-side time budget, and closed-stream detection.
//
// Timeout policy (single documented source): the client may stop listening at
// 5 min (TIMEOUTS.track — a responsiveness bound, not a cancellation); the
// server enforces a 10-min hard budget per run, checked before AND during
// each prompt, and always persists completed prompts first. A run that outlives
// the client ends as timeout/disconnect with partials saved — never silently.
//
// Evidence (2026-10-28 SAM debug): one prompt streamed 60M chars / 470 frames
// while others returned nothing, and the 5-minute client abort landed mid-run.
// The old loop persisted only after ALL prompts, checked cancel only inside
// the progress callback (never fires on empty streams), and let a late send
// failure discard every parsed record. This loop persists after each prompt
// so a late failure, cancel, timeout, or disconnect keeps earlier prompts.
import {
  buildTrackedObjects,
  isAbortError,
  isStreamClosedError,
  mergeAndDedupe,
  TRACK_CANCELLED,
  type RawDetection,
  type TrackPromptOptions,
} from "./sam";
import type { TrackedObject } from "./types";

export { TRACK_CANCELLED, isAbortError, isStreamClosedError };

/** Backstop so one oversized multi-prompt run cannot burn quota forever. */
export const TRACK_BUDGET_MS = 10 * 60 * 1000;

export interface TrackPromptFn {
  (
    fileId: string,
    category: string,
    onProgress?: (p: { frameIndex: number; totalSoFar: number }) => void,
    opts?: TrackPromptOptions,
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
  /** AbortSignal forwarded to the provider request (manual cancel, client disconnect). */
  signal?: AbortSignal;
  now?: () => number;
  budgetMs?: number;
}

export type TrackRunStatus = "complete" | "cancelled" | "timeout" | "disconnected";

export interface TrackRunOutcome {
  status: TrackRunStatus;
  /** Merged objects from completed prompts (safe to persist and show). */
  objects: TrackedObject[];
  completedPrompts: number;
}

/** Sentinel: server time budget exceeded mid-prompt. Converted to a "timeout" outcome (never surfaced). */
const TRACK_TIMEOUT = "__TRACK_TIMEOUT__";

export async function runTrackPrompts(deps: TrackRunDeps): Promise<TrackRunOutcome> {
  const { sessionId, fileId, fps, prompts, trackPrompt, persist, isCancelled, onFrame, onPromptDone } = deps;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? TRACK_BUDGET_MS;
  const startedAt = now();
  const overBudget = () => now() - startedAt > budgetMs;
  const categories = prompts.map((p) => p.trim().toLowerCase());
  const groups: TrackedObject[][] = [];
  let merged: TrackedObject[] = [];
  for (let pi = 0; pi < categories.length; pi++) {
    if (isCancelled()) {
      return { status: "cancelled", objects: merged, completedPrompts: pi };
    }
    if (overBudget()) {
      return { status: "timeout", objects: merged, completedPrompts: pi };
    }
    const category = categories[pi];
    let raw: { frameIndex: number; detections: RawDetection[] }[];
    try {
      raw = await trackPrompt(
        fileId,
        category,
        (p) => {
          // Enforce the server deadline DURING the prompt, not just between
          // prompts: a single giant stream must not consume the whole budget.
          if (overBudget()) throw new Error(TRACK_TIMEOUT);
          onFrame({ prompt: category, promptIndex: pi, frameIndex: p.frameIndex, totalSoFar: p.totalSoFar });
        },
        { signal: deps.signal },
      );
    } catch (err) {
      if (err instanceof Error && err.message === TRACK_CANCELLED) {
        return { status: "cancelled", objects: merged, completedPrompts: pi };
      }
      if (err instanceof Error && err.message === TRACK_TIMEOUT) {
        return { status: "timeout", objects: merged, completedPrompts: pi };
      }
      // An aborted upstream request means manual cancel or client disconnect.
      // The route tells them apart via the cancel flag; either way the
      // completed prompts are preserved, never discarded.
      if (isAbortError(err)) {
        return { status: "disconnected", objects: merged, completedPrompts: pi };
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
