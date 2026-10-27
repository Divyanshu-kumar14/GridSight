// Record eval outputs as a benchmark prediction artifact — WITHOUT inventing
// asset identity. Reads recorded per-frame model outputs (fixtures/eval/cache
// style: {id, model?, after?: [...], error?}[]) and maps them onto benchmark
// frames. Because single-frame eval carries synthetic slug asset IDs and no
// boxes, emitted predictions use assetId null + association unresolved and are
// keyed by source frameId; the scorer reports them as unmappable until a
// pipeline that emits stable asset/episode references is recorded instead.
// Usage:
//   npx tsx scripts/eval-to-predictions.ts --cache-dir=fixtures/eval/cache \
//     --dataset-version=real-v1 --provenance=cached --json=/tmp/artifact.json
//   npx tsx scripts/eval-to-predictions.ts --cache-dir=... --provenance=actual \
//     --run-manifest=/path/run-manifest.json --json=/tmp/artifact.json
// --provenance=actual is ONLY for outputs of a genuinely executed inference run
// you just performed, and it REQUIRES --run-manifest: a bare label is refused.
// Never relabel cached/test outputs as actual. Linkage (digest, dataset,
// inputs, provider-request evidence) is verified at bench time, not here.
// No network, no quota, no secrets (inputs are local recorded files).

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
import {
  adaptEvalCacheToArtifact,
  validateRunManifest,
  type EvalCacheEntry,
} from "../src/lib/bench-metrics";
import {
  adaptStaticCacheToArtifact,
  buildStandaloneManifest,
  parseStandaloneRunLog,
  type StaticCacheEntry,
} from "./eval-static-lib";

function parseFlags(argv: string[]): {
  cacheDir: string;
  datasetVersion: string;
  provenance: "actual" | "cached";
  json?: string;
  model?: string;
  runManifest?: string;
  format?: string;
  runLog?: string;
  inputsManifest?: string;
  provider?: string;
} {
  let cacheDir = "fixtures/eval/cache";
  let datasetVersion = "real-v1";
  let provenance: "actual" | "cached" = "cached";
  let json: string | undefined;
  let model: string | undefined;
  let runManifest: string | undefined;
  let format: string | undefined;
  let runLog: string | undefined;
  let inputsManifest = "fixtures/benchmark/real-v1/provenance.json";
  let provider: string | undefined;
  for (const a of argv) {
    if (a.startsWith("--cache-dir=")) cacheDir = a.slice("--cache-dir=".length);
    else if (a.startsWith("--dataset-version=")) datasetVersion = a.slice("--dataset-version=".length);
    else if (a.startsWith("--provenance=")) {
      const v = a.slice("--provenance=".length);
      if (v !== "actual" && v !== "cached") throw new Error('Bad --provenance (expected "actual" or "cached").');
      provenance = v;
    } else if (a.startsWith("--json=")) json = a.slice("--json=".length);
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    else if (a.startsWith("--run-manifest=")) {
      runManifest = a.slice("--run-manifest=".length);
      if (!runManifest) throw new Error("Bad --run-manifest: empty path.");
    } else if (a.startsWith("--format=")) {
      format = a.slice("--format=".length);
      if (format !== "asset" && format !== "static") throw new Error('Bad --format (expected "asset" or "static").');
    } else if (a.startsWith("--run-log=")) {
      runLog = a.slice("--run-log=".length);
      if (!runLog) throw new Error("Bad --run-log: empty path.");
    } else if (a.startsWith("--inputs-manifest=")) {
      inputsManifest = a.slice("--inputs-manifest=".length);
      if (!inputsManifest) throw new Error("Bad --inputs-manifest: empty path.");
    } else if (a.startsWith("--provider=")) {
      provider = a.slice("--provider=".length);
      if (!provider) throw new Error("Bad --provider: empty value.");
    } else throw new Error(`Unknown flag: ${a}`);
  }
  if (!cacheDir) throw new Error("Bad --cache-dir: empty path.");
  if (provenance === "actual" && runManifest === undefined && runLog === undefined) {
    throw new Error(
      'Refusing --provenance=actual without --run-manifest or --run-log: a bare label is never evidence. Record the execution (see PREDICTIONS.md) and attach its manifest.',
    );
  }
  return { cacheDir, datasetVersion, provenance, json, model, runManifest, format, runLog, inputsManifest, provider };
}

async function main(): Promise<void> {
  const { cacheDir, datasetVersion, provenance, json, model, runManifest, format, runLog, inputsManifest, provider } = parseFlags(process.argv.slice(2));
  const dir = isAbsolute(cacheDir) ? cacheDir : join(process.cwd(), cacheDir);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no cache entries in ${cacheDir}`);
  const entries: EvalCacheEntry[] = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const scoring = format ?? "asset";
  if (scoring === "asset") {
    await emitAssetArtifact({ cacheDir, datasetVersion, provenance, json, model, runManifest, entries });
    return;
  }
  await emitStaticArtifact({ datasetVersion, provenance, json, model, runManifest, runLog, inputsManifest, provider, entries });
}

async function emitAssetArtifact(args: {
  cacheDir: string;
  datasetVersion: string;
  provenance: "actual" | "cached";
  json?: string;
  model?: string;
  runManifest?: string;
  entries: EvalCacheEntry[];
}): Promise<void> {
  const { datasetVersion, provenance, json, model, runManifest, entries } = args;
  const envelope = adaptEvalCacheToArtifact(entries, {
    datasetVersion,
    model: model ?? "unknown — recorded output did not state a pipeline model",
    recordedAt: new Date().toISOString(),
    provenanceDefault: provenance,
  });
  if (runManifest !== undefined) {
    const runRaw = JSON.parse(
      readFileSync(isAbsolute(runManifest) ? runManifest : join(process.cwd(), runManifest), "utf8"),
    );
    // Structural check now; dataset/digest linkage is enforced at bench time
    // against the final artifact (see PREDICTIONS.md).
    validateRunManifest(runRaw);
    if (
      (runRaw as { dataset?: { version?: unknown } }).dataset?.version !== undefined &&
      (runRaw as { dataset: { version: unknown } }).dataset.version !== datasetVersion
    ) {
      throw new Error(
        `run manifest dataset version ${(runRaw as { dataset: { version: unknown } }).dataset.version} does not match --dataset-version=${datasetVersion}`,
      );
    }
    (envelope as { run?: unknown }).run = runRaw;
    console.error("attached run manifest (linkage verified at bench time, not here)");
  }
  for (const n of envelope.notes) console.error(`note: ${n}`);
  console.log(
    `adapted ${entries.length} entr${entries.length === 1 ? "y" : "ies"} → ${envelope.predictions.length} prediction(s) (provenance: ${provenance}; asset identity: unmapped by design)`,
  );
  if (json) {
    const out = isAbsolute(json) ? json : join(process.cwd(), json);
    writeFileSync(out, JSON.stringify(envelope, null, 2));
    console.log(`wrote ${out}`);
  } else {
    console.log(JSON.stringify(envelope, null, 2));
  }
}

async function emitStaticArtifact(args: {
  datasetVersion: string;
  provenance: "actual" | "cached";
  json?: string;
  model?: string;
  runManifest?: string;
  runLog?: string;
  inputsManifest?: string;
  provider?: string;
  entries: EvalCacheEntry[];
}): Promise<void> {
  const { datasetVersion, provenance, json, model, runManifest, runLog, inputsManifest, provider, entries } = args;
  const adapted = adaptStaticCacheToArtifact(entries, { provenanceDefault: provenance });
  const predictions = adapted.predictions;
  // Inputs: verified media checksums for the evaluated frames, read from the
  // versioned provenance manifest (never trusted from flags). Missing manifest
  // file degrades to a bench-time warning, never to invented checksums.
  let inputs: Record<string, number | string> | undefined;
  const evaluatedFrames = Array.from(new Set(predictions.map((p) => p.frameId))).sort();
  if (inputsManifest !== undefined) {
    try {
      const manifest = JSON.parse(
        readFileSync(isAbsolute(inputsManifest) ? inputsManifest : join(process.cwd(), inputsManifest), "utf8"),
      ) as { sources?: Array<{ frames?: Array<{ frameId?: unknown; file?: unknown; sha256?: unknown }> }> };
      const table: Record<string, string> = {};
      for (const s of manifest.sources ?? []) {
        for (const f of s.frames ?? []) {
          if (typeof f.frameId === "string" && typeof f.sha256 === "string") table[f.frameId] = f.sha256;
        }
      }
      inputs = {};
      for (const id of evaluatedFrames) {
        if (typeof table[id] !== "string") throw new Error(`inputs manifest has no checksum for evaluated frame ${id}`);
        (inputs as Record<string, string>)[id] = table[id];
      }
    } catch (err) {
      if (inputsManifest !== "fixtures/benchmark/real-v1/provenance.json") throw err;
      console.error("provenance warning: inputs manifest unreadable; artifact records no input checksums");
      inputs = undefined;
    }
  }
  // Run manifest: built from the standalone run-log (actual execution records),
  // or attached verbatim from a prebuilt file (structural check only here;
  // linkage is enforced at bench time). Both at once is ambiguous: refuse.
  let run: unknown;
  if (runLog !== undefined && runManifest !== undefined) {
    throw new Error("refusing --run-log and --run-manifest together: build from execution records or attach a prebuilt manifest, not both");
  }
  if (runLog !== undefined) {
    const runLogRaw = JSON.parse(
      readFileSync(isAbsolute(runLog) ? runLog : join(process.cwd(), runLog), "utf8"),
    );
    const parsed = parseStandaloneRunLog(runLogRaw);
    const pairs = new Set(parsed.frames.map((f) => `${f.provider} / ${f.model}`));
    if (pairs.size === 0) throw new Error("run log records no provider/model identity");
    if (pairs.size > 1) {
      throw new Error(`run log mixes provider/model identities (${Array.from(pairs).join("; ")}); refusing to attribute`);
    }
    const loggedProvider = parsed.frames[0].provider;
    const loggedModel = parsed.frames[0].model;
    const finalProvider = provider ?? loggedProvider;
    const finalModel = model ?? loggedModel;
    if (provider !== undefined && provider !== loggedProvider) {
      throw new Error(`--provider=${provider} contradicts run-log provider ${loggedProvider}; refusing to mislabel`);
    }
    if (model !== undefined && model !== loggedModel) {
      throw new Error(`--model=${model} contradicts run-log model ${loggedModel}; refusing to mislabel`);
    }
    run = buildStandaloneManifest({
      runLog: parsed.frames,
      predictions,
      datasetId: "real-v1",
      datasetVersion,
      inputs: (inputs ?? {}) as Record<string, string>,
      provider: finalProvider,
      model: finalModel,
      runId: parsed.runId ?? randomUUID(),
      recordedAt: new Date().toISOString(),
      // Execution-anchored start when the run log recorded one; the builder
      // ignores wall-clock build time whenever frame evidence exists.
      ...(parsed.startedAt !== null ? { runStartedAt: parsed.startedAt } : {}),
    });
    console.error("built run manifest from standalone run-log (linkage verified at bench time, not here)");
  } else if (runManifest !== undefined) {
    const runRaw = JSON.parse(
      readFileSync(isAbsolute(runManifest) ? runManifest : join(process.cwd(), runManifest), "utf8"),
    );
    validateRunManifest(runRaw);
    if (
      (runRaw as { dataset?: { version?: unknown } }).dataset?.version !== undefined &&
      (runRaw as { dataset: { version: unknown } }).dataset.version !== datasetVersion
    ) {
      throw new Error(
        `run manifest dataset version ${(runRaw as { dataset: { version: unknown } }).dataset.version} does not match --dataset-version=${datasetVersion}`,
      );
    }
    run = runRaw;
    console.error("attached run manifest (linkage verified at bench time, not here)");
  }
  // Envelope model: explicit flag wins, else the run manifest's pipeline
  // identity when one was built/attached, else an honest unknown placeholder.
  let envelopeModel: string = model ?? "unknown — recorded output did not state a pipeline model";
  if (model === undefined && isRecord(run) && isRecord((run as Record<string, unknown>).pipeline)) {
    const runModel = ((run as { pipeline: { model?: unknown } }).pipeline.model);
    if (typeof runModel === "string" && runModel.length > 0) envelopeModel = runModel;
  }
  const envelope: Record<string, unknown> = {
    status: "completed",
    datasetVersion,
    model: envelopeModel,
    recordedAt: new Date().toISOString(),
    provenanceDefault: provenance,
    predictions,
    notes: adapted.notes,
  };
  if (inputs !== undefined) envelope.inputs = inputs;
  if (run !== undefined) envelope.run = run;
  for (const n of adapted.notes) console.error(`note: ${n}`);
  console.log(
    `adapted ${entries.length} entr${entries.length === 1 ? "y" : "ies"} → ${predictions.length} static prediction(s) (provenance: ${provenance}; frame-linked, asset identity: not asserted)`,
  );
  if (json) {
    const out = isAbsolute(json) ? json : join(process.cwd(), json);
    writeFileSync(out, JSON.stringify(envelope, null, 2));
    console.log(`wrote ${out}`);
  } else {
    console.log(JSON.stringify(envelope, null, 2));
  }
}

main().catch((err) => {
  console.error("eval-to-predictions failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
