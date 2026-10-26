import { readFile } from "node:fs/promises";
import { buildTranscriptSegments } from "./audio";
import { validateReport } from "./report";
import { validateTaggedNotes } from "./tagging";
import type { DefectReport, TaggedNote, TrackedObject, TranscriptSegment } from "./types";

// Contract: golden-dataset loader for USE_CACHED demos (Phase 7+).
// Fixtures are stored session-agnostic ("demo"); the loader remaps sessionId
// (and segmentIds for tags) to the requesting session so cross-links hold.
// Throws loudly on missing/invalid fixture (demo must fail visibly, never half-loaded).

export type DemoName = "tracking" | "transcript" | "tagged" | "report";

export async function loadDemoJson(name: DemoName): Promise<unknown> {
  const raw = await readFile(`fixtures/demo-session/${name}.json`, "utf8").catch(() => null);
  if (raw === null) throw new Error(`Demo fixture missing: fixtures/demo-session/${name}.json`);
  return JSON.parse(raw) as unknown;
}

export async function demoTracking(sessionId: string): Promise<TrackedObject[]> {
  const raw = (await loadDemoJson("tracking")) as TrackedObject[];
  return raw.map((o) => ({ ...o, sessionId }));
}

export async function demoTranscript(sessionId: string): Promise<TranscriptSegment[]> {
  const raw = await loadDemoJson("transcript");
  return buildTranscriptSegments(raw, sessionId);
}

export async function demoTagged(sessionId: string): Promise<TaggedNote[]> {
  const raw = await loadDemoJson("tagged");
  const notes = validateTaggedNotes(raw);
  // Re-key segmentIds to this session's transcript ids (order-preserving).
  return notes.map((n, i) => ({
    ...n,
    segmentId: `${sessionId}-seg-${String(i).padStart(3, "0")}`,
  }));
}

export async function demoReport(sessionId: string): Promise<DefectReport> {
  const raw = await loadDemoJson("report");
  const validated = validateReport(raw, { id: `rep-${sessionId.slice(0, 8)}`, sessionId });
  return { ...validated, id: `rep-${sessionId.slice(0, 8)}`, sessionId };
}
