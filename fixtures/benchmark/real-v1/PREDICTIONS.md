# Recording an actual prediction run for real-v1

This runbook is the only supported path from a GridSight inference execution to
a scored `real-v1` result. It preserves the three-state rule: **missing runs
are not evaluated, failed runs are errors, and only completed runs score.**

## The run manifest (required for `actual`)

A prediction artifact whose entries claim `provenance: "actual"` is accepted
only with a `run` manifest that verifies end to end. A bare `actual` label
without one is rejected (exit 3) — the label never overrides missing evidence.

Build it from the pipeline's real execution records (never by hand-waving):

```
# 1. Run the pipeline for real (no USE_CACHED), saving each stage's raw model
#    response text to <dir>/<stage-key>.json as you go.
# 2. Assemble the prediction array for real-v1 (stable case/episode/asset IDs
#    only where the documented mapping below allows; else assetId null).
npx tsx scripts/collect-run-manifest.ts --session=<id> \
  --responses-dir=<dir> --predictions=/path/predictions.json \
  --dataset-version=real-v1 \
  --stage-modes=transcribe=fixture,tag-assets=fixture \
  --out=/tmp/run-manifest.json
# 3. Attach and score:
npx tsx scripts/eval-to-predictions.ts --cache-dir=<recorded outputs> \
  --provenance=actual --run-manifest=/tmp/run-manifest.json --json=/tmp/artifact.json
npx tsx scripts/bench.ts --dataset=real-v1 --predictions=/tmp/artifact.json
```

`collect-run-manifest` reads SQLite jobs (per-stage status and timestamps),
the persisted report (`modelRun` provider/model; contradictions fail the run),
recomputes input checksums from the verified provenance manifest, and requires
a saved raw response for every stage claimed as `inference` (`responseDigest`
recorded; a declared `inference` without one is refused). Declared
`cache`/`fixture`/`skipped` modes are allowed only with no provider request
behind them. Transcribe/tag have no job records in this pipeline; their modes
are operator-declared and marked as such in the manifest notes.

## What each piece of evidence establishes

- `runId` plus SQLite job rows: **which execution** produced the outputs (real
  pipeline records), and that its stages completed.
- `responseDigest` per inference stage: **what bytes** the operator saved as
  the provider's response. Digests are recomputed on verification; mismatches fail.
- `predictionsDigest`: links the exact scored prediction array to the manifest.
  Any edit after recording breaks the link (exit 3).
- `inputs` checksums: the artifact describes **this media**; altered or swapped
  frames fail instead of scoring.
- `provider`/`model`: identifiers only (e.g. `meta` / `muse-spark-1.3`).
  **No credentials are ever persisted** — manifests carrying secret-like values
  are rejected, and the collector never reads key material.

## What still relies on trust, and the remaining blocker

The manifest proves **linkage and internal consistency**, not that a provider
sent the saved bytes: genuine execution additionally requires operator custody
of the raw responses (save them straight from the run; never fabricate them).
The smallest pipeline-side step that would remove even that trust is
per-request response-digest logging in the report/tag routes (append-only JSONL
of `{runId, stage, provider, model, responseDigest, at}` — digests only, no
prompts, no secrets). That instrumentation is **not yet implemented**: until it
is, an `actual` score means "predictions trace to a completed execution record
with saved responses whose digests verify," not "the wire call was observed."


## What the artifact must contain

A JSON envelope (produced by `scripts/eval-to-predictions.ts` or equivalent):

```json
{
  "status": "completed",
  "datasetVersion": "real-v1",
  "model": "muse-spark-1.3 via meta",
  "recordedAt": "2026-10-27T12:00:00.000Z",
  "provenanceDefault": "actual",
  "inputs": { "f021": "<sha256 of fixtures/eval/frames/f021.jpg>", "...": "..." },
  "predictions": [
    {
      "caseId": "R-08",
      "episodeId": "EP-RUST-POLE-01",
      "assetId": "rust-pole-foreground",
      "category": "pole",
      "defectClass": "rust",
      "frameContainsDefect": true,
      "bbox": { "x": 0.135, "y": 0, "w": 0.06, "h": 1 },
      "evidenceSource": "visual",
      "assetAssociation": "confirmed",
      "verification": "keep",
      "provenance": "actual"
    }
  ],
  "notes": []
}
```

Field rules:

- `status` must be `"completed"`. `"failed"`/`"pending"` artifacts are input
  errors (exit 3), never scored as zero detections.
- `datasetVersion` must equal the benchmark (`real-v1`); mismatches are stale
  and rejected.
- `inputs` maps each evaluated frameId to its source-file SHA-256. The runner
  recomputes and rejects mismatches: an artifact that does not describe **this
  media** cannot score. Omit `inputs` only for legacy artifacts, with a warning.
- `caseId`/`episodeId`/`assetId` may **only** be populated through a documented,
  defensible mapping (stable pipeline tracking IDs aligned to the annotated
  `assetId`s, or per-case review). When the mapping cannot be established,
  leave them `null` — the prediction is then reported under
  `unmappablePredictions`, never guessed into an asset identity.
- `provenance: "actual"` is ONLY for outputs of a genuinely executed inference
  run you just performed. Cached, replayed, or test-fixture outputs are
  `"cached"` / `"hand-test"` and are never presented as model performance.
- No credentials, API keys, or environment values belong in the artifact. Ever.
- An actual completed run that found nothing is `{"status":"completed",
  "predictions": []}` — that scores as zero detections (recall 0 on the rust
  episode). An API failure, skipped run, or absent result must NEVER be written
  as an empty completed list.

## Why `scripts/eval.ts` outputs do not map today

`fixtures/eval/cache/*.json` entries carry per-frame `after[]` defects with
synthetic slug asset IDs (`pole-001`), `evidenceFrameIndex: 0`, and **no
bboxes**. Three things block asset-level mapping:

1. **Asset identity**: slugs are invented per call, not stable tracking IDs —
   they cannot be joined to annotated `assetId`s.
2. **Localization**: no boxes are recorded, so the IoU gate cannot run.
3. **Evidence semantics**: the single-frame prompt cites frame 0 of one image,
   not an episode-level evidence frame.

`scripts/eval-to-predictions.ts` converts cache entries into an artifact that is
explicit about exactly this: predictions keyed by source frameId, `assetId:
null`, association `unresolved`, no boxes. Scored against real-v1 they land in
`unmappablePredictions` while the rust episode reports FN with the reason
stated — a demonstrated mapping gap, not a model grade. A future pipeline run
that emits stable asset/episode references (or a careful per-case review using
this runbook's mapping rule) replaces those fields; until then, do not claim
end-to-end compatibility.

## Single-image runs with boxes: the static scoring path

For the 12 real-v1 frames, run the standalone path end to end (no app
session, no SQLite, no tracking — stills only):

```
# 0. Preflight (quota-free): verifies the 12 inputs against the manifest,
#    reports cache policy, out dir, model ids, and request bounds. No calls.
npx tsx scripts/eval.ts --dry-run --static-bboxes --cache-dir=/tmp/run1/cache --out-dir=/tmp/run1

# 1. Genuine inference, isolated cache, boxes requested in original-image coords.
#    Writes per-frame run-log.json to the out dir (never into fixtures/).
npx tsx scripts/eval.ts --live --static-bboxes --cache-dir=/tmp/run1/cache --out-dir=/tmp/run1 \
  --frames=f001,f003,f006,f009,f011,f014,f018,f021,f023,f025,f028,f030 --json=/tmp/run1/eval.json

# 2. Adapt to a frame-linked artifact, building the run manifest from the
#    run-log's per-frame execution records (no SQLite involved).
npx tsx scripts/eval-to-predictions.ts --format=static --cache-dir=/tmp/run1/cache \
  --run-log=/tmp/run1/run-log.json --provenance=actual \
  --inputs-manifest=fixtures/benchmark/real-v1/provenance.json \
  --json=/tmp/artifact.json

# 3. Score with the static matcher (frame-linked, IoU where GT boxes reliable).
npx tsx scripts/bench.ts --dataset=real-v1 --scoring=static --predictions=/tmp/artifact.json [--json=out.json]
```

Static matching rules: a prediction matches a GT defect iff same frame,
category + defect class agree, and (where GT has a reliable box) IoU ≥ 0.5.
Episode f021–f030 counts once. Invalid/missing boxes withhold localization and
the TP; clean frames with predictions are FPs; uncertain cases stay excluded;
unknown frame IDs fail the run (exit 3) instead of scoring. Asset association
is unavailable by design on this path — single images carry no stable asset
identity, and category strings are never treated as identity. `--scoring`
defaults to `asset` (unchanged legacy behavior); the asset path still reports
these predictions as unmappable rather than guessing.

## Scoring the artifact

```
npx tsx scripts/bench.ts --dataset=real-v1 [--scoring=static] --predictions=/path/artifact.json [--json=out.json]
```

Exits: 0 pass · 1 fail · 2 not evaluated (no `--predictions`) · 3 input error.
