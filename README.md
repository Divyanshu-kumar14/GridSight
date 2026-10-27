# GridSight

One 24-second substation pass holds 32 trackable assets across 4,352 frames — no inspector watches all of that at 1× and catches everything. GridSight is for the substation inspector who flies the yard, drives back dictating notes, and needs a ranked defect list before the next shift.

What the AI does with your footage (four Meta models, one line each):
- **Eyes** (`sam-3.1`) — tracks every asset across the video in one pass, with native-frame timestamps.
- **Ears** (`muse-voice-transcribe-1.0`) — diarizes drive-back voice memos into timestamped segments.
- **Analyst** (`muse-spark-1.3`) — looks at the actual key frames, aligns notes to assets, writes the report as structured JSON.
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
- **No hallucinated defects.** With no voice notes and no transcript, the model is instructed to return zero defects rather than invent damage. For a report with teeth, record a voice note first.

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
| `npm test`     | Vitest suite — 75 tests, 10 files          |
| `npx tsc --noEmit` | Typecheck                             |
| `npm run lint` | Next.js ESLint                           |
| `npm run build`| Production build (14 routes)              |

## Configuration

All in `.env.local` (never committed; `specs/` is also gitignored):

| Variable             | Purpose                                                        |
|----------------------|----------------------------------------------------------------|
| `MODEL_API_KEY`      | Meta API key (vision + language)                               |
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
