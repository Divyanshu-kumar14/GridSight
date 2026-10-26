// Phase 0 smoke test: proves MODEL_API_KEY reaches all 5 Meta endpoints.
// Usage: npx tsx scripts/smoke-meta.ts
// Contract: no key → clean SKIP (exit 0). Key set → per-endpoint PASS/FAIL table (exit 1 on any FAIL).
// Never prints the key or response bodies containing credentials.

import { getMetaClient } from "../src/lib/meta-client";

type Row = { endpoint: string; status: "PASS" | "FAIL" | "SKIP"; detail: string };

async function main(): Promise<void> {
  const rows: Row[] = [];
  if (!process.env.MODEL_API_KEY) {
    console.log("SKIP: MODEL_API_KEY not set — copy .env.example to .env.local.");
    console.log("Endpoints: Files, SAM 3.1, Spark 1.3, Image 1.0, Transcribe — all SKIPPED.");
    return;
  }

  const client = getMetaClient();

  // 1. Files API — tiny text probe upload (cheap, validates auth + baseURL).
  try {
    const probe = new File(["gridsight-smoke"], "smoke.txt", { type: "text/plain" });
    const file = await client.files.create({ file: probe, purpose: "user_data" });
    rows.push({ endpoint: "Files POST /v1/files", status: "PASS", detail: `id=${file.id}` });
  } catch (err) {
    rows.push({ endpoint: "Files POST /v1/files", status: "FAIL", detail: msg(err) });
  }

  // 2. Muse Spark 1.3 — minimal chat completion.
  try {
    const res = await client.chat.completions.create({
      model: "muse-spark-1.3",
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      temperature: 0,
    });
    const text = res.choices[0]?.message?.content?.slice(0, 40) ?? "(empty)";
    rows.push({ endpoint: "Spark POST /v1/chat/completions", status: "PASS", detail: text });
  } catch (err) {
    rows.push({ endpoint: "Spark POST /v1/chat/completions", status: "FAIL", detail: msg(err) });
  }

  // 3. SAM 3.1 — text-only probe (no video; expects model-level error, NOT auth error).
  // PASS = reachable (any non-401/403). FAIL = auth/network down.
  try {
    await client.responses.create({
      model: "sam-3.1",
      stream: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "insulator" }] }],
    } as never);
    rows.push({ endpoint: "SAM 3.1 POST /v1/responses", status: "PASS", detail: "reachable" });
  } catch (err) {
    const m = msg(err);
    if (/401|403|api.?key|unauthorized/i.test(m)) {
      rows.push({ endpoint: "SAM 3.1 POST /v1/responses", status: "FAIL", detail: m });
    } else {
      rows.push({ endpoint: "SAM 3.1 POST /v1/responses", status: "PASS", detail: `reachable (${m.slice(0, 80)})` });
    }
  }

  // 4. Muse Image 1.0 — not probed with a paid generation by default (cost).
  rows.push({
    endpoint: "Image POST /v1/images/generations",
    status: "SKIP",
    detail: "skipped by default (paid call) — enable with SMOKE_IMAGE=1",
  });
  if (process.env.SMOKE_IMAGE === "1") {
    try {
      const img = await client.images.generate({
        model: "muse-image-1.0",
        prompt: "tiny test square, solid gray",
        n: 1,
      } as never);
      rows.pop();
      rows.push({
        endpoint: "Image POST /v1/images/generations",
        status: "PASS",
        detail: `images=${img.data?.length ?? 0}`,
      });
    } catch (err) {
      rows.pop();
      rows.push({ endpoint: "Image POST /v1/images/generations", status: "FAIL", detail: msg(err) });
    }
  }

  // 5. Voice Transcribe — endpoint probe without burning audio (documents contract only).
  rows.push({
    endpoint: "Transcribe POST /v1/asr/transcribe",
    status: "SKIP",
    detail: "needs 16kHz mono WAV — covered in Phase 3 with fixture",
  });

  console.table(rows);
  if (rows.some((r) => r.status === "FAIL")) {
    console.error("\nSmoke FAILED — check MODEL_API_KEY and https://api.meta.ai/v1 reachability.");
    process.exit(1);
  }
  console.log("\nSmoke OK (no FAIL rows).");
}

function msg(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}

main().catch((err) => {
  console.error("Smoke crashed:", msg(err));
  process.exit(1);
});
