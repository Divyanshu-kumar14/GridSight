import { NextResponse } from "next/server";
import { z } from "zod";
import { cancelJob, getJob, getJobs } from "@/lib/jobs";

// GET /api/jobs?sessionId= → job history (newest first) · 400 missing id.
// POST /api/jobs { action: "cancel", jobId } → cancelled · 404 unknown job.
export async function GET(req: Request): Promise<NextResponse> {
  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
  if (!sessionId) {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Query param sessionId is required." } },
      { status: 400 },
    );
  }
  return NextResponse.json({ jobs: getJobs(sessionId) });
}

const cancelSchema = z.object({ action: z.literal("cancel"), jobId: z.string().min(1) });

export async function POST(req: Request): Promise<NextResponse> {
  const body: unknown = await req.json().catch(() => null);
  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_body", message: 'Expected { action: "cancel", jobId }.' } },
      { status: 400 },
    );
  }
  try {
    cancelJob(parsed.data.jobId);
    return NextResponse.json({ job: getJob(parsed.data.jobId) });
  } catch {
    return NextResponse.json(
      { error: { code: "not_found", message: `Unknown job ${parsed.data.jobId}.` } },
      { status: 404 },
    );
  }
}
