# GridSight benchmark v1 (SYNTHETIC — pipeline logic only)

This benchmark is **explicitly synthetic**. It contains no real images and makes
no Meta API calls. It measures whether the evidence pipeline handles
associations, frames, verification, and coverage honestly — not whether the
vision model detects rust in the field.

- Cases: `cases.json` (8 cases, unit = one case, grouped by scene).
- Provenance: `provenance.json`.
- Runner: `npx tsx scripts/bench.ts` (quota-free) or `npm run bench`.
- Real visual evaluation (30 labeled frames, cached vs live) lives in
  `scripts/eval.ts` + `fixtures/eval/` and is a separate mode.

Do not present `bench` numbers as real-world detection accuracy.
