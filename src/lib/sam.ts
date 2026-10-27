import { getMetaClient } from "./meta-client";
import { SAM_MODEL } from "./models";
import type { BoundingBox, TrackedFrame, TrackedObject } from "./types";

// Contract: SAM 3.1 helpers (PRD §6.2).
// Pure functions (parse/iou/merge) are offline-testable, zero API cost.
// Network functions (upload/track) retry 3× with backoff and fail loudly.

// ============ SSE parsing (Meta docs: /docs/sam/reading-segmentation) ============
// Real grammar: <Nf>id<|box;x1=..;y1=..;x2=..;y2=..;w=<frameW>;h=<frameH>|><|mask;...|>,...
// Frame marker <Nf> is zero-based, may skip frames, concept prompts ascend.
// Object ids are bare ints, sparse, stable across frames. Frames with no visible
// objects produce no line. Zero matches = empty lane (valid, not an error).

export interface RawDetection {
  objectId: string;
  bbox: BoundingBox | null; // null when coordinates unparseable (kept, confidence 0)
  maskRaw: string;
}

export interface ParsedFrameLine {
  frameIndex: number;
  detections: RawDetection[];
}

const FRAME_HEAD = /^<(\d+)f>/;
const RECORD_RE =
  /(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)(?:;c=[\d.]+)?\|><\|mask;x=0;y=0(?:;c=[\d.]+)?;data=\d+,\d+,[~!]/g;

// Normal: "<12f>0<|box;x1=10;...|>...,1<|box...|>..." → parsed.
// Empty: "" / whitespace → null. No frame head → null (fail loudly upstream).
export function parseSamLine(line: string): ParsedFrameLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const head = FRAME_HEAD.exec(trimmed);
  if (!head) return null;
  const frameIndex = Number(head[1]);
  if (!Number.isInteger(frameIndex) || frameIndex < 0) return null;
  const detections: RawDetection[] = [];
  RECORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RECORD_RE.exec(trimmed)) !== null) {
    const [, rawId, x1, y1, x2, y2, fw, fh] = m;
    const dw = Number(fw);
    const dh = Number(fh);
    const box =
      dw > 0 && dh > 0
        ? {
            x: Math.min(1, Math.max(0, Number(x1) / dw)),
            y: Math.min(1, Math.max(0, Number(y1) / dh)),
            w: Math.min(1, Math.max(0, (Number(x2) - Number(x1)) / dw)),
            h: Math.min(1, Math.max(0, (Number(y2) - Number(y1)) / dh)),
          }
        : null;
    if (box && (box.w <= 0 || box.h <= 0)) {
      detections.push({ objectId: rawId, bbox: null, maskRaw: "" });
    } else {
      detections.push({ objectId: rawId, bbox: box, maskRaw: "" });
    }
  }
  return { frameIndex, detections };
}

// ============ SSE stream accumulation (P1: split-record fix) ============
// Text deltas are token-sized, so one <Nf>... record can straddle events and two
// records can share one event. The accumulator keeps the remainder and yields
// only complete lines — feed every delta, drain at stream end. Pure + offline.
export interface SamStreamState {
  buffer: string;
}

export function createSamStream(): SamStreamState {
  return { buffer: "" };
}

// Pushes one text delta, returns newly-completed parsed frames (possibly zero).
export function pushSamDelta(state: SamStreamState, delta: string): ParsedFrameLine[] {
  state.buffer += delta;
  const out: ParsedFrameLine[] = [];
  let idx: number;
  while ((idx = state.buffer.indexOf("\n")) >= 0) {
    const line = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 1);
    const parsed = parseSamLine(line); // trims, so \r\n is safe
    if (parsed) out.push(parsed);
  }
  return out;
}

// Drains a final unterminated line at stream end. Empty remainder → [].
export function flushSamStream(state: SamStreamState): ParsedFrameLine[] {
  if (!state.buffer.trim()) {
    state.buffer = "";
    return [];
  }
  const parsed = parseSamLine(state.buffer);
  state.buffer = "";
  return parsed ? [parsed] : [];
}

// ============ IoU + dedupe ============

export function iou(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

const IOU_DEDUPE_THRESHOLD = 0.7;

// Groups raw frames into TrackedObjects per category. Assigns stable IDs
// `${category}-${n}` in first-seen order. Unparseable bboxes get a
// zero-area placeholder + confidence 0 (never drops the detection silently).
export function buildTrackedObjects(
  args: {
    sessionId: string;
    category: string;
    frames: { frameIndex: number; detections: RawDetection[] }[];
    fps: number;
  },
): TrackedObject[] {
  const { sessionId, category, frames, fps } = args;
  const safeFps = fps > 0 ? fps : 30;
  const byObject = new Map<string, TrackedFrame[]>();
  for (const f of frames) {
    for (const d of f.detections) {
      const bbox = d.bbox ?? { x: 0, y: 0, w: 0, h: 0 };
      const list = byObject.get(d.objectId) ?? [];
      list.push({
        frameIndex: f.frameIndex,
        timestamp: f.frameIndex / safeFps,
        bbox,
        confidence: bbox.w > 0 ? 1 : 0,
      });
      byObject.set(d.objectId, list);
    }
  }
  const sorted = Array.from(byObject.entries()).sort(
    (a: [string, TrackedFrame[]], b: [string, TrackedFrame[]]) =>
      a[1][0].frameIndex - b[1][0].frameIndex,
  );
  return sorted.map(([rawId, objFrames]: [string, TrackedFrame[]], i: number) => {
    const ordered = objFrames.sort(
      (a: TrackedFrame, b: TrackedFrame) => a.frameIndex - b.frameIndex,
    );
    return {
      id: `${category}-${String(i + 1).padStart(3, "0")}`,
      sessionId,
      category,
      color: colorForCategory(category, i),
      firstSeenFrame: ordered[0].frameIndex,
      lastSeenFrame: ordered[ordered.length - 1].frameIndex,
      totalFrameCount: ordered.length,
      frames: ordered,
      _rawId: rawId,
    } as TrackedObject & { _rawId: string };
  });
}

// Merges per-prompt results; dedupes objects whose representative boxes
// overlap IoU > 0.7 (keeps the longer-lived one). Pure + offline.
export function mergeAndDedupe(
  groups: TrackedObject[][],
): TrackedObject[] {
  const all = groups.flat();
  const kept: TrackedObject[] = [];
  for (const obj of all) {
    const repA = obj.frames[Math.floor(obj.frames.length / 2)]?.bbox;
    let dup = false;
    for (const k of kept) {
      const repB = k.frames[Math.floor(k.frames.length / 2)]?.bbox;
      if (repA && repB && iou(repA, repB) > IOU_DEDUPE_THRESHOLD) {
        dup = true;
        if (obj.totalFrameCount > k.totalFrameCount) {
          kept[kept.indexOf(k)] = obj;
        }
        break;
      }
    }
    if (!dup) kept.push(obj);
  }
  return kept;
}

// ============ Colors ============

const PALETTE = [
  "#FF6B6B",
  "#4ECDC4",
  "#FFD93D",
  "#6BCB77",
  "#4D96FF",
  "#FF9F45",
  "#B983FF",
  "#FF5DA2",
];

export function colorForCategory(category: string, index: number): string {
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
  }
  return PALETTE[(hash + index) % PALETTE.length];
}

// ============ Retry ============

const RETRY_DELAYS_MS = [2000, 4000, 8000];

export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[] = RETRY_DELAYS_MS,
  retryable: (err: unknown) => boolean = () => true,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!retryable(err)) throw err;
      if (attempt === delaysMs.length) break;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
  throw last;
}

// ============ Retry safety: what may be retried ============
//
// trackPrompt streams provider output while also invoking downstream progress
// callbacks. Three failure classes must NEVER be retried as provider errors:
// cooperative cancellation, client aborts, and dead-stream sends (retrying
// those re-burns quota and delays termination). HTTP 4xx (other than 429 and
// the retryable 408/425) will not heal on retry either.

/** Cooperative-cancel sentinel thrown by progress callbacks. Never surfaced, never retried. */
export const TRACK_CANCELLED = "__CANCELLED__";

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || /\babort/i.test(err.message))
  );
}

/**
 * True when a send/stream failure means only that the client went away
 * (observed: "Invalid state: Controller is already closed"). Such failures
 * must be reported as a disconnect — never as a model error, never retried.
 */
export function isStreamClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already closed/i.test(msg);
}

function providerStatus(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
}

/** Only retry failures that are safe and meaningful: transient network/5xx and rate limits. */
export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof Error && err.message === TRACK_CANCELLED) return false;
  if (isAbortError(err)) return false;
  if (isStreamClosedError(err)) return false;
  const status = providerStatus(err);
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429)
    return false;
  return true;
}

// ============ Network: Files upload ============

export async function uploadVideoToFiles(
  data: Buffer,
  filename: string,
): Promise<string> {
  const client = getMetaClient();
  const file = new File([new Uint8Array(data)], filename, {
    type: filename.endsWith(".mov") ? "video/quicktime" : "video/mp4",
  });
  const created = await withRetry(() =>
    client.files.create({ file, purpose: "user_data" }),
  );
  return created.id;
}

// ============ Bounded opt-in diagnostics (GRIDSIGHT_DEBUG_SAM=1) ============
// Distinguishes "model returned nothing" from "parser recognized nothing".
// Additive logging only: parser, prompts, retries, and schema are untouched.
// Never logs credentials, full masks, or media payloads: the head is capped
// and mask blobs are redacted before logging. Raw responses are never dumped.

export const SAM_DEBUG_HEAD_CHARS = 1500;

export interface SamDebugSummary {
  prompt: string;
  totalChars: number;
  maxDeltaChars: number;
  maxLineBuffer: number;
  streamCompleted: boolean;
  parsedFrames: number;
  matchedRecords: number;
  head: string;
}

/** Drop mask blobs (which dominate multi-MB responses) but keep box coords. */
export function redactMaskPayloads(head: string): string {
  return head.replace(/data=\S+/g, "data=<redacted>");
}

/** Pure one-line stderr summary. Truncated, redacted, counts — never secrets. */
export function formatSamDebug(summary: SamDebugSummary): string {
  const head = redactMaskPayloads(summary.head.slice(0, SAM_DEBUG_HEAD_CHARS))
    .replace(/\s+/g, " ")
    .trim();
  return (
    `[sam-debug] prompt=${JSON.stringify(summary.prompt)} ` +
    `chars=${summary.totalChars} maxDelta=${summary.maxDeltaChars} maxLine=${summary.maxLineBuffer} ` +
    `completed=${summary.streamCompleted} ` +
    `parsedFrames=${summary.parsedFrames} matchedRecords=${summary.matchedRecords} ` +
    `head=${JSON.stringify(head)}`
  );
}

export function samDebugEnabled(): boolean {
  return process.env.GRIDSIGHT_DEBUG_SAM === "1";
}

// ============ Network: SAM track ============

export interface TrackProgress {
  frameIndex: number;
  totalSoFar: number;
}

export interface TrackPromptOptions {
  /** AbortSignal forwarded to the provider request (manual cancel, client disconnect). */
  signal?: AbortSignal;
}

export async function trackPrompt(
  fileId: string,
  prompt: string,
  onProgress?: (p: TrackProgress) => void,
  opts?: TrackPromptOptions,
): Promise<{ frameIndex: number; detections: RawDetection[] }[]> {
  const client = getMetaClient();
  const debug = samDebugEnabled()
    ? { head: "", totalChars: 0, maxDelta: 0, maxLine: 0, completed: false }
    : null;
  // Retry isolation: every provider attempt gets its own detections and
  // parser state. A failed attempt's frames must never leak into a retry.
  const collected = await withRetry(
    async () => {
      const attempt: { frameIndex: number; detections: RawDetection[] }[] = [];
      const stream = await client.responses.create(
        {
          model: SAM_MODEL,
          stream: true,
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_video", file_id: fileId },
              ],
            },
          ],
        } as never,
        { signal: opts?.signal ?? undefined } as never,
      );
      // Accumulate deltas: one record can straddle events (P1 split-record fix).
      const acc = createSamStream();
      const emit = (parsed: { frameIndex: number; detections: RawDetection[] }) => {
        attempt.push(parsed);
        onProgress?.({
          frameIndex: parsed.frameIndex,
          totalSoFar: attempt.length,
        });
      };
      for await (const event of stream as unknown as AsyncIterable<unknown>) {
        const text = extractTextDelta(event);
        if (!text) continue;
        if (debug) {
          // Bounded: counters only, plus a capped head. Never retain the stream.
          debug.totalChars += text.length;
          if (text.length > debug.maxDelta) debug.maxDelta = text.length;
          for (const part of text.split("\n")) {
            if (part.length > debug.maxLine) debug.maxLine = part.length;
          }
          if (debug.head.length < SAM_DEBUG_HEAD_CHARS) {
            debug.head += text.slice(0, SAM_DEBUG_HEAD_CHARS - debug.head.length);
          }
        }
        for (const parsed of pushSamDelta(acc, text)) emit(parsed);
      }
      for (const parsed of flushSamStream(acc)) emit(parsed);
      if (debug) {
        debug.completed = true;
        // Line-buffer high-water mark (partial lines held between chunks).
        if (acc.buffer.length > debug.maxLine) debug.maxLine = acc.buffer.length;
      }
      return attempt;
    },
    undefined,
    isRetryableProviderError,
  );
  if (debug) {
    const matchedRecords = collected.reduce((n, f) => n + f.detections.length, 0);
    console.error(
      formatSamDebug({
        prompt,
        totalChars: debug.totalChars,
        maxDeltaChars: debug.maxDelta,
        maxLineBuffer: debug.maxLine,
        streamCompleted: debug.completed,
        parsedFrames: collected.length,
        matchedRecords,
        head: debug.head,
      }),
    );
  }
  return collected;
}

function extractTextDelta(event: unknown): string {
  if (typeof event === "string") return event;
  if (event && typeof event === "object") {
    const e = event as Record<string, unknown>;
    if (typeof e.delta === "string") return e.delta;
    if (typeof e.text === "string") return e.text;
    if (typeof e.output_text === "string") return e.output_text;
  }
  return "";
}
