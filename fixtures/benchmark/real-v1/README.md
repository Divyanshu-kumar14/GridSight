# GridSight benchmark real-v1 (REAL DERIVATIVE MEDIA, static-image, asset-level)

Derived (not genuine) video frames: Ken Burns zoompan over three CC stills.
Static-image evaluation only — image-level asset/defect detection. Tracking,
temporal selection, and note alignment are NOT APPLICABLE and report null.

- Cases: `cases.json` (13 cases over 12 images, 3 scenes, 6 asset instances,
  1 defect episode EP-RUST-POLE-01 across 5 frames — f028 holds both the
  defective pole (R-13) and the clean fence (R-11) — 7 clean + 1 uncertain = 8 clean).
- Provenance: `provenance.json` (licenses as stated in repo, URLs/authors NOT
  recorded — verify before external redistribution; checksums included).
- Runner: `npx tsx scripts/bench.ts --dataset=real-v1` or `npm run bench:real`.
  `--predictions=<artifact.json>` scores a completed run artifact
  (`{status:"completed", predictions:[...]}`); without it the benchmark is
  NOT EVALUATED (exit 2), never a failure and never a pass.
- Scored example (committed): `predictions-cached-v1.json` — 12 recorded
  `muse-spark-1.3` outputs (`provenance: cached`), scored with the static
  frame-linked matcher. Run it with a single command:
  `npm run bench:real:scored` (expects PASS, P=1.00 R=1.00 on EP-RUST-POLE-01).
  `provenance: actual` would require a run manifest with per-frame
  provider-request evidence — this artifact honestly stays `cached`.
- Exit codes: 0 scored-pass · 1 scored-fail · 2 not-evaluated (no predictions) ·
  3 input error (bad ground truth, malformed/stale/missing-explicit artifact).
- No predictions ship with this dataset by default: visual accuracy reports UNAVAILABLE
  until matching pipeline predictions are recorded. The committed
  `predictions-cached-v1.json` is the one scored exception (recorded outputs,
  `cached` provenance — never presented as live `actual` inference). Hand-authored
  prediction fixtures in unit tests validate the scorer only.

Do not present cached `fixtures/eval/cache` outputs as predictions for these
cases: they carry synthetic slug asset IDs, no boxes, and no stable mapping.
