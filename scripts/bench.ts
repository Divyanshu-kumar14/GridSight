// GridSight benchmarks — quota-free, no inference, no network.
// Default `--dataset=v1`: synthetic pipeline-logic cases (fixtures/benchmark/v1).
// `--dataset=real-v1`: real derivative static-image asset-level GT
// (fixtures/benchmark/real-v1, 12 instances, 3 scenes). No predictions ship with
// real-v1, so visual accuracy reports UNAVAILABLE until matching actual
// predictions are recorded via `--predictions=<artifact.json>`.
// `--dataset-path=` loads a compatible file directly.
// `--scoring=asset|static` selects the prediction matcher (default: asset).
// "asset" matches predictions by stable case/asset/episode IDs (existing
// behavior, unchanged). "static" matches frame-linked predictions (with
// optional boxes) to the GT case(s) on the same input image; asset association
// is unavailable by design on that path. Use "static" for single-image eval
// outputs adapted with eval-to-predictions --format=static.
// Live Meta inference is NEVER run here; see scripts/eval.ts --live.
// Provenance "actual" additionally requires a run manifest whose linkage and
// provider-request evidence verify (see PREDICTIONS.md); a bare label fails.
// Exit codes: 0 scored-pass · 1 scored-fail · 2 not-evaluated (no predictions) ·
// 3 input error (bad ground truth, malformed/stale/missing-explicit artifact,
// unverifiable actual provenance).
// An incomplete evaluation exits 2: never 1 (failure), never 0 (pass).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, dirname } from "node:path";
import { z } from "zod";
import {
  assertActualProvenance,
  exitCodeForStatus,
  predictionsDigestOf,
  scoreAssetBenchmark,
  scoreBenchmark,
  scoreStaticBenchmark,
  toAssetBenchJson,
  toBenchJson,
  validatePredictionArtifact,
  validateProvenanceManifest,
  validateRealDataset,
  validateRunManifest,
  validateStaticArtifact,
  verifyFrameCoverage,
  verifyInputChecksums,
  type AssetBenchReport,
  type BenchStatus,
  type BenchCaseInput,
  type RealGroundTruth,
  type RealPrediction,
  type StaticPrediction,
} from "../src/lib/bench-metrics";
import { assertKnownFrames } from "./eval-static-lib";

const V1_PATH = "fixtures/benchmark/v1/cases.json";
const REAL_V1_PATH = "fixtures/benchmark/real-v1/cases.json";

const boxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const gtSchema = z.object({
  caseId: z.string().min(1),
  scene: z.string().min(1),
  description: z.string(),
  clean: z.boolean(),
  category: z.string(),
  defect: z.string(),
  assetId: z.string().nullable(),
  evidenceFrame: z.number().int().min(0).nullable(),
  bbox: boxSchema.nullable(),
  voiceAssetId: z.string().nullable().optional(),
});
const predSchema = z.object({
  caseId: z.string().min(1),
  category: z.string(),
  defect: z.string(),
  assetId: z.string().nullable(),
  evidenceFrame: z.number().int().min(0).nullable(),
  bbox: boxSchema.nullable(),
  evidenceSource: z.enum(["visual", "voice"]),
  assetAssociation: z.enum(["confirmed", "unresolved"]).nullable(),
  verification: z.enum(["keep", "downgrade", "drop", "skipped"]).nullable(),
  error: z.boolean().optional(),
  skipped: z.boolean().optional(),
});
const fileSchema = z.object({
  datasetVersion: z.string(),
  cases: z.array(z.object({ groundTruth: gtSchema, predictions: z.array(predSchema) })),
});

const realCaseSchema = z.object({
  caseId: z.string().min(1),
  scene: z.string().min(1),
  sourceMediaId: z.string().min(1),
  frameId: z.string().min(1),
  timestamp: z.number(),
  assetId: z.string().min(1),
  assetCategory: z.string().min(1),
  clean: z.boolean(),
  defectClass: z.string(),
  visualDescription: z.string(),
  bbox: boxSchema.nullable(),
  bboxReliable: z.boolean(),
  observability: z.enum(["observable", "not-observable", "uncertain"]),
  episodeId: z.string().nullable(),
  excludedFrom: z.array(z.string()),
  annotationNotes: z.string(),
});
const realFileSchema = z.object({
  datasetVersion: z.string(),
  datasetType: z.string(),
  cases: z.array(realCaseSchema),
});

function parseFlags(argv: string[]): { json?: string; live: boolean; dataset: string; datasetPath?: string; predictions?: string; scoring: string } {
  let json: string | undefined;
  let live = false;
  let dataset = "v1";
  let datasetPath: string | undefined;
  let predictions: string | undefined;
  let scoring = "asset";
  for (const a of argv) {
    if (a === "--live") live = true;
    else if (a.startsWith("--json=")) {
      json = a.slice("--json=".length);
      if (!json) throw new Error("Bad --json value: empty path.");
    } else if (a.startsWith("--dataset=")) {
      dataset = a.slice("--dataset=".length);
      if (!dataset) throw new Error("Bad --dataset value: empty.");
    } else if (a.startsWith("--dataset-path=")) {
      datasetPath = a.slice("--dataset-path=".length);
      if (!datasetPath) throw new Error("Bad --dataset-path value: empty.");
    } else if (a.startsWith("--predictions=")) {
      predictions = a.slice("--predictions=".length);
      if (!predictions) throw new Error("Bad --predictions value: empty path.");
    } else if (a.startsWith("--scoring=")) {
      scoring = a.slice("--scoring=".length);
      if (scoring !== "asset" && scoring !== "static") throw new Error('Bad --scoring value (expected "asset" or "static").');
    } else throw new Error(`Unknown flag: ${a} (expected --live, --json=path, --dataset=v1|real-v1, --dataset-path=path, --predictions=path, --scoring=asset|static).`);
  }
  return { json, live, dataset, datasetPath, predictions, scoring };
}

const f2 = (x: number | null): string => (x === null ? "n/a" : x.toFixed(2));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Exit codes: 0 scored-pass · 1 scored-fail · 2 not-evaluated (no predictions) ·
// 3 input error (bad ground truth, malformed/stale/missing-explicit prediction
// artifact). An incomplete evaluation exits 2, never 1 (failure) and never 0.
function failInput(message: string): never {
  const err = new Error(message) as Error & { benchExitCode: number };
  err.benchExitCode = 3;
  throw err;
}

async function main(): Promise<void> {
  const { json, live, dataset, datasetPath, predictions, scoring } = parseFlags(process.argv.slice(2));
  const selected = datasetPath ?? (dataset === "real-v1" ? REAL_V1_PATH : V1_PATH);

  if (datasetPath ?? dataset === "real-v1") {
    const casesPath = isAbsolute(selected) ? selected : join(process.cwd(), selected);
    const raw = JSON.parse(readFileSync(casesPath, "utf8"));
    const parsed = realFileSchema.parse(raw);
    const gt: RealGroundTruth[] = parsed.cases.map((c) => ({ ...c }));
    const stats = validateRealDataset(gt);
    // Provenance manifest: validated on every real run. A sibling
    // provenance.json is required for the distributable dataset; custom
    // --dataset-path files without one get a warning, never a silent pass.
    // The manifest also supplies the frameId → file map for checksum checks.
    const frameFiles = new Map<string, string>();
    const manifestPath = join(dirname(casesPath), "provenance.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const mstats = validateProvenanceManifest(manifest, gt);
        for (const s of (manifest as { sources?: Array<{ frames?: Array<{ frameId?: unknown; file?: unknown }> }> }).sources ?? []) {
          for (const f of s.frames ?? []) {
            if (typeof f.frameId === "string" && typeof f.file === "string") {
              frameFiles.set(f.frameId, isAbsolute(f.file) ? f.file : join(process.cwd(), f.file));
            }
          }
        }
        for (const w of mstats.warnings) console.error(`provenance warning: ${w}`);
      } catch (err) {
        failInput(`provenance manifest invalid: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.error("provenance warning: no sibling provenance.json found; manifest validation skipped");
    }
    // Prediction artifact handling: no --predictions flag means NO artifact
    // exists (State A) — never synthesize an empty array. An explicit flag
    // pointing at a missing/malformed/stale file is an input error (exit 3),
    // not silent unavailability. Provenance "actual" additionally requires a
    // run manifest whose linkage and provider-request evidence verify; a bare
    // label is never sufficient.
    //
    // Scoring modes: "asset" (default) matches predictions to ground truth by
    // stable case/asset/episode IDs; "static" matches frame-linked predictions
    // (with optional boxes) to the GT case(s) on the same input frame.
    // --scoring=static is required for single-image eval outputs; the default
    // stays "asset" so existing runs and fixtures behave exactly as before.
    const computeMediaActual = (): Record<string, string> => {
      const mediaActual: Record<string, string> = {};
      frameFiles.forEach((file, frameId) => {
        try {
          mediaActual[frameId] = createHash("sha256").update(readFileSync(file)).digest("hex");
        } catch {
          // unreadable frame file: leave absent so it reports as missing
        }
      });
      return mediaActual;
    };
    const loadArtifactRaw = (): unknown | undefined => {
      if (predictions === undefined) return undefined;
      let predRaw: unknown;
      try {
        predRaw = JSON.parse(readFileSync(isAbsolute(predictions) ? predictions : join(process.cwd(), predictions), "utf8"));
      } catch {
        failInput(`prediction artifact unreadable: ${predictions} (explicit --predictions path must exist)`);
      }
      if (
        predRaw !== null &&
        typeof predRaw === "object" &&
        !Array.isArray(predRaw) &&
        "datasetVersion" in (predRaw as Record<string, unknown>) &&
        (predRaw as { datasetVersion?: unknown }).datasetVersion !== parsed.datasetVersion
      ) {
        failInput(
          `stale prediction artifact: datasetVersion ${(predRaw as { datasetVersion?: unknown }).datasetVersion ?? "unknown"} does not match benchmark ${parsed.datasetVersion}`,
        );
      }
      return predRaw;
    };
    const checkArtifactInputs = (predRaw: unknown, mediaActual: Record<string, string>): void => {
      const inputs = isRecord(predRaw) ? (predRaw as { inputs?: unknown }).inputs : undefined;
      if (inputs !== undefined) {
        if (!isRecord(inputs)) failInput("malformed prediction artifact: inputs must be a {frameId: sha256} map");
        const check = verifyInputChecksums(inputs as Record<string, string>, mediaActual);
        if (!check.ok) {
          failInput(
            `prediction artifact input mismatch: ${[...check.mismatches.map((m) => `altered:${m}`), ...check.missing.map((m) => `missing:${m}`)].join(", ")} (artifact does not describe this media)`,
          );
        }
      } else {
        console.error("provenance warning: artifact records no input checksums; media mapping unverified");
      }
    };

    const scoreAssetPath = (): AssetBenchReport => {
      let artifact: RealPrediction[] | null = null;
      const predRaw = loadArtifactRaw();
      if (predRaw !== undefined) {
        const validated = validatePredictionArtifact(predRaw);
        if (validated.state === "invalid") failInput(`malformed prediction artifact: ${validated.reason}`);
        const mediaActual = computeMediaActual();
        checkArtifactInputs(predRaw, mediaActual);
        // Actual-inference gate: entries labeled "actual" are accepted only with
        // a run manifest whose digest/dataset/input linkage and provider-request
        // evidence all verify. Cached and hand-test entries need no manifest.
        try {
          const gate = assertActualProvenance(validated.predictions, validated.run, {
            predictionsDigest: predictionsDigestOf(validated.predictions),
            datasetVersion: parsed.datasetVersion,
            inputsActual: mediaActual,
          });
          if (gate.required) console.error(`provenance: ${gate.reason}`);
        } catch (err) {
          failInput(`unverifiable actual provenance: ${err instanceof Error ? err.message : String(err)}`);
        }
        artifact = validated.predictions;
      }
      // No predictions ship with real-v1 and cached fixtures/eval/cache artifacts
      // are NOT mapped as predictions (synthetic slug asset IDs, no boxes, no
      // stable asset mapping — see README).
      return scoreAssetBenchmark(gt, artifact, { datasetVersion: parsed.datasetVersion, datasetType: "static-image" });
    }

    const scoreStaticPath = (): AssetBenchReport => {
      let artifact: StaticPrediction[] | null = null;
      const predRaw = loadArtifactRaw();
      if (predRaw !== undefined) {
        const validated = validateStaticArtifact(predRaw);
        if (validated.state === "invalid") failInput(`malformed prediction artifact: ${validated.reason}`);
        // Unknown frames fail fast: a static prediction must name a benchmark
        // input frame — anything else is a wiring bug, not a scored outcome.
        // (The scorer additionally buckets unknown frames defensively.)
        try {
          assertKnownFrames(
            validated.predictions.filter((p) => !p.skipped && !p.error).map((p) => p.frameId),
            gt.map((c) => c.frameId),
            "expected only real-v1 input frameIds; use --frames to select valid inputs",
          );
        } catch (err) {
          failInput(err instanceof Error ? err.message : String(err));
        }
        const mediaActual = computeMediaActual();
        checkArtifactInputs(predRaw, mediaActual);
        // Actual-inference gate for frame-linked predictions: every scored
        // frame with an "actual" prediction must have a COMPLETED live
        // inference stage with provider-request evidence in the run manifest.
        // Cached, fixture, or failed frames can never back actual provenance.
        const activeActual = validated.predictions.filter((p) => !p.skipped && !p.error && p.provenance === "actual");
        if (activeActual.length > 0) {
          if (validated.run === null || validated.run === undefined) {
            failInput(
              `actual inference claimed by ${activeActual.length} prediction(s) without a run manifest; attach the execution record or relabel provenance`,
            );
          }
          try {
            validateRunManifest(validated.run, {
              predictionsDigest: predictionsDigestOf(validated.predictions),
              datasetVersion: parsed.datasetVersion,
              inputsActual: mediaActual,
            });
            const scoredFrames = Array.from(new Set(activeActual.map((p) => p.frameId)));
            verifyFrameCoverage(validated.run, scoredFrames);
            console.error(
              `provenance: ${activeActual.length} actual prediction(s) on ${scoredFrames.length} frame(s) traced to a completed live run with per-frame provider-request evidence`,
            );
          } catch (err) {
            failInput(`unverifiable actual provenance: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        artifact = validated.predictions;
      }
      return scoreStaticBenchmark(gt, artifact, { datasetVersion: parsed.datasetVersion });
    };
    let report: AssetBenchReport;
    if (scoring === "static") {
      report = scoreStaticPath();
    } else {
      report = scoreAssetPath();
    }
    const status: BenchStatus = report.status;
    const statusLine =
      status === "not-evaluated"
        ? "STATUS: NOT EVALUATED — ground truth available, no prediction artifact; model accuracy NOT measured"
        : status === "scored-pass"
          ? "STATUS: PASS — scored benchmark met acceptance criteria"
          : "STATUS: FAIL — scored benchmark did not meet acceptance criteria";
    console.log(statusLine);
    if (scoring === "static") {
      console.log(
        "scoring: static single-image (frame-linked predictions, IoU localization where GT boxes are reliable; no asset association, no tracking)",
      );
    }
    console.log(
      `GridSight benchmark ${report.datasetVersion} (REAL DERIVATIVE static-image, asset-level, no inference) — ${report.counts.cases} cases, ${report.counts.scenes} scenes, ${report.counts.assets} assets, ${report.counts.episodes} defect episode(s), ${report.counts.cleanCases} clean, ${report.counts.uncertainCases} uncertain`,
    );
    if (report.detection.unavailable) {
      console.log(
        `detection (episode-level): UNAVAILABLE — ${report.detection.reason} [${report.detection.unit}]`,
      );
    } else {
      console.log(
        `detection (episode-level): P=${f2(report.detection.precision)} R=${f2(report.detection.recall)} F1=${f2(report.detection.f1)} TP=${report.detection.truePositives} FP=${report.detection.falsePositives} FN=${report.detection.falseNegatives} FPclean=${report.detection.falsePositivesOnClean} [${report.detection.unit}]`,
      );
    }
    for (const e of report.perEpisode) {
      console.log(`- episode ${e.episodeId} (${e.scene}): ${e.status} [${e.cases.join(", ")}]`);
    }
    for (const c of report.cases) {
      const tag = c.skipped ? (c.predicted.startsWith("not evaluated") ? "NOT EVALUATED" : "SKIP") : c.passed ? "PASS" : "FAIL";
      console.log(`- [${tag}] ${c.caseId} (${c.scene}): expected ${c.expected} | got ${c.predicted}`);
      for (const m of c.mismatches) console.log(`    ! ${m}`);
    }
    if (!report.predictionsAvailable) {
      console.log(
        `Predictions: NONE available — visual accuracy NOT measured (no matching actual predictions). ` +
          `Covered: ${stats.assets} assets across ${stats.scenes} scenes; excluded from detection: ${report.counts.excludedFromDetection}.`,
      );
    } else if (report.unmappablePredictions.count > 0) {
      console.log(
        `Unmappable predictions: ${report.unmappablePredictions.count} (${report.unmappablePredictions.caseIds.join(", ")}) — excluded from all metrics, listed here.`,
      );
    }
    console.log(`Tracking/temporal/note-alignment: NOT APPLICABLE to static images (reported null, never scored).`);
    console.log(`Limitations: ${report.limitations[0]}`);
    if (live) console.log("Note: --live is not applicable here; no Meta calls were made. Use scripts/eval.ts --live for the visual set.");
    if (json) {
      const outPath = isAbsolute(json) ? json : join(process.cwd(), json);
      writeFileSync(outPath, toAssetBenchJson(report));
    }
    process.exit(exitCodeForStatus(status));
  }

  const raw = JSON.parse(readFileSync(join(process.cwd(), V1_PATH), "utf8"));
  const parsed = fileSchema.parse(raw);
  const inputs: BenchCaseInput[] = parsed.cases.map((c) => ({
    groundTruth: c.groundTruth,
    predictions: c.predictions,
  }));

  // Coverage inputs for this synthetic set: 6 tracked assets, 5 represented.
  // Documented approximation recorded in the report (not model-generated).
  const report = scoreBenchmark(inputs, { assetsTracked: 6, assetsRepresented: 5 });

  const failed = report.cases.filter((c) => !c.passed && !c.skipped);
  const passed = report.cases.filter((c) => c.passed && !c.skipped).length;
  const skipped = report.counts.skipped;

  console.log(
    `GridSight benchmark ${report.datasetVersion} (SYNTHETIC, no inference) — ${report.counts.cases} cases (${report.counts.defectiveCases} defective, ${report.counts.cleanCases} clean), model: none (pipeline logic only)`,
  );
  console.log(
    `detection: P=${f2(report.detection.precision)} R=${f2(report.detection.recall)} F1=${f2(report.detection.f1)} TP=${report.detection.truePositives} FP=${report.detection.falsePositives} FN=${report.detection.falseNegatives} FPclean=${report.detection.falsePositivesOnClean}`,
  );
  console.log(
    `association: acc=${f2(report.association.accuracy)} (${report.association.correct}/${report.association.evaluated}) unresolved=${report.association.unresolved}` +
      ` · evidence-frame: acc=${f2(report.evidenceFrame.accuracy)} (${report.evidenceFrame.correct}/${report.evidenceFrame.evaluated})` +
      ` · voice-link: acc=${f2(report.voiceMatching.accuracy)} (${report.voiceMatching.correct}/${report.voiceMatching.evaluated})`,
  );
  console.log(
    `verification: keep=${report.verification.kept} downgrade=${report.verification.downgraded} drop=${report.verification.dropped} skipped=${report.verification.skipped} errors=${report.verification.errors}`,
  );
  console.log(
    `coverage: ${report.coverage.assetsRepresented}/${report.coverage.assetsTracked} assets represented (unrepresented assets were NOT visually inspected)`,
  );
  for (const c of report.cases) {
    const tag = c.skipped ? "SKIP" : c.passed ? "PASS" : "FAIL";
    console.log(`- [${tag}] ${c.caseId} (${c.scene}): expected ${c.expected} | got ${c.predicted}`);
    for (const m of c.mismatches) console.log(`    ! ${m}`);
  }
  console.log(
    `Result: ${passed} passed, ${failed.length} failed, ${skipped} skipped. ` +
      `Synthetic pipeline-logic benchmark — NOT a measure of visual detection accuracy.`,
  );
  if (live) {
    console.log(
      "Note: --live is not applicable to this synthetic set (no images); no Meta calls were made. Use scripts/eval.ts --live for the visual set.",
    );
  }
  console.log(`Limitations: ${report.limitations[0]}`);

  if (json) {
    const outPath = isAbsolute(json) ? json : join(process.cwd(), json);
    writeFileSync(
      outPath,
      toBenchJson({ ...report, limitations: [...report.limitations, live ? "--live passed but n/a for synthetic set; no inference performed." : "Default quota-free run; no inference performed."] }),
    );
  }
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("bench failed:", err instanceof Error ? err.message : err);
  const code = (err as { benchExitCode?: unknown }).benchExitCode;
  process.exit(typeof code === "number" && Number.isInteger(code) ? code : 1);
});
