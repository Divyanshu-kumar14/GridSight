import { NextResponse } from "next/server";
import { z } from "zod";
import { trackPrompt } from "@/lib/sam";
import { getSession, setTracking, updateSession } from "@/lib/store";
import { demoTracking } from "@/lib/demo-fixture";
import { completeJob, createJob, failJob, isCancelled, updateJobProgress } from "@/lib/jobs";
import {
  isStreamClosedError,
  runTrackPrompts,
  TRACK_CANCELLED,
} from "@/lib/track-run";

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
      const closed = (fn: () => void) => {
        // A dead client must never take down the run: persist first (done by
        // the orchestrator after every prompt), then report accurately.
        try {
          fn();
        } catch {
          /* stream already gone — job table carries the status */
        }
      };
      // Visible to catch: how much survived if a late send fails.
      let lastPersisted = 0;
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

        // Prompt loop with incremental persistence: earlier prompts survive a
        // late failure, cancel, or budget timeout (see lib/track-run.ts).
        let totalFrames = 0;
        let completedPrompts = 0;
        const outcome = await runTrackPrompts({
          sessionId,
          fileId: session.videoFileId,
          fps,
          prompts,
          trackPrompt,
          persist: (objects) => {
            setTracking(sessionId, objects);
            lastPersisted = objects.length;
          },
          isCancelled: () => isCancelled(job.id),
          onFrame: ({ prompt: category, promptIndex: pi, frameIndex, totalSoFar }) => {
            totalFrames = Math.max(totalFrames, frameIndex);
            updateJobProgress(job.id, pi, prompts.length);
            if (isCancelled(job.id)) throw new Error(TRACK_CANCELLED);
            // Honest progress: share of expected frames for this prompt's slice.
            const frac =
              expectedTotal > 0
                ? Math.min(0.999, frameIndex / expectedTotal)
                : Math.min(0.999, totalSoFar / 1500);
            send("progress", {
              prompt: category,
              frameIndex,
              progress: Math.min(99, Math.round(((pi + frac) / prompts.length) * 100)),
            });
          },
          onPromptDone: ({ prompt: category, count }) => {
            send("object_detected", { prompt: category, count });
            send("frame_complete", { prompt: category, totalFrames });
          },
        });
        completedPrompts = outcome.completedPrompts;
        if (outcome.status === "complete") {
          updateSession(sessionId, { status: "transcribing" });
          completeJob(job.id);
          send("tracking_complete", {
            sessionId,
            objects: outcome.objects,
            totalFrames,
          });
          controller.close();
          return;
        }
        if (outcome.status === "cancelled") {
          updateSession(sessionId, { status: "tracking" });
          send("cancelled", {
            jobId: job.id,
            partialObjects: outcome.objects.length,
            completedPrompts,
          });
          closed(() => controller.close());
          return;
        }
        // Timeout: explicit failure status, partials already persisted.
        failJob(
          job.id,
          `time budget exceeded after ${completedPrompts} of ${prompts.length} prompt(s); partial results preserved (${outcome.objects.length} objects)`,
        );
        updateSession(sessionId, { status: "error" });
        closed(() =>
          send("error", {
            code: "track_timeout",
            message: `Tracking stopped: time budget exceeded after ${completedPrompts} of ${prompts.length} prompt(s); ${outcome.objects.length} partial object(s) saved.`,
          }),
        );
        closed(() => controller.close());
      } catch (err) {
        if (isStreamClosedError(err)) {
          // Client went away mid-run (e.g. browser timeout): earlier prompts
          // are already persisted — report the disconnect, not a model error.
          failJob(
            job.id,
            `client disconnected; partial results preserved (${lastPersisted} objects)`,
          );
          updateSession(sessionId, { status: "error" });
          closed(() => controller.close());
          return;
        }
        failJob(job.id, err instanceof Error ? err.message : "Tracking failed.");
        updateSession(sessionId, { status: "error" });
        closed(() =>
          send("error", {
            message: err instanceof Error ? err.message.slice(0, 300) : "Tracking failed.",
          }),
        );
        closed(() => controller.close());
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
