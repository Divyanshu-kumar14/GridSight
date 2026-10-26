// Phase 7 capture tool: runs the FULL live pipeline once and snapshots every
// intermediate response into fixtures/demo-session/ (golden dataset).
// Usage:
//   MODEL_API_KEY=... BASE_URL=http://localhost:3000 VIDEO=./clip.mp4 AUDIO=./memo.wav \
//     npx tsx scripts/cache-demo.ts
// Contract: requires dev server running + key set. Never overwrites on failure
// (writes only after report_complete). Prints what it captured.
// Zero impact on verification: not imported by app code.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const VIDEO = process.env.VIDEO;
const AUDIO = process.env.AUDIO;

if (!VIDEO) throw new Error("Set VIDEO=./clip.mp4 (AUDIO= optional).");
if (!process.env.MODEL_API_KEY) throw new Error("Set MODEL_API_KEY.");

interface SSEEvent {
  type: string;
  data?: unknown;
}

async function sseEvents(res: Response): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5)) as SSEEvent);
    }
  }
  return events;
}

async function main(): Promise<void> {
  // 1. Upload
  const fd = new FormData();
  fd.append("video", new Blob([new Uint8Array(readFileSync(VIDEO as string))]), "demo-clip.mp4");
  if (AUDIO) {
    fd.append("audio", new Blob([new Uint8Array(readFileSync(AUDIO))]), "demo-memo.wav");
  }
  fd.append("substationName", "East Bus Substation");
  fd.append("inspectorName", "Carlos Mendez");
  const up = await fetch(`${BASE}/api/upload`, { method: "POST", body: fd });
  if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text()}`);
  const { sessionId } = (await up.json()) as { sessionId: string };
  console.log("session:", sessionId);

  // 2. Track (SSE)
  const track = await fetch(`${BASE}/api/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, prompts: ["insulator", "transformer", "connector", "busbar"] }),
  });
  const trackEvents = await sseEvents(track);
  const complete = trackEvents.find((e) => e.type === "tracking_complete")?.data as
    | { objects?: unknown[] }
    | undefined;
  if (!complete?.objects) throw new Error("tracking produced no objects — not caching.");
  console.log("tracked objects:", complete.objects.length);

  // 3. Transcribe
  const tr = await fetch(`${BASE}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!tr.ok) throw new Error(`transcribe failed: ${tr.status} ${await tr.text()}`);
  const trJson = (await tr.json()) as { segments: { speaker: string; startTime: number; endTime: number; text: string }[] };
  console.log("segments:", trJson.segments.length);

  // 4. Tag
  const tag = await fetch(`${BASE}/api/tag-assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!tag.ok) throw new Error(`tag failed: ${tag.status} ${await tag.text()}`);
  const tagJson = (await tag.json()) as { taggedNotes: { segmentId: string }[]; fallback: boolean };
  console.log("tagged:", tagJson.taggedNotes.length, "fallback:", tagJson.fallback);

  // 5. Report (SSE)
  const rep = await fetch(`${BASE}/api/generate-report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const repEvents = await sseEvents(rep);
  const done = repEvents.find((e) => e.type === "report_complete")?.data as
    | { report?: Record<string, unknown> }
    | undefined;
  if (!done?.report) throw new Error("report incomplete — not caching.");
  const defects = (done.report.defects ?? []) as unknown[];
  console.log("defects:", defects.length);

  // 6. Snapshot (session-agnostic: re-key to "demo", strip bulky base64).
  mkdirSync("fixtures/demo-session", { recursive: true });
  const rekey = <T extends { sessionId: string }>(items: T[]): T[] =>
    items.map((o) => ({ ...o, sessionId: "demo" }));
  writeFileSync(
    "fixtures/demo-session/tracking.json",
    JSON.stringify(rekey(complete.objects as { sessionId: string }[]), null, 2),
  );
  writeFileSync(
    "fixtures/demo-session/transcript.json",
    JSON.stringify(
      {
        segments: trJson.segments.map((s) => ({
          speaker: s.speaker,
          start: s.startTime,
          end: s.endTime,
          text: s.text,
        })),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    "fixtures/demo-session/tagged.json",
    JSON.stringify(
      (tagJson.taggedNotes as Record<string, unknown>[]).map(
        (n: Record<string, unknown>, i: number) => ({ ...n, segmentId: `demo-seg-${String(i).padStart(3, "0")}` }),
      ),
      null,
      2,
    ),
  );
  const slim = { ...(done.report as Record<string, unknown>), id: "rep-demo", sessionId: "demo" } as Record<string, unknown>;
  slim.defects = (slim.defects as Record<string, unknown>[]).map((d) => {
    const { frameCapture: _fc, annotatedImage: _ai, ...rest } = d;
    void _fc;
    void _ai;
    return rest;
  });
  writeFileSync("fixtures/demo-session/report.json", JSON.stringify(slim, null, 2));
  console.log("cached fixtures/demo-session/ — verify with: npm test -- demo-fixture");
}

main().catch((err) => {
  console.error("cache-demo failed (nothing written):", err instanceof Error ? err.message : err);
  process.exit(1);
});
