import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSparkClient } from "@/lib/meta-client";
import { getSparkConfig } from "@/lib/models";
import { extractFrame } from "@/lib/ffmpeg";
import { verifyDefects } from "@/lib/verify";
import {
  MAX_KEY_FRAME_BYTES,
  MAX_KEY_FRAMES,
  REPORT_SYSTEM_PROMPT,
  attachFrameCaptures,
  attachOverlayBox,
  coveragePercent,
  labelEvidence,
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
// report_started | verify_started | verification_result (×N) | defect_found (×N) | report_complete.
// 200-stream · 400 nothing to report · 404 session · 502 Spark failure (no fabricated fallback).
// Key frames are sent to Spark as images (visual ground truth); with no frames
// (ffmpeg missing / no video) the call degrades to text-only, exactly as before.
// Muse Image annotation is OFF the critical path (it can invent damage); the UI
// renders deterministic bbox overlays instead. images.ts stays for tests/optional use.
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

  // Resolve the Spark endpoint before streaming: misconfiguration fails fast as
  // JSON, never as a mid-stream surprise and never as a silent fallback.
  let spark: ReturnType<typeof getSparkConfig>;
  try {
    spark = getSparkConfig();
  } catch (err) {
    return NextResponse.json(
      { error: { code: "spark_misconfigured", message: err instanceof Error ? err.message : "Spark misconfigured." } },
      { status: 500 },
    );
  }

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
              const { size } = await stat(out);
              if (size > MAX_KEY_FRAME_BYTES) {
                console.error(
                  `key frame ${i} skipped: ${size}B exceeds ${MAX_KEY_FRAME_BYTES}B budget`,
                );
                continue;
              }
              const b64 = await readFile(out, "base64");
              frames.push({ timestamp: stamps[i], base64: b64 });
            } catch (e) {
              console.error(`key frame ${i} failed:`, e instanceof Error ? e.message : e);
            }
          }
        }

        const client = getSparkClient();
        // Vision message: metadata text first (field names kept), then one
        // FRAME i text marker + image part per key frame, in order. The model
        // cites evidence with evidenceFrameIndex into this same order.
        const userParts: (
          | { type: "text"; text: string }
          | { type: "image_url"; image_url: { url: string } }
        )[] = [
          {
            type: "text",
            text: JSON.stringify({
              frames_attached: frames.length,
              frame_note:
                "The attached key frames FRAME 0..N are the visual ground truth, in order. Cite visual claims with evidenceFrameIndex.",
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
        ];
        frames.forEach((f, i) => {
          userParts.push({ type: "text", text: `FRAME ${i} @ t=${f.timestamp.toFixed(2)}s` });
          userParts.push({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${f.base64}` },
          });
        });
        const res = await client.chat.completions.create({
          model: spark.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: REPORT_SYSTEM_PROMPT },
            { role: "user", content: userParts },
          ],
        });
        const text = res.choices[0]?.message?.content ?? "";
        const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
        const raw = JSON.parse((fenced ? fenced[1] : text).trim()) as unknown;

        const now = new Date().toISOString();
        // Envelope-tolerant: models often return just {summary, defects} (or a bare
        // array) and drop the inspection/statistics envelope. Validate the defects —
        // the part that matters — then label evidence server-side (never trust the
        // model for it), verify each visual claim against its cited frame
        // (keep/downgrade/drop, fully logged), pin survivors to their frames,
        // attach nearest captures for the rest, add deterministic bbox overlays.
        const rawObj =
          typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        const summary =
          typeof rawObj.summary === "string" && rawObj.summary ? rawObj.summary : "Inspection complete. See defects below.";
        const labeled = labelEvidence(validateDefects("defects" in rawObj ? rawObj : raw), frames);

        // Verification pass (50→65 progress band): the model audits its own visual
        // findings. Cap 8 calls; voice-only findings and errors never delete.
        const verifyTotal = Math.min(
          labeled.filter((d) => d.evidenceSource === "visual").length,
          8,
        );
        send("verify_started", { count: verifyTotal });
        updateJobProgress(job.id, 50, 100);
        const verificationCounts = { kept: 0, downgraded: 0, dropped: 0, skipped: 0 };
        let verifyDone = 0;
        const verified = await verifyDefects(labeled, {
          frames,
          videoPath,
          sessionId,
          client,
          model: spark.model,
          cap: 8,
          checkCancel,
          onVerdict: (id, v) => {
            verifyDone++;
            if (v.verdict === "keep") verificationCounts.kept++;
            else if (v.verdict === "downgrade") verificationCounts.downgraded++;
            else if (v.verdict === "drop") verificationCounts.dropped++;
            else verificationCounts.skipped++;
            updateJobProgress(
              job.id,
              50 + Math.round((verifyDone / Math.max(1, verifyTotal)) * 15),
              100,
            );
            send("verification_result", { id, verdict: v.verdict, reason: v.reason });
          },
        });

        const defects = sortDefects(
          attachOverlayBox(attachFrameCaptures(verified, frames), objects),
        );

        for (let i = 0; i < defects.length; i++) {
          const d = defects[i];
          checkCancel();
          updateJobProgress(job.id, 65 + Math.round((i / Math.max(1, defects.length)) * 15), 100);
          // Slim event: full defect (incl. ~0.5MB base64 frames) arrives once at
          // report_complete. Streaming it N times stalls first-paint of progress.
          send("defect_found", {
            currentDefect: { id: d.id, severity: d.severity, title: d.title },
          });
        }

        // No generative annotation on the critical path: Muse Image edits can
        // invent damage on a clean frame, unacceptable in a safety context.
        // Defects render with their real key frame + deterministic bbox overlay.
        const finalDefects = defects;

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
          statistics: { ...rollupStats(finalDefects), verification: verificationCounts },
          generatedAt: now,
          // Provenance: which Spark endpoint wrote these defects.
          modelRun: { provider: spark.provider, model: spark.model },
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
