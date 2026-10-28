# GridSight

I built GridSight so drone footage of a substation turns into a severity-ranked defect list — every finding tagged **VISUAL** (cited frame) or **VOICE ONLY** (inspector's words, unverified), exportable as CSV.

[![License: MIT](https://img.shields.io/github/license/Divyanshu-kumar14/GridSight)](LICENSE)

![GridSight landing page with a synthetic tracking feed showing labeled asset boxes over a substation schematic](docs/assets/landing-hero.png)

## Overview

One substation pass produces thousands of frames. No inspector watches all of it at 1× and catches everything. I made GridSight for the inspector who flies the yard, dictates notes on the drive back, and needs a ranked defect list before the next shift.

**Before:** 45 minutes of 60fps drone video = 162,000 frames to review, plus an estimated ~3 hours of manual video scrubbing and spreadsheet logging back at the office. **After:** a roughly 15-minute automated pass during the drive back → verified, frame-cited CSV defect list ready before the truck parks. *(Frame count is exact arithmetic; the time figures are planning estimates, not measured results.)*

The loop I wired: upload a clip → track every asset with SAM 3.1 video segmentation → transcribe voice notes → pin each note to the asset visible at that moment → generate a report where Spark writes the defects and my server code rebuilds the envelope. A second verification pass re-checks every visual finding against a fresh extraction of the exact frame it cited, and the model has to answer one question: does this frame concretely show the claimed damage?

No key? `USE_CACHED=true` serves frozen fixtures for the full loop with zero API burn — an offline fallback I froze myself, not live data. The cached demo showcases both paths: one **VISUAL** verified finding (frame citation + tracked SAM bbox + `keep` verdict) and one **VOICE ONLY** downgraded finding.

## Try it in 60 seconds

No API key, no network calls, no quota:

```bash
npm install
npm run dev   # http://localhost:3000 → Open sample report
```

Click **Open sample report** (Explore a sample inspection). It calls `POST /api/demo-session`
— a validated endpoint I added that builds a fresh session from frozen fixtures with zero inference —
and opens a complete sample report clearly marked **SAMPLE / CACHED** (not from your video,
no playable video). For live inference, set `MODEL_API_KEY` in `.env.local` and use
**Start a new (live) inspection** instead. I wrote the full guide in `docs/SETUP.md`.

## Features

- **Sample in one click, live when ready** — I split the homepage into Explore sample (no key, no upload, `POST /api/demo-session`) vs Start live (MP4/MOV + optional voice, presets, advanced prompts). Sample vs live is always labelled; I never let live failures fall back to canned output.
- **Guided inspection run** — the workspace **Run inspection** button I added executes Track → Transcribe (skipped cleanly with no audio) → Match notes → Report + AI re-check in order, reusing completed billable stages, preserving partials, with per-stage Retry/Cancel and refresh recovery. The manual stage buttons are still there.
- **Track every asset in one pass** — SAM 3.1 multiplex segmentation with native-frame timestamps; I persist per-prompt results incrementally so a late failure never wipes earlier prompts (`src/lib/track-run.ts`).
- **Dictate instead of typing** — in-browser recording or audio upload, diarized into timestamped transcript segments. I made video-only workflows skip transcription + tagging honestly.
- **Notes pinned to assets, not timestamps** — each voice note links to the tracked object visible when it was spoken.
- **Reports that cite evidence** — every defect carries a frame citation, AI re-check status (`AI re-checked` / `Downgraded to voice-only` / `Rejected by AI review` / `Re-check unavailable`), and human-review status; my server code rebuilds statistics + coverage itself instead of trusting model JSON.
- **Honest coverage, no all-clear hype** — I label the stable-track rate as what it is (not inspection coverage); the ledger shows assets represented vs not in key frames, skipped re-checks, unresolved links, and items needing review. Zero findings says “No defects were confirmed in the evidence reviewed — not proof the yard is defect-free.”
- **Human review that sticks** — Confirm / Reject / Needs inspection + note + asset/description/action corrections through my validated `POST /api/report-review` (session-owned, unknown IDs rejected, verification untouched, survives refresh).
- **Usable exports** — CSV (with evidence provenance) plus **Print / Save as PDF** (print CSS, evidence images + overlays, limitations, AI-support warning).
- **Zero-hallucination default** — with no voice notes and no transcript, I instruct the model to return zero defects rather than invent damage.
- **Honest benchmarks** — I keep a real-image static benchmark that reports NOT EVALUATED instead of a fake score when no predictions are supplied, plus a committed cached run that scores (see [Evaluation](#evaluation)).

## Key innovations

- **Verification pass with teeth** (`src/lib/verify.ts`, tests in `src/lib/__tests__/verify.test.ts`): I re-extract visual findings at 1024px from the cited frame and re-judge them. `drop` removes the finding, `downgrade` strips visual claims to VOICE ONLY, and a failed infrastructure call marks `skipped` — kept, never deleted, because I consider deleting findings on infra failure the worst failure mode in a safety product.
- **Server-built report envelope** (`src/app/api/generate-report/route.ts`): the model sometimes returns just `{summary, defects}` and drops the envelope, so I validate only the defects and recompute inspection/statistics myself.
- **Native-rate timestamps** (`src/lib/ffmpeg.ts`): I probe real fps via `ffprobe` at upload; SAM frame indices convert with it. A hardcoded 30 fps silently doubles every timestamp on 60 fps footage — this bit me once.
- **Resumable tracking runs** (`src/lib/track-run.ts`, `src/app/api/track/route.ts`): per-prompt persistence, prompt-boundary cancel checks, a server-side time budget, and closed-stream disconnects I report as disconnects with partial counts — not as model errors, never as silent empty results.
- **Auditable evaluation** (`scripts/bench.ts`, `fixtures/benchmark/real-v1/`): I bind run manifests to the execution that produced the predictions (digests, dataset version, input checksums, per-frame provider-request evidence). My static-image benchmark separates detection (frame + category + visual evidence) from localization, and marks defect localization unavailable where ground-truth strips and model damage boxes annotate different targets — instead of laundering one into the other.

## Meta platform usage

I route every call through the Meta API (`https://api.meta.ai/v1`, OpenAI-compatible client); model IDs live in `src/lib/models.ts`.

| Role | Model | Used in |
|---|---|---|
| Eyes | `sam-3.1` | `src/lib/sam.ts` — text-prompted video segmentation, SSE record parsing (`<Nf>…<\|box…\|>` grammar) |
| Ears | `muse-voice-transcribe-1.0` | `src/app/api/transcribe/route.ts` — diarized drive-back memos |
| Analyst | `muse-spark-1.3` (or Muse Spark Open via `SPARK_PROVIDER`) | `src/lib/tagging.ts`, `src/app/api/generate-report/route.ts` — note-to-asset matching, defect drafting, verification verdicts |

Tracking (SAM), Files, and transcription always stay on Meta; only tagging/report/verification can move to Baseten or Modal. I stamp the active provider on every report (`modelRun`).

## Architecture

```mermaid
flowchart LR
    U[Inspector uploads MP4 + audio] --> UP["POST /api/upload"]
    UP --> DB[(SQLite sessions/jobs)]
    UP --> TRK["POST /api/track"]
    TRK --> SAM["SAM 3.1 video segmentation"]
    SAM --> TRK
    TRK --> DB
    U --> VO["Record / stage voice memo"]
    VO --> ASR["POST /api/transcribe"]
    ASR --> DB
    DB --> TAG["POST /api/tag-assets"]
    TAG --> SPK["Spark note-to-asset matching"]
    SPK --> REP["POST /api/generate-report"]
    REP --> VRF["Spark verification per finding"]
    VRF --> UI["Workspace, report page, CSV export"]
```

Upload probes duration/fps and stashes the clip; tracking streams per-prompt progress over SSE into cancellable jobs; transcription and tagging attach to the same session; the report endpoint validates model defects, rebuilds the envelope, and persists the artifact the report page renders.

## Hackathon Contributions

I'm keeping this strictly to what `git log` shows. The initial commit (`e380f4f`) contains only `LICENSE` and a two-line README stub — that was the pre-existing foundation in this repo's history. I added the application and everything below it in the commits after that:

- **End-to-end inspection pipeline** (`056c1f2`): upload, SAM tracking, transcription, note tagging, and the defect-report flow in one Next.js app.
- **Evidence-cited reporting** (`34ab1d6`, `75dea05`, `bf51dad`): key frames sent to Spark, evidence labeled server-side, and a second-pass verification audit of visual findings.
- **Spark provider switch** (`45759a8`): tagging/report/verification can run on Muse Spark via Meta, Baseten, or Modal, with the active provider stamped on each report (`modelRun`).
- **Quota-free evaluation** (`e87eba6`, `9620335`, `b04ba34`, `00e6ab5`): labeled-set and real-image benchmarks with run manifests, committed recorded responses, `NOT EVALUATED` semantics for unscored runs, and a scored cached run.
- **Tracking hardening** (`5211763`, `90aa83b`, `858d7cc`): per-prompt persistence, retry isolation, upstream cancel propagation, time budgets, and partial-result handling so late failures do not wipe earlier prompts.
- **Deployment** (`18802ac`): Docker container with a health endpoint.

The demo path is the one in [Try it in 60 seconds](#try-it-in-60-seconds): cached mode runs the same upload → track → transcribe → tag → report loop on frozen fixtures with no API calls, and the report it returns distinguishes one VISUAL verified finding from one VOICE ONLY downgraded finding. Live mode uses the three-model workflow in [Meta platform usage](#meta-platform-usage); I run no image-generation model in either path.

## Evaluation

Three harnesses, all runnable without a key or network. I reproduced the numbers below from this repo (vitest 333 passed / 25 files; `eval:smoke` 11 checks passed).

**Frame eval** — cached model outputs re-scored against 30 labeled frames (20 clean, 10 defective), zero quota:

```bash
npx tsx scripts/eval.ts          # cached re-scoring, no inference
npx tsx scripts/eval.ts --live   # re-records responses (burns quota, needs the clip)
```

```
GridSight eval — 30 frames (20 clean, 10 defective) — model muse-spark-1.3
first pass P=1.00 R=1.00 FP=0 FN=0 · verified P=1.00 R=1.00 FP=0 FN=0
```

Read honestly: the 10 defective frames are adjacent seconds of the *same* rusted pole, not ten independent defects. I treat this as a hallucination-rate and single-defect-recall smoke test, not a benchmark. `fixtures/eval/cache/` holds the recorded per-frame responses; I set ground truth in `fixtures/eval/labels.json` by viewing frames before any model run.

**Real-image benchmark** — 13 annotated cases over 12 derivative stills (3 scenes, 6 assets, 1 rust-pole defect episode across 5 frames), with checksummed provenance in `fixtures/benchmark/real-v1/`:

```bash
npm run bench        # synthetic pipeline-logic cases: 8 passed, 0 failed
npm run bench:real   # real-v1: exits 2, every case NOT EVALUATED — no artifact supplied
npm run bench:real:scored  # real-v1 + committed cached predictions: PASS, P=1.00 R=1.00
```

The scored run uses `fixtures/benchmark/real-v1/predictions-cached-v1.json` — 12 recorded `muse-spark-1.3` outputs (`provenance: cached`, 5 visual rust keeps on f021/f023/f025/f028/f030, 7 clean no-findings) scored with the static frame-linked matcher. I match detection on frame + category + visual evidence only; boxes never gate detection on this path. `provenance: actual` would require a run manifest with per-frame provider-request evidence (see `PREDICTIONS.md`) — this artifact honestly stays `cached`, never `actual`.

No predictions ship with the dataset by default, so visual accuracy reports UNAVAILABLE until matching pipeline predictions are recorded (`--predictions=<artifact.json>`). I made the exit codes contractual: 0 pass · 1 fail · 2 not-evaluated · 3 input error. An incomplete or manifest-less run exits 2 — never a silent pass, never a fabricated zero.

## What is real vs. simulated

| Component | Status | Evidence |
|---|---|---|
| Upload, track, transcribe, tag, report, CSV export | Working | `src/app/api/*`, exercised live and in tests |
| SAM tracking on full-resolution footage | Working | 594-frame tower track in a recorded session |
| Sample inspection (`POST /api/demo-session` + `USE_CACHED=true`) | Frozen sample, labelled | `src/lib/demo-fixture.ts` + `fixtures/demo-session/` — zero burn; one VISUAL AI re-checked finding + one VOICE-ONLY downgraded finding; workspace + report show SAMPLE/CACHED banners |
| Human review + persistence | Working | `POST /api/report-review`, `DefectCard` review controls, validated + tested |
| Print / Save as PDF | Working (browser print) | `window.print()` + print CSS in `globals.css`; accurately labelled, not a direct PDF download |
| Dashboard statuses | Working | Server state (sample/in-progress/failed/complete + review flags from evidenceCoverage) |
| Local setup | Working | `docker-compose.yml` (persistent `gridsight-data` volume matching `store.ts`), `docs/SETUP.md` |
| Honest coverage ledger | Working | `computeEvidenceCoverage` + `computeAssetReview` + `needsHumanReview` (tested in `trust.test.ts`) |
| Benchmark detection scores | Measured on recorded outputs | `bench:real:scored` reports P=1.00 R=1.00 on the rust episode (12-frame cached run); `bench:real` without predictions stays NOT EVALUATED |
| Synthetic benchmark (`bench`) | Working, limited | 8 pipeline-logic cases — evidence handling only, no images |

## Quick start

You'll need **Node 22.5+** (I use `node:sqlite`), plus `ffmpeg` + `ffprobe` on `PATH` (duration/fps probing, thumbnails, key frames).

```bash
npm install
npm run dev                  # http://localhost:3000 → Open sample report (no key needed)
# Live inference only: cp .env.example .env.local, then set MODEL_API_KEY
```

| Command | What it does |
|---|---|
| `npm run dev` | Dev server (`--port 3101` to pin a different port) |
| `npm test` | Vitest suite — 333 tests, 25 files |
| `npx tsc --noEmit` | Typecheck |
| `npm run lint` | Next.js ESLint |
| `npm run build` | Production build (12 API routes + 4 pages) |
| `npm run eval:smoke` | Quota-free pipeline smoke test (11 checks) |

Helper scripts (each burns quota unless noted):

```bash
npx tsx scripts/smoke-meta.ts   # one-shot API smoke test — run sparingly
npx tsx scripts/smoke-models.ts # per-model PASS/FAIL probe — never in CI
npx tsx scripts/cache-demo.ts   # freeze a live session into fixtures for offline demo
```

`fixtures/demo-session/report.json` is a representative sample, not a captured run. To capture a real SAM response for the parser test: `npx tsx scripts/capture-sam-sample.ts <file_id> "<prompt>"` (one call, never in CI).

## Configuration

All in `.env.local` (never committed):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MODEL_API_KEY` | Yes (live) | — | Meta API key (vision + language) |
| `SPARK_PROVIDER` | No | `meta` | Spark endpoint: `meta`, `baseten`, `modal` — env only, no UI picker |
| `SPARK_MODEL` | No | `muse-spark-1.3` | Model override for `meta` |
| `BASETEN_BASE_URL` / `BASETEN_MODEL` / `BASETEN_API_KEY` | For `baseten` | inference.baseten.co, `meta-models/muse-spark-open-1026` | Muse Spark Open via Baseten |
| `MODAL_BASE_URL` / `MODAL_MODEL` / `MODAL_API_KEY` | For `modal` | — | Muse Spark Open self-served (all three required) |
| `NEXT_PUBLIC_APP_URL` | No | `http://localhost:3000` | Public URL |
| `USE_CACHED` | No | `false` | `"true"` serves frozen fixtures, zero API burn (offline demo) |
| `GRIDSIGHT_TMP_DIR` | No | `/tmp/opencode/gridsight` | Scratch dir (video, frames, audio, reports) |
| `GRIDSIGHT_DB_PATH` | No | `<scratch>/gridsight.db` | SQLite path override |

I fail loudly at request time on missing keys, never by silent fallback. Tracking (SAM), Files, and transcription always stay on Meta.

## Tech stack

- **App:** Next.js 14 App Router, React 18, Tailwind CSS. I run no database server — SQLite via `node:sqlite` (WAL mode) plus a local scratch dir.
- **AI:** `openai` SDK pointed at Meta; I keep all model IDs in `src/lib/models.ts`. I retired Muse Image from the report path (deterministic bbox overlays instead).
- **Validation:** I put Zod schemas on every API boundary; envelope-tolerant report parsing.
- **Tests:** Vitest, co-located in `src/lib/__tests__/`.

## Project structure

```
src/
  app/
    page.tsx                 landing + upload (sample vs live)
    dashboard/               all inspections (honest statuses)
    inspection/[id]/         workspace (guided run + manual stages)
    inspection/[id]/report/  final report + CSV + Print/PDF + human review
    api/
      upload/ track/ transcribe/ tag-assets/
      generate-report/ report-review/ demo-session/
      frames/ sessions/ jobs/ health/
  lib/
    sam.ts track-run.ts  SAM request shape, SSE parser, resumable prompt loop
    meta-client.ts models.ts  OpenAI SDK client, single source of model IDs
    store.ts db.ts        SQLite persistence (isSample-aware)
    jobs.ts               cancellable job engine + SSE progress
    frames.ts ffmpeg.ts   thumbnails, key frames, probing
    tagging.ts            voice-note → asset matching
    report.ts verify.ts   prompts, evidence labeling, validation, audit pass, coverage ledger
    export.ts net.ts audio.ts client-video.ts
    demo-fixture.ts       frozen offline data (demo-session + USE_CACHED)
  components/  UploadZone, TrackingViewport, VideoOverlayPlayer,
               TranscriptPanel, AssetList, Timeline, DefectCard (AI + human review),
               SeverityChart, PipelineProgress (Waiting/Running/Complete/Needs attention)
fixtures/      eval/ (labels + recorded responses), benchmark/ (v1 synthetic, real-v1 static-image)
scripts/       eval.ts, bench.ts, eval-smoke.ts, eval-to-predictions.ts, smoke-*.ts, cache-demo.ts
docs/          SETUP.md (plain-English local setup)
```

## API sketch

| Route | Method | Notes |
|---|---|---|
| `/api/upload` | POST | multipart video (+ optional audio); metadata optional (“Not provided”); probes duration/fps |
| `/api/demo-session` | POST | validated sample session from frozen fixtures; zero inference; `{sample:true}` |
| `/api/track` | POST | SSE stream; `{sessionId, prompts[]}`; cancellable, per-prompt persistence |
| `/api/transcribe` | POST | multipart audio or `{sessionId}`; 404 no-audio = clean skip for video-only |
| `/api/tag-assets` | POST | `{sessionId}` → notes with `matchedAssetId`; 400 no-transcript = clean skip |
| `/api/generate-report` | POST/GET | SSE stream / fetch saved report; server-computed coverage ledger |
| `/api/report-review` | POST | `{sessionId, defectId, status, note?, corrections?}`; session-owned, validated, verification untouched |
| `/api/frames/[sessionId]/[name]` | GET | JPEG thumbnails + key frames |
| `/api/sessions[?sessionId=]` | GET | list (with `isSample`) or single session + transcript/tagged/hasReport for resume |
| `/api/jobs` | POST | `{action: "cancel", jobId}` |

## Deploy (Docker)

Serverless can't run what I built (`ffmpeg`/`ffprobe` for probing and key frames, writable SQLite, local scratch dir), so I ship it as a container:

```bash
docker build -t gridsight .
docker run -p 3000:3000 -e MODEL_API_KEY="$MODEL_API_KEY" gridsight
# or (persistent storage + healthcheck + restart):
# Fresh clone, sample first — no .env.local needed (.env.local is optional):
docker compose up --build
# Live inference afterwards: cp .env.example .env.local, set MODEL_API_KEY,
# then re-run: docker compose up --build
```

See `docs/SETUP.md` for ports, volumes (`gridsight-data` → `/tmp/opencode/gridsight`),
backup/delete, and troubleshooting.

`GET /api/health` returns `{ ok, ffmpeg, dbWritable, version }` with no auth and no secrets (also the container HEALTHCHECK).

## Known limits

- Single-user, single-node: SQLite + local scratch dir, no auth. My human review records no reviewer identity (I have no auth) — only status/note/corrections + timestamp.
- The sample (`POST /api/demo-session` or `USE_CACHED=true`) is a frozen two-finding sample I froze: one `VISUAL` AI re-checked finding and one `VOICE ONLY` downgraded finding. No playable video. The `VISUAL` path on live footage needs a real run — I freeze those with `scripts/cache-demo.ts` before recording.
- Key frames are downscaled to 1280px (q≈4, ~40–150KB) before they are sent to Spark; full-resolution frames would blow the vision request budget. Only ≤8 key frames are reviewed per report — assets absent from those frames were not visually reviewed (shown as “not represented”).
- “Stable-track rate” (≥3 observations) is not inspection coverage; “AI re-checked” is not ground truth or engineer approval. Zero findings never means the yard is defect-free.
- Transcription needs staged audio (record in-browser or attach a file); visual findings still work without it, but note-only findings require a transcript.
- Thumbnail/key-frame extraction needs `ffmpeg`; failures skip loudly per-asset without failing the batch.
- No cross-flight asset re-identification: I never claim two inspections show the same physical asset without manual confirmation (Asset Condition Passport deferred).
- Scene-level tracking prompts (e.g. "electrical substation") return whole-frame boxes — I recommend object-level prompts ("insulator", "transformer tank") for usable tracks.
- Exports: CSV ships (with `evidenceSource` + `observation` columns); **Print / Save as PDF** works through the browser's print dialog (`window.print()` + print CSS in `globals.css`) — accurately labelled, not a direct download. Direct server-generated PDF export is not implemented.

## License

MIT — see [LICENSE](LICENSE).
