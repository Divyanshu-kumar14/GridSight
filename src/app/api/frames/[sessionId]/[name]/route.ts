import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { isSafeThumbName } from "@/lib/frames";
import { scratchDir } from "@/lib/store";

// GET /api/frames/[sessionId]/[name] → image/jpeg. Traversal-safe by construction:
// name must match /^[\w-]+\.jpg$/ and the session dir is fixed.
export async function GET(
  _req: Request,
  { params }: { params: { sessionId: string; name: string } },
): Promise<NextResponse> {
  const { sessionId, name } = params;
  if (!/^[\w-]{1,64}$/.test(sessionId) || !isSafeThumbName(name)) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Invalid frame path." } },
      { status: 400 },
    );
  }
  const bytes = await readFile(`${scratchDir()}/frames/${name}`).catch(() => null);
  if (!bytes) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Frame not found." } },
      { status: 404 },
    );
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" },
  });
}
