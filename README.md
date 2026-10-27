# GridSight

One 24-second substation pass holds 32 trackable assets across 4,352 frames — no inspector watches all of that at 1× and catches everything. GridSight is for the substation inspector who flies the yard, drives back dictating notes, and needs a ranked defect list before the next shift.

What the AI does with your footage (four Meta models, one line each):
- **Eyes** (`sam-3.1`) — tracks every asset across the video in one pass, with native-frame timestamps.
- **Ears** (`muse-voice-transcribe-1.0`) — diarizes drive-back voice memos into timestamped segments.
- **Analyst** (`muse-spark-1.3` on Meta, Muse Spark Open via `SPARK_PROVIDER`) — looks at the actual key frames, aligns notes to assets, writes the report as structured JSON.
- **Marker** (deterministic, no model) — pins each defect to its tracked bounding box on the real frame. No painted damage, ever.

Out comes a severity-ranked report where every finding is tagged **VISUAL** (cited frame) or **VOICE ONLY** (your words, unverified) — exportable as CSV.

60-second demo: upload a clip → Track → record a voice note → Transcribe → Tag → Generate Report → open the report and click a defect to jump to its frame.

No key? `USE_CACHED=true` serves frozen fixtures for the full loop with zero API burn — an offline fallback, not live data.

Built with Next.js 14 + TypeScript + Tailwind. No database server — persistence is SQLite (`node:sqlite`, WAL mode). Vision and language run through the Meta API (`https://api.meta.ai/v1`, OpenAI-compatible).

## How it works

```
Upload (video + inspector audio)
  → Track      SAM 3.1 video segmentation, native-fps timestamps, cancellable job
  → Transcribe inspector voice notes to timestamped segments
  → Tag Assets link each note to the tracked asset visible at that moment
  → Report     Spark writes the defects; server builds the envelope
               (inspection stats recomputed, never trusted from the model)
  → Review     dashboard, inspection workspace, report page, CSV export
```

Key behaviors worth knowing:

- **Timestamps are native-rate.** Upload probes the real fps via `ffprobe`; SAM frame indices are converted with it. A hardcoded 30 fps silently doubles every timestamp on 60 fps footage — this bit us once.
- **The report envelope is server-built.** The model sometimes returns just `{summary, defects}` and drops the envelope. The API validates only the defects and rebuilds inspection/statistics itself.
- **No hallucinated defects.** With no voice notes and no transcript, the model is instructed to return zero defects rather than invent damage. Measured: 0 false positives across 20 clean frames (see [Verification pass](#verification-pass)).

## Verification pass

A defect report is a safety artifact, so the pipeline does not trust its own first pass. Every finding marked **VISUAL** is re-checked against a 1024px re-extraction of the exact frame it cited, and the model must answer one question: does this frame concretely show the claimed damage?

It returns `keep`, `downgrade`, or `drop`. The server applies the verdict — the model never edits the report itself.

| Verdict | Effect on the finding |
|---|---|
| `keep` | unchanged, badged `VERIFIED` |
| `downgrade` | visual claims stripped, becomes **VOICE ONLY** |
| `drop` | removed from the report |
| `skipped` | verification could not run — finding is **kept**, never deleted |

Voice-only findings are never audited; there is nothing visual to check. A failed or unparseable verification call marks the finding `skipped` and leaves it in the report. Deleting findings because an infrastructure call failed would be the worst available failure mode in a safety product.

### Measured

```
GridSight eval — 30 frames (20 clean, 10 defective) — model muse-spark-1.3
┌────────────┬───────────┬────────┬──────┬──────┐
│ mode       │ precision │ recall │ FP   │ FN   │
├────────────┼───────────┼────────┼──────┼──────┤
│ first pass │      1.00 │   1.00 │    0 │    0 │
│ verified   │      1.00 │   1.00 │    0 │    0 │
└────────────┴───────────┴────────┴──────┴──────┘
```

On 30 labeled frames (20 clean): 0 false positives, and the one real defect — rust on a pole — was found in all 10 frames that show it. Verification confirmed all 10 and dropped none.

**Read that honestly.** The 10 defective frames are ten consecutive seconds of the *same* rusted pole, not ten independent defects. The set measures hallucination rate and single-defect recall; it is a smoke test, not a benchmark. There is no false positive here for the verifier to remove, so the table shows the verifier does not *harm* correct findings. The `downgrade` and `drop` paths are covered by unit tests in `src/lib/__tests__/verify.test.ts`.

Reproduce these numbers with no API key and no network:

```bash
npx tsx scripts/eval.ts          # scores the committed responses
npx tsx scripts/eval.ts --live   # re-records them (burns quota, needs the clip)
```

`fixtures/eval/cache/` holds the recorded per-frame responses and is committed. Ground truth lives in `fixtures/eval/labels.json` and was set by viewing the extracted frames before any model run.

## Quick start

Prerequisites: **Node 22.5+** (uses `node:sqlite`), `ffmpeg` + `ffprobe` on `PATH` (duration/fps probing, thumbnails, key frames).

```bash
npm install
cp .env.example .env.local   # then set MODEL_API_KEY
npm run dev                  # http://localhost:3000
```

| Command        | What it does                              |
|----------------|-------------------------------------------|
| `npm run dev`  | Dev server (`--port 3000` to pin the port) |
| `npm test`     | Vitest suite — 129 tests, 14 files         |
| `npx tsc --noEmit` | Typecheck                             |
| `npm run lint` | Next.js ESLint                           |
| `npm run build`| Production build (14 routes)              |

## Configuration

All in `.env.local` (never committed; `specs/` is also gitignored):

| Variable             | Purpose                                                        |
|----------------------|----------------------------------------------------------------|
| `MODEL_API_KEY`      | Meta API key (vision + language)                               |
| `SPARK_PROVIDER`     | Spark endpoint: `meta` (default) `baseten` `modal` — env only |
| `SPARK_MODEL`        | Model override for `meta` (default `muse-spark-1.3`)           |
| `BASETEN_API_KEY`    | Key for `SPARK_PROVIDER=baseten` (Muse Spark Open)             |
| `MODAL_BASE_URL` / `MODAL_MODEL` / `MODAL_API_KEY` | Required for `SPARK_PROVIDER=modal` |
| `NEXT_PUBLIC_APP_URL`| Public URL, default `http://localhost:3000`                    |
| `USE_CACHED`         | `"true"` serves frozen fixtures, zero API burn (offline demo) |
| `GRIDSIGHT_TMP_DIR`  | Scratch dir override (default `/tmp/opencode/gridsight`)      |

Helper scripts:

```bash
npx tsx scripts/smoke-meta.ts   # one-shot API smoke test — run sparingly, it burns quota
npx tsx scripts/smoke-models.ts # per-model PASS/FAIL probe — never in CI, it burns quota
npx tsx scripts/cache-demo.ts   # freeze a live session into fixtures for offline demo
```

Fixtures note: `fixtures/demo-session/report.json` is a representative sample, not a captured run — both findings are voice-sourced (`evidenceSource: "voice"`). To capture a real SAM response for the parser test: `npx tsx scripts/capture-sam-sample.ts <file_id> "<prompt>"` (one call, never in CI).

### Spark provider (open-weight prize)

Tagging + report generation can run on Meta's hosted API (default) or on Muse Spark Open served by an inference partner. The choice is stamped on every report (`modelRun`) and shown on the report page and in `/api/health` — that stamp is the prize proof.

```bash
SPARK_PROVIDER=baseten BASETEN_API_KEY="$KEY" npm run dev
```

`meta` needs only `MODEL_API_KEY`. `baseten` defaults to `https://inference.baseten.co/v1` and model `meta-models/muse-spark-open-1026` (that exact id — not `meta-spark-open`). `modal` requires `MODAL_BASE_URL` + `MODAL_MODEL` + `MODAL_API_KEY`. Missing keys fail loudly at request time, never by silent fallback. Tracking (SAM), Files, and transcription always stay on Meta.

## Deploy (Docker)

Serverless can't run this app (`ffmpeg`/`ffprobe` for probing and key frames, writable SQLite, local scratch dir), so it ships as a container:

```bash
docker build -t gridsight .
docker run -p 3000:3000 -e MODEL_API_KEY="$MODEL_API_KEY" gridsight
```

`GET /api/health` returns `{ ok, ffmpeg, dbWritable, version }` with no auth and no secrets (also the container HEALTHCHECK). Verified 2026-10-27: `ok:true`, landing + dashboard 200, full upload → track → report loop green with `USE_CACHED=true`, offline fixtures served from inside the image.

## Tech stack

- **App:** Next.js 14 App Router, React 18, Tailwind CSS, Geist type
- **AI:** `openai` SDK pointed at Meta — SAM 3.1 (`sam-3.1`) for tracking, Spark for tagging/analysis/report, Muse Image retired from the report path (deterministic bbox overlays instead). All IDs live in `src/lib/models.ts`.
- **Data:** `node:sqlite` (sessions, artifacts, jobs tables) + scratch dir for video/frames/reports
- **Validation:** Zod schemas on every API boundary; envelope-tolerant report parsing
- **Tests:** Vitest, co-located in `src/lib/__tests__/`

## Project structure

```
src/
  app/
    page.tsx                 landing + upload
    dashboard/               all inspections
    inspection/[id]/         workspace (tracking, transcript, report)
    inspection/[id]/report/  final report + CSV export
    api/
      upload/ track/ transcribe/ tag-assets/
      generate-report/ frames/ sessions/ jobs/ health/
  lib/
    sam.ts        SAM 3.1 request shape + SSE parser
    meta-client.ts  OpenAI SDK client for api.meta.ai
    store.ts db.ts  SQLite persistence
    jobs.ts       cancellable job engine + SSE progress
    frames.ts ffmpeg.ts  thumbnails, key frames, probing
    tagging.ts    voice-note → asset matching
    report.ts     prompts, evidence labeling, validation, stats
    models.ts     single source of truth for Meta model IDs
    export.ts images.ts net.ts audio.ts client-video.ts
    demo-fixture.ts  frozen offline data (USE_CACHED=true)
  components/  UploadZone, TrackingViewport, VideoOverlayPlayer,
               TranscriptPanel, AssetList, Timeline, DefectCard,
               SeverityChart, PipelineProgress
specs/         PRD + implementation plan (gitignored)
fixtures/      sample voice notes + demo session seed
scripts/       smoke-meta.ts, smoke-models.ts, cache-demo.ts, capture-sam-sample.ts
```

## API sketch

| Route | Method | Notes |
|---|---|---|
| `/api/upload` | POST | multipart video (+ optional audio); probes duration/fps |
| `/api/track` | POST | SSE stream; `{sessionId, prompts[]}`; cancellable |
| `/api/transcribe` | POST | multipart audio or `{sessionId}` |
| `/api/tag-assets` | POST | `{sessionId}` → notes with `matchedAssetId` |
| `/api/generate-report` | POST/GET | SSE stream / fetch saved report |
| `/api/frames/[sessionId]/[name]` | GET | JPEG thumbnails + key frames |
| `/api/sessions[?sessionId=]` | GET | list or single session meta |
| `/api/jobs` | POST | `{action: "cancel", jobId}` |

## Known limits

- Single-user, single-node: SQLite + local scratch dir, no auth.
- The cached demo (`USE_CACHED=true`) is a voice-only sample, so both findings show `VOICE ONLY`. The `VISUAL` path needs real footage — run it once live before recording.
- Key frames are downscaled to 1280px (q≈4, ~40–150KB) before they are sent to Spark; full-resolution frames would blow the vision request budget.
- Transcription needs staged audio (record in-browser or attach a file); visual findings still work without it, but note-only findings require a transcript.
- Thumbnail/key-frame extraction needs `ffmpeg`; failures skip loudly per-asset without failing the batch.
- PDF export is deferred; CSV export ships (with `evidenceSource` + `observation` columns).
