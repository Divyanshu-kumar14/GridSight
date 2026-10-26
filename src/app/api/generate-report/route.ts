import { readdir, readFile, writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getMetaClient } from "@/lib/meta-client";
import { extractFrame } from "@/lib/ffmpeg";
import { annotateDefects, selectAnnotatable } from "@/lib/images";
import {
  MAX_KEY_FRAMES,
  REPORT_SYSTEM_PROMPT,
  attachFrameCaptures,
  coveragePercent,
  pickKeyTimestamps,
  rollupStats,
  sortDefects,
  validateDefects,
  type KeyFrame,
} from "@/lib/report";
import type { DefectReport } from "@/lib/types";
import { demoReport } from "@/lib/demo-fixture";
import { completeJob, createJob, failJob, isCancelled, updateJobProgress } from "@/lib/jobs";
import {
  ensureScratchDirs,
  getReport,
  getSession,
  getTaggedNotes,
  getTracking,
  getTranscript,
  scratchDir,
  setReport,
  updateSession,
} from "@/lib/store";

// POST /api/generate-report — { sessionId } → SSE:
// report_started | defect_found (×N) | image_generating | report_complete.
// 200-stream · 400 nothing to report · 404 session · 502 Spark failure (no fabricated fallback).
// GET ?sessionId= → stored report JSON (memory, else scratch file) · 404 if absent.
// USE_CACHED=true → scratch JSON if captured, else golden dataset. Zero burn.
const bodySchema = z.object({ sessionId: z.string().min(1) });

async function findSessionVideo(sessionId: string): Promise<string | null> {
  const entries = await readdir(`${scratchDir()}/video`).catch(() => [] as string[]);
  const hit = entries.filter((e) => e.startsWith(sessionId)).sort()[0];
  return hit ? `${scratchDir()}/video/${hit}` : null;
}

export async function POST(req: Request): Promise<Response> {
  const body: unknown = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Expected JSON { sessionId }." } },
      { status: 400 },
    );
  }
  const { sessionId } = parsed.data;
  const session = getSession(sessionId);
  if (!session) {
    return NextResponse.json(
      { error: { code: "not_found", message: `Unknown session ${sessionId}.` } },
      { status: 404 },
    );
  }

  if (process.env.USE_CACHED === "true") {
    const cached = await readFile(`${scratchDir()}/reports/${sessionId}.json`, "utf8").catch(() => null);
    const report = cached ? (JSON.parse(cached) as unknown) : await demoReport(sessionId);
    setReport(sessionId, report as never);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(`data: ${JSON.stringify({ type: "report_complete", data: { report, cached: true } })}\n\n`);
        c.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }

  const objects = getTracking(sessionId);
  if (objects.length === 0) {
    return NextResponse.json(
      { error: { code: "nothing_to_report", message: "No tracked objects. Run tracking first." } },
      { status: 400 },
    );
  }
  const tagged = getTaggedNotes(sessionId);
  const transcript = getTranscript(sessionId);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, data: unknown) => {
        controller.enqueue(`data: ${JSON.stringify({ type, data })}\n\n`);
      };
      const CANCELLED = "__CANCELLED__";
      const job = createJob(sessionId, "report", 100);
      const checkCancel = () => {
        if (isCancelled(job.id)) throw new Error(CANCELLED);
      };
      try {
        updateSession(sessionId, { status: "generating" });
        send("report_started", { sessionId, objects: objects.length, jobId: job.id });

        // Key frames: first-seen per object (capped), best-effort — missing video skips silently here, loudly in logs.
        const frames: KeyFrame[] = [];
        const videoPath = await findSessionVideo(sessionId);
        if (videoPath) {
          ensureScratchDirs();
          const stamps = pickKeyTimestamps(objects, tagged);
          for (let i = 0; i < Math.min(stamps.length, MAX_KEY_FRAMES); i++) {
            try {
              const out = `${scratchDir()}/frames/${sessionId}-key-${i}.jpg`;
              await extractFrame(videoPath, stamps[i], out);
              const b64 = await readFile(out, "base64");
              frames.push({ timestamp: stamps[i], base64: b64 });
            } catch (e) {
              console.error(`key frame ${i} failed:`, e instanceof Error ? e.message : e);
            }
          }
        }

        const client = getMetaClient();
        const res = await client.chat.completions.create({
          model: "muse-spark-1.3",
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: REPORT_SYSTEM_PROMPT },
            {
              role: "user",
              content: JSON.stringify({
                tracked_assets: objects.map((o) => ({
                  id: o.id,
                  category: o.category,
                  firstSeen: o.frames[0]?.timestamp ?? 0,
                  lastSeen: o.frames[o.frames.length - 1]?.timestamp ?? 0,
                  frameCount: o.totalFrameCount,
                })),
                tagged_notes: tagged,
                voice_transcript: transcript,
                key_frame_timestamps: frames.map((f) => f.timestamp),
                inspection_metadata: {
                  substation: session.substationName,
                  date: session.date,
                  inspector: session.inspectorName,
                },
              }),
            },
          ],
        });
        const text = res.choices[0]?.message?.content ?? "";
        const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
        const raw = JSON.parse((fenced ? fenced[1] : text).trim()) as unknown;

        const now = new Date().toISOString();
        // Envelope-tolerant: models often return just {summary, defects} (or a bare
        // array) and drop the inspection/statistics envelope. Validate the defects —
        // the part that matters — and build the envelope server-side, always.
        const rawObj =
          typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        const summary =
          typeof rawObj.summary === "string" && rawObj.summary ? rawObj.summary : "Inspection complete. See defects below.";
        const defects = attachFrameCaptures(
          sortDefects(validateDefects("defects" in rawObj ? rawObj : raw)),
          frames,
        );
        updateJobProgress(job.id, 50, 100);

        for (let i = 0; i < defects.length; i++) {
          const d = defects[i];
          checkCancel();
          updateJobProgress(job.id, 50 + Math.round((i / Math.max(1, defects.length)) * 30), 100);
          // Slim event: full defect (incl. ~0.5MB base64 frames) arrives once at
          // report_complete. Streaming it N times stalls first-paint of progress.
          send("defect_found", {
            currentDefect: { id: d.id, severity: d.severity, title: d.title },
          });
        }

        // Annotated visuals: Muse Image edits on key frames (cap 5, skip-safe).
        const targets = selectAnnotatable(defects);
        send("image_generating", { started: true, total: targets.length });
        const editFn = async (frameBase64: string, prompt: string): Promise<string | null> => {
          const imgFile = new File(
            [new Uint8Array(Buffer.from(frameBase64, "base64"))],
            "frame.jpg",
            { type: "image/jpeg" },
          );
          const out = await client.images.edit({
            model: "muse-image-1.0",
            image: imgFile,
            prompt,
          } as never);
          const b64 = (out as unknown as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
          return b64 ?? null;
        };
        const finalDefects = await annotateDefects(defects, async (frame, prompt) => {
          try {
            return await editFn(frame, prompt);
          } catch (e) {
            console.error("annotation skipped:", e instanceof Error ? e.message : e);
            return null;
          }
        });
        send("image_generating", { started: false, total: targets.length });

        const report: DefectReport = {
          id: `rep-${sessionId.slice(0, 8)}`,
          sessionId,
          inspection: {
            substationId: `sub-${sessionId.slice(0, 8)}`,
            substationName: session.substationName,
            inspector: session.inspectorName,
            date: session.date,
            totalAssetsTracked: objects.length,
            totalDefectsFound: finalDefects.length,
            coveragePercent: coveragePercent(objects),
          },
          summary,
          defects: finalDefects,
          statistics: rollupStats(finalDefects),
          generatedAt: now,
        };

        setReport(sessionId, report);
        ensureScratchDirs();
        await writeFile(`${scratchDir()}/reports/${sessionId}.json`, JSON.stringify(report, null, 2));
        updateSession(sessionId, { status: "complete" });
        completeJob(job.id);
        updateJobProgress(job.id, 100, 100);
        send("report_complete", { report });
        controller.close();
      } catch (err) {
        if (err instanceof Error && err.message === CANCELLED) {
          updateSession(sessionId, { status: "generating" });
          send("cancelled", { jobId: job.id });
          controller.close();
          return;
        }
        failJob(job.id, err instanceof Error ? err.message : "Report generation failed.");
        updateSession(sessionId, { status: "error" });
        send("error", {
          message: err instanceof Error ? err.message.slice(0, 300) : "Report generation failed.",
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

// GET /api/generate-report?sessionId= → stored report (memory, else scratch JSON).
export async function GET(req: Request): Promise<NextResponse> {
  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
  if (!sessionId) {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Query param sessionId is required." } },
      { status: 400 },
    );
  }
  const memory = getReport(sessionId);
  if (memory) return NextResponse.json({ report: memory });
  const file = await readFile(`${scratchDir()}/reports/${sessionId}.json`, "utf8").catch(() => null);
  if (file) {
    return NextResponse.json({ report: JSON.parse(file) as unknown });
  }
  if (process.env.USE_CACHED === "true") {
    const demo = await demoReport(sessionId);
    setReport(sessionId, demo);
    return NextResponse.json({ report: demo, cached: true });
  }
  return NextResponse.json(
    { error: { code: "not_found", message: "No report for this session yet." } },
    { status: 404 },
  );
}
