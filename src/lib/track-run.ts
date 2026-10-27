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
  mergeAndDedupe,
  TRACK_CANCELLED,
  TRACK_TIMEOUT,
  type RawDetection,
  type TrackProgress,
  type TrackPromptOptions,
} from "./sam";
import type { TrackedObject } from "./types";

/** Server time budget: documented timeout policy lives in the header above. */
export const TRACK_BUDGET_MS = 10 * 60 * 1000;

export interface TrackPromptFn {
  (
    fileId: string,
    category: string,
    onProgress?: (p: TrackProgress) => void,
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

export async function runTrackPrompts(deps: TrackRunDeps): Promise<TrackRunOutcome> {
  const { sessionId, fileId, fps, prompts, trackPrompt, persist, isCancelled, onFrame, onPromptDone } = deps;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? TRACK_BUDGET_MS;
  const startedAt = now();
  const overBudget = () => now() - startedAt > budgetMs;
  const categories = prompts.map((p) => p.trim().toLowerCase());
  const groups: TrackedObject[][] = [];
  // Mirrors exactly what was last persisted, so every terminal outcome
  // reports the same objects the store already holds — never silently more.
  let lastPersisted: TrackedObject[] = [];
  const save = (objects: TrackedObject[]) => {
    persist(objects);
    lastPersisted = objects;
  };
  for (let pi = 0; pi < categories.length; pi++) {
    if (isCancelled()) {
      return { status: "cancelled", objects: lastPersisted, completedPrompts: pi };
    }
    if (overBudget()) {
      return { status: "timeout", objects: lastPersisted, completedPrompts: pi };
    }
    const category = categories[pi];
    // Frames parsed so far for the ACTIVE prompt. Rebuilt into trackable
    // objects and persisted incrementally, so a cancel/timeout/disconnect
    // mid-prompt keeps evidence instead of dropping it. Never enters
    // `groups` (deduped below), so completed prompts are never duplicated.
    // IDs stay stable: buildTrackedObjects assigns them deterministically in
    // first-seen order, and the final build sees the same order.
    const partialFrames: { frameIndex: number; detections: RawDetection[] }[] = [];
    const seenFrame = new Set<number>();
    let raw: { frameIndex: number; detections: RawDetection[] }[];
    try {
      raw = await trackPrompt(
        fileId,
        category,
        (prog) => {
          // Enforce the server deadline DURING the prompt, not just between
          // prompts: a single giant stream must not consume the whole budget.
          if (overBudget()) throw new Error(TRACK_TIMEOUT);
          if (prog.frame && !seenFrame.has(prog.frame.frameIndex)) {
            seenFrame.add(prog.frame.frameIndex);
            partialFrames.push(prog.frame);
            const partial = buildTrackedObjects({ sessionId, category, frames: partialFrames, fps });
            save(mergeAndDedupe([...groups, partial]));
          }
          onFrame({ prompt: category, promptIndex: pi, frameIndex: prog.frameIndex, totalSoFar: prog.totalSoFar });
        },
        {
          signal: deps.signal,
          isCancelled,
          isExpired: overBudget,
        },
      );
    } catch (err) {
      if (err instanceof Error && err.message === TRACK_CANCELLED) {
        return { status: "cancelled", objects: lastPersisted, completedPrompts: pi };
      }
      if (err instanceof Error && err.message === TRACK_TIMEOUT) {
        return { status: "timeout", objects: lastPersisted, completedPrompts: pi };
      }
      // An aborted upstream request means manual cancel, client disconnect,
      // or an expired budget racing the abort. Classify explicitly — never a
      // silent "disconnected" when the cancel flag or budget says otherwise.
      if (isAbortError(err)) {
        if (isCancelled()) {
          return { status: "cancelled", objects: lastPersisted, completedPrompts: pi };
        }
        if (overBudget()) {
          return { status: "timeout", objects: lastPersisted, completedPrompts: pi };
        }
        return { status: "disconnected", objects: lastPersisted, completedPrompts: pi };
      }
      throw err;
    }
    // A prompt that finished after the deadline must not silently count as
    // completed — but its already-received detections are valid evidence, so
    // they are still built and persisted (never silently dropped).
    const finishedInBudget = !overBudget();
    const objects = buildTrackedObjects({ sessionId, category, frames: raw, fps });
    groups.push(objects);
    save(mergeAndDedupe(groups));
    onPromptDone({ prompt: category, count: objects.length });
    if (!finishedInBudget) {
      return { status: "timeout", objects: lastPersisted, completedPrompts: pi };
    }
  }
  return { status: "complete", objects: lastPersisted, completedPrompts: categories.length };
}
