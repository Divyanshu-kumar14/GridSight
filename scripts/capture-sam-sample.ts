// Captures ONE real SAM streaming response for the parser regression test.
// Usage: npx tsx scripts/capture-sam-sample.ts <meta_files_file_id> "<prompt>"
// Output: src/lib/__tests__/fixtures/sam-live.txt (raw concatenated text deltas).
// Burns exactly one SAM video-segmentation call. NEVER run in CI.
// Key: MODEL_API_KEY env, or .env.local in the repo root (parsed inline, no deps).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getMetaClient } from "../src/lib/meta-client";
import { SAM_MODEL } from "../src/lib/models";

function loadLocalKey(): void {
  if (process.env.MODEL_API_KEY) return;
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^MODEL_API_KEY=(.+)$/.exec(line.trim());
    if (m) process.env.MODEL_API_KEY = m[1].trim().replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  const [fileId, prompt] = process.argv.slice(2);
  if (!fileId || !prompt) {
    console.error("Usage: npx tsx scripts/capture-sam-sample.ts <meta_files_file_id> \"<prompt>\"");
    process.exit(2);
  }
  loadLocalKey();
  const client = getMetaClient();
  const stream = await client.responses.create({
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
  } as never);

  let raw = "";
  let events = 0;
  for await (const event of stream as unknown as AsyncIterable<unknown>) {
    events++;
    if (typeof event === "string") {
      raw += event;
      continue;
    }
    if (event && typeof event === "object") {
      const e = event as Record<string, unknown>;
      const t = e.delta ?? e.text ?? e.output_text;
      if (typeof t === "string") raw += t;
    }
  }
  const outPath = join(process.cwd(), "src/lib/__tests__/fixtures/sam-live.txt");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, raw);
  console.log(`captured ${events} events, ${raw.length} chars → ${outPath}`);
}

main().catch((err) => {
  console.error("capture failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
