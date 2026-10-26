import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildTrackedObjects,
  mergeAndDedupe,
  trackPrompt,
} from "@/lib/sam";
import { getSession, setTracking, updateSession } from "@/lib/store";
import { demoTracking } from "@/lib/demo-fixture";
import { completeJob, createJob, failJob, isCancelled, updateJobProgress } from "@/lib/jobs";
import type { TrackedObject } from "@/lib/types";

// POST /api/track — { sessionId, prompts[] } → SSE stream.
// Events: progress | object_detected | frame_complete | tracking_complete.
// USE_CACHED=true → offline canned stream, zero Meta burn.
const bodySchema = z.object({
  sessionId: z.string().min(1),
  prompts: z.array(z.string().min(1).max(80)).min(1).max(10),
});

// Native fps comes from the session (probed at upload); 30 only when unknown.

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Expected JSON { sessionId, prompts[] }." } },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "sessionId and 1–10 prompts required.", issues: parsed.error.issues } },
      { status: 400 },
    );
  }
  const { sessionId, prompts } = parsed.data;
  const session = getSession(sessionId);
  if (!session) {
    return NextResponse.json(
      { error: { code: "not_found", message: `Unknown session ${sessionId}.` } },
      { status: 404 },
    );
  }

  const job = createJob(sessionId, "track", prompts.length);
  // Native frame rate probed at upload (SAM emits native-rate indices).
  const fps = session.videoFps && session.videoFps > 0 ? session.videoFps : 30;
  const expectedTotal =
    session.videoDurationSec > 0 ? session.videoDurationSec * fps : 0;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, data: unknown) => {
        controller.enqueue(`data: ${JSON.stringify({ type, data })}\n\n`);
      };
      const CANCELLED = "__CANCELLED__";
      try {
        updateSession(sessionId, { status: "tracking" });
        send("started", { jobId: job.id });

        if (process.env.USE_CACHED === "true") {
          const demo = await demoTracking(sessionId);
          setTracking(sessionId, demo);
          updateJobProgress(job.id, 1, 1);
          completeJob(job.id);
          updateSession(sessionId, { status: "transcribing" });
          send("progress", { progress: 100, note: "golden dataset" });
          send("tracking_complete", { sessionId, objects: demo, cached: true });
          controller.close();
          return;
        }

        const groups: TrackedObject[][] = [];
        let totalFrames = 0;
        for (let pi = 0; pi < prompts.length; pi++) {
          const prompt = prompts[pi];
          const category = prompt.trim().toLowerCase();
          const raw = await trackPrompt(session.videoFileId, category, (p) => {
            totalFrames = Math.max(totalFrames, p.frameIndex);
            updateJobProgress(job.id, pi, prompts.length);
            if (isCancelled(job.id)) throw new Error(CANCELLED);
            // Honest progress: share of expected frames for this prompt's slice.
            const frac =
              expectedTotal > 0
                ? Math.min(0.999, p.frameIndex / expectedTotal)
                : Math.min(0.999, p.totalSoFar / 1500);
            send("progress", {
              prompt: category,
              frameIndex: p.frameIndex,
              progress: Math.min(99, Math.round(((pi + frac) / prompts.length) * 100)),
            });
          });
          const objects = buildTrackedObjects({
            sessionId,
            category,
            frames: raw,
            fps,
          });
          groups.push(objects);
          send("object_detected", { prompt: category, count: objects.length });
          send("frame_complete", { prompt: category, totalFrames });
        }
        const merged = mergeAndDedupe(groups);
        setTracking(sessionId, merged);
        updateSession(sessionId, { status: "transcribing" });
        completeJob(job.id);
        send("tracking_complete", {
          sessionId,
          objects: merged,
          totalFrames,
        });
        controller.close();
      } catch (err) {
        if (err instanceof Error && err.message === CANCELLED) {
          updateSession(sessionId, { status: "tracking" });
          send("cancelled", { jobId: job.id });
          controller.close();
          return;
        }
        failJob(job.id, err instanceof Error ? err.message : "Tracking failed.");
        updateSession(sessionId, { status: "error" });
        send("error", {
          message: err instanceof Error ? err.message.slice(0, 300) : "Tracking failed.",
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
