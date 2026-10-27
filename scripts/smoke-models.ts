// Per-model smoke probe: one minimal call each, prints PASS/FAIL + latency.
// Usage: npx tsx scripts/smoke-models.ts
// NEVER wire into CI — every run burns quota. MODEL_API_KEY via env or .env.local.
// Image generation is gated behind SMOKE_IMAGE=1 (paid call); ASR has no audio
// here so it only checks the endpoint rejects cleanly (reachable, not a transcript).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getMetaClient } from "../src/lib/meta-client";
import {
  ASR_MODEL,
  ASR_TRANSCRIBE_PATH,
  IMAGE_MODEL,
  META_BASE_URL,
  SAM_MODEL,
  SPARK_MODEL,
} from "../src/lib/models";

type Row = { model: string; status: "PASS" | "FAIL" | "SKIP"; ms: number; detail: string };

function loadLocalKey(): void {
  if (process.env.MODEL_API_KEY) return;
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^MODEL_API_KEY=(.+)$/.exec(line.trim());
    if (m) process.env.MODEL_API_KEY = m[1].trim().replace(/^["']|["']$/g, "");
  }
}

function fail(detail: unknown): string {
  return (detail instanceof Error ? detail.message : String(detail)).slice(0, 120);
}

async function main(): Promise<void> {
  loadLocalKey();
  if (!process.env.MODEL_API_KEY) {
    console.log("SKIP: MODEL_API_KEY not set — copy .env.example to .env.local.");
    return;
  }
  const client = getMetaClient();
  const rows: Row[] = [];

  // Spark — minimal chat completion.
  try {
    const t = Date.now();
    const res = await client.chat.completions.create({
      model: SPARK_MODEL,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      temperature: 0,
      max_tokens: 8,
    });
    rows.push({
      model: SPARK_MODEL, status: "PASS", ms: Date.now() - t,
      detail: (res.choices[0]?.message?.content ?? "(empty)").slice(0, 40),
    });
  } catch (e) {
    rows.push({ model: SPARK_MODEL, status: "FAIL", ms: 0, detail: fail(e) });
  }

  // SAM — text-only probe (no video): PASS = reachable (any non-401/403).
  try {
    const t = Date.now();
    await client.responses.create({
      model: SAM_MODEL,
      stream: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "insulator" }] }],
    } as never);
    rows.push({ model: SAM_MODEL, status: "PASS", ms: Date.now() - t, detail: "reachable" });
  } catch (e) {
    const m = fail(e);
    rows.push(/401|403|api.?key|unauthorized/i.test(m)
      ? { model: SAM_MODEL, status: "FAIL", ms: 0, detail: m }
      : { model: SAM_MODEL, status: "PASS", ms: 0, detail: `reachable (${m.slice(0, 80)})` });
  }

  // Image — gated (paid call).
  if (process.env.SMOKE_IMAGE === "1") {
    try {
      const t = Date.now();
      const img = await client.images.generate({
        model: IMAGE_MODEL,
        prompt: "tiny test square, solid gray",
        n: 1,
      } as never);
      rows.push({
        model: IMAGE_MODEL, status: "PASS", ms: Date.now() - t,
        detail: `images=${img.data?.length ?? 0}`,
      });
    } catch (e) {
      rows.push({ model: IMAGE_MODEL, status: "FAIL", ms: 0, detail: fail(e) });
    }
  } else {
    rows.push({ model: IMAGE_MODEL, status: "SKIP", ms: 0, detail: "set SMOKE_IMAGE=1 to probe (paid)" });
  }

  // ASR — no audio here: expect 4xx (reachable), not 401/403/DNS.
  try {
    const t = Date.now();
    const up = await fetch(`${META_BASE_URL}${ASR_TRANSCRIBE_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}` },
      body: new URLSearchParams({ model: ASR_MODEL }),
    });
    const ms = Date.now() - t;
    rows.push(up.status === 401 || up.status === 403
      ? { model: ASR_MODEL, status: "FAIL", ms, detail: `auth http=${up.status}` }
      : { model: ASR_MODEL, status: "PASS", ms, detail: `reachable http=${up.status}` });
  } catch (e) {
    rows.push({ model: ASR_MODEL, status: "FAIL", ms: 0, detail: fail(e) });
  }

  for (const r of rows) console.log(`${r.status} ${r.model} ${r.ms}ms ${r.detail}`);
  if (rows.some((r) => r.status === "FAIL")) process.exit(1);
}

main().catch((e) => {
  console.error("smoke-models crashed:", fail(e));
  process.exit(1);
});
