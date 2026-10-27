# Contributing to real-v1 (static-image, asset-level)

## Adding a sample

1. **Pick media first, claims never.** Choose a small, openly licensed image
   (CC BY 4.0 or compatible; verify the license page before importing). Record:
   source URL, author, exact license + license page, attribution, share-alike
   terms, whether it is a still or genuine video, and every transformation you
   apply. Never invent URLs, authors, dates, or licenses.
2. **Copy the frame** into `fixtures/eval/frames/` (or the dataset media dir),
   compute its SHA-256, and add a `sources[]` entry in `provenance.json` with a
   new `sourceMediaId` and a per-frame record.
3. **Annotate independently**: view the image yourself, assign a stable
   `caseId`/`assetId`, mark `clean` or a defect with `episodeId`, set a bbox
   only where reliably localizable (`bboxReliable`), and use `uncertain` +
   `excludedFrom: ["detection"]` where the evidence cannot support a label.
   Never derive labels from model outputs.
4. **Keep episodes single-scene**: all frames of one `episodeId` must share a
   `scene`. Same-category assets keep distinct stable IDs.
5. **Validate**: `npx tsx scripts/bench.ts --dataset=real-v1` runs dataset,
   manifest, and checksum validation; fix every error (exit 3) before opening
   a PR. Unknown historical facts stay `unknown — not recorded`; never
   backfill them with today's date (`verifiedDate` is the only current date).

## Recording predictions

No predictions ship with the dataset. To score a genuine run, follow
`PREDICTIONS.md`: build the envelope (status/datasetVersion/inputs/provenance),
map `caseId`/`episodeId`/`assetId` only through the documented rule, and score
with `--predictions=`. Cached replays stay `provenance: "cached"`; unit-test
fixtures stay `"hand-test"`.

## What stays out

Live API calls, credentials in artifacts, synthetic predictions presented as
model results, ground-truth edits to match predictions, and any claim that
static frames measure tracking or temporal selection.
