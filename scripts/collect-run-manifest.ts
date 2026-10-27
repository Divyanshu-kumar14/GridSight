// Build a run manifest from ACTUAL execution records — never from assertions.
// Reads the pipeline's persisted records (SQLite jobs, stored report) plus
// operator-saved raw provider responses, and emits a run-manifest-v1 document.
// Every inference claim requires a saved raw response file (digest computed);
// stages without evidence must be explicitly declared cache/fixture/skipped.
// Usage:
//   npx tsx scripts/collect-run-manifest.ts --session=<id> \
//     --responses-dir=/path/raw-responses --predictions=/path/predictions.json \
//     --dataset-version=real-v1 --stage-modes=transcribe=fixture,tag-assets=fixture \
//     --out=/tmp/run-manifest.json
// Raw responses: save each stage's model response text to
//   <responses-dir>/<stage-key>.json  (track, report-generation, ...).
// No network, no quota. Never pass secrets; the manifest carries digests only
// (validated before writing).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { getJobs } from "../src/lib/jobs";
import { getReport, getSession } from "../src/lib/store";
import {
  assertNoSecrets,
  canonicalJson,
  validateRunManifest,
  type RunManifest,
  type RunStage,
} from "../src/lib/bench-metrics";

const REAL_V1_PROVENANCE = "fixtures/benchmark/real-v1/provenance.json";

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) throw new Error(`Bad flag (expected --key=value): ${a}`);
    out[m[1]] = m[2];
  }
  for (const k of ["session", "responses-dir", "predictions", "dataset-version", "out"]) {
    if (!out[k]) throw new Error(`Missing required --${k}=...`);
  }
  return out;
}

const resolve = (p: string) => (isAbsolute(p) ? p : join(process.cwd(), p));

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  const session = getSession(f["session"]);
  if (!session) throw new Error(`unknown session ${f["session"]} (no execution records)`);
  const report = getReport(f["session"]);
  const jobs = getJobs(f["session"]);

  const running = jobs.filter((j) => j.status === "running");
  if (running.length > 0) {
    throw new Error(`refusing manifest: jobs still running (${running.map((j) => j.kind).join(", ")}); re-run when complete`);
  }

  const predictionsRaw = JSON.parse(readFileSync(resolve(f["predictions"]), "utf8"));
  const predictions = Array.isArray(predictionsRaw) ? predictionsRaw : predictionsRaw.predictions;
  if (!Array.isArray(predictions)) throw new Error("--predictions must be a JSON array or a {predictions:[...]} envelope");
  const predictionsDigest = createHash("sha256").update(canonicalJson(predictions), "utf8").digest("hex");

  // Dataset inputs: recomputed from the verified provenance manifest (never trusted from flags).
  const provenance = JSON.parse(readFileSync(resolve(REAL_V1_PROVENANCE), "utf8"));
  const inputs: Record<string, string> = {};
  const frames: Array<{ frameId?: unknown; file?: unknown }> =
    (provenance.sources ?? []).flatMap((s: { frames?: unknown }) => (Array.isArray(s.frames) ? s.frames : []));
  for (const fr of frames) {
    if (typeof fr.frameId === "string" && typeof fr.file === "string") {
      inputs[fr.frameId] = createHash("sha256").update(readFileSync(resolve(fr.file as string))).digest("hex");
    }
  }

  // Response evidence: only files actually saved on disk count.
  const responseFiles = new Map<string, string>();
  for (const name of readdirSync(resolve(f["responses-dir"]))) {
    const m = /^(.+)\.json$/.exec(name);
    if (m) responseFiles.set(m[1], readFileSync(join(resolve(f["responses-dir"]), name), "utf8"));
  }

  const declaredModes = new Map<string, string>();
  if (f["stage-modes"]) {
    for (const pair of f["stage-modes"].split(",")) {
      const m = /^([^=]+)=(inference|cache|fixture|skipped)$/.exec(pair.trim());
      if (!m) throw new Error(`Bad --stage-modes entry (expected key=inference|cache|fixture|skipped): ${pair}`);
      declaredModes.set(m[1], m[2]);
    }
  }

  const stages: RunStage[] = [];
  const jobToStage = (kind: string) => (kind === "report" ? "report-generation" : kind);
  for (const job of [...jobs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
    const key = jobToStage(job.kind);
    const raw = responseFiles.get(key);
    let mode: RunStage["mode"];
    if (raw !== undefined) {
      mode = "inference";
    } else {
      const declared = declaredModes.get(key);
      if (declared === "inference")
        throw new Error(`stage ${key}: mode inference declared but no saved response ${key}.json (refusing silent upgrade)`);
      if (declared !== "cache" && declared !== "fixture" && declared !== "skipped")
        throw new Error(`stage ${key}: no response evidence and no declared mode (supply --stage-modes ${key}=cache|fixture|skipped)`);
      mode = declared;
    }
    stages.push({
      key,
      mode,
      status: job.status === "complete" ? "completed" : job.status === "error" ? "failed" : "cancelled",
      providerRequestMade: mode === "inference",
      ...(mode === "inference" && raw !== undefined
        ? { responseDigest: createHash("sha256").update(raw, "utf8").digest("hex") }
        : {}),
      ...(job.error ? { error: job.error } : {}),
      note: `job ${job.id} ${job.status} ${job.createdAt}→${job.updatedAt}`,
    });
  }
  // Transcribe/tag have no job records in this pipeline: record the gap explicitly.
  const knownKeys = new Set(stages.map((s) => s.key));
  declaredModes.forEach((mode, key) => {
    if (knownKeys.has(key)) return;
    if (mode === "inference") {
      throw new Error(`stage ${key}: mode inference declared but no saved response ${key}.json and no job record`);
    }
    stages.push({
      key,
      mode: mode as RunStage["mode"],
      status: mode === "skipped" ? "skipped" : "completed",
      providerRequestMade: false,
      note: "no job record in this pipeline; mode declared by operator (see PREDICTIONS.md trust boundary)",
    });
  });

  const provider = f["provider"] ?? report?.modelRun?.provider;
  const model = f["model"] ?? report?.modelRun?.model;
  if (typeof provider !== "string" || typeof model !== "string")
    throw new Error("provider/model unknown: supply --provider= --model= (no stored report to inherit from)");
  if (report?.modelRun && (report.modelRun.provider !== provider || report.modelRun.model !== model)) {
    throw new Error(
      `provider/model contradicts stored report (${report.modelRun.provider}/${report.modelRun.model}); refusing to mislabel the run`,
    );
  }

  const failed = stages.some((s) => s.status === "failed" || s.status === "cancelled");
  const createdAt = jobs.length > 0 ? [...jobs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0].createdAt : new Date().toISOString();
  const completedAt = failed
    ? null
    : jobs.length > 0
      ? [...jobs].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1)).at(-1)!.updatedAt
      : new Date().toISOString();

  const manifest: RunManifest = {
    manifestVersion: "run-manifest-v1",
    runId: f["run-id"] ?? randomUUID(),
    createdAt,
    completedAt,
    status: failed ? "failed" : "completed",
    dataset: { id: "real-v1", version: f["dataset-version"], inputs },
    pipeline: { provider, model },
    stages,
    predictionsDigest,
    notes: [
      "Transcribe/tag stages have no job records in this pipeline; declared modes are operator-attested (see PREDICTIONS.md).",
      "Response digests prove WHAT was saved, not that a provider sent it; genuine execution additionally requires operator custody of the raw responses.",
    ],
  };
  assertNoSecrets(manifest);
  validateRunManifest(manifest, { predictionsDigest, datasetVersion: f["dataset-version"], inputsActual: inputs });
  writeFileSync(resolve(f["out"]), JSON.stringify(manifest, null, 2));
  console.log(`wrote run manifest ${manifest.runId} (${manifest.status}, ${stages.length} stages) → ${resolve(f["out"])}`);
}

main().catch((err) => {
  console.error("collect-run-manifest failed:", err instanceof Error ? err.message : err);
  process.exit(3);
});
