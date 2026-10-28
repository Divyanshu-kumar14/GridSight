# GridSight local setup (plain English)

This guide gets you from zero to a first inspection without reading source code.

## 1. Try the sample (no key, no cost, ~1 minute)

Best first step for judges and nontechnical users.

```bash
npm install
npm run dev          # http://localhost:3000
```

1. Open the home page.
2. Click **Open sample report** (the “Explore a sample inspection” card).
3. You get a complete report with one VISUAL and one VOICE-ONLY finding.

What you are seeing:

- Frozen demo data from `fixtures/demo-session/` — clearly labelled
  **SAMPLE / CACHED** in the workspace and report.
- No API calls, no cost, no video upload needed.
- The sample has no playable video (“sample — no playable video”): the report,
  evidence images, verification verdicts, and CSV still work.
- These results were **not** generated from any video you upload.

Or with Docker (no API key, no env file needed on a fresh clone):

```bash
docker compose up --build   # http://localhost:3000 → Open sample report
```

`docker-compose.yml` treats `.env.local` as optional, so Compose starts
without it. Live inference inside Docker needs `.env.local` with
`MODEL_API_KEY` (see section 2), then `docker compose up --build` again.

## 2. Run a live inspection (your own footage)

You need a Meta API key in a server-side env file (never in the browser).

```bash
cp .env.example .env.local   # then edit .env.local
# MODEL_API_KEY=your-key-here
npm run dev                  # http://localhost:3000
```

1. Scroll to **Start a new (live) inspection**.
2. Read the cost + privacy box: video/audio is sent to the configured model
   provider and can consume credits. Exact cost depends on your provider plan —
   GridSight never claims an exact dollar figure.
3. Pick your drone clip (MP4/MOV, max 500 MB). You will see the real file name,
   size, and — when the browser can read it — duration and resolution.
   A low-resolution warning may appear; it is a warning, not a block.
4. Names are optional (blank becomes “Not provided” — no fake identity is invented).
5. Equipment presets default to insulator, transformer, busbar, connector,
   circuit breaker, arrester. Open **Advanced settings** only to customize prompts.
6. Voice memo is optional — skip it if you have no audio. The guided run skips
   transcription + note-matching cleanly for video-only inspections.
7. Click **Start Inspection**, then on the workspace press **Run inspection**
   (the guided one-click flow): Track → Transcribe (if audio) → Match notes →
   Report + AI re-check. Each stage shows Waiting / Running / Complete /
   Skipped / Needs attention. Completed billable stages are reused, not rerun.
   Manual buttons per stage still work, including Retry and Cancel.
8. Open the **Report** tab, then **Open full report**. Export via
   **Export CSV** or **Print / Save as PDF** (browser print dialog).

Sample vs live is always labelled: sample sessions say
**SAMPLE / CACHED — frozen demo data, not from your video**;
live sessions never fall back to canned output on failure (errors fail loudly).

## 3. Start / stop

```bash
npm run dev        # start (Ctrl+C to stop)
# or (no .env.local needed for the sample)
docker compose up --build     # start
docker compose down           # stop (data volume is kept)
```

Docker on a fresh clone: no environment-file step is required for the
sample. Add live credentials later with `cp .env.example .env.local`
(edit in `MODEL_API_KEY`), then re-run `docker compose up --build`.

Health check (no auth, no secrets):

```bash
curl http://localhost:3000/api/health
# { ok, ffmpeg, dbWritable, version, modelProvider, modelId }
```

## 4. Where data lives + backup / delete

Implementation: `src/lib/store.ts` (`GRIDSIGHT_TMP_DIR`, default
`/tmp/opencode/gridsight`) + SQLite `gridsight.db` via `node:sqlite`.

| What | Path |
|---|---|
| SQLite sessions/jobs/artifacts | `$GRIDSIGHT_TMP_DIR/gridsight.db` |
| Uploaded video / audio | `$GRIDSIGHT_TMP_DIR/video/`, `audio/` |
| Key frames / thumbnails | `$GRIDSIGHT_TMP_DIR/frames/` |
| Report JSON snapshots | `$GRIDSIGHT_TMP_DIR/reports/<sessionId>.json` |

With Docker Compose the whole directory persists in the `gridsight-data` volume.

Backup:

```bash
# Local
cp -r /tmp/opencode/gridsight ~/gridsight-backup-$(date +%F)
# Docker volume
docker run --rm -v gridsight-data:/data -v "$PWD":/out alpine tar czf /out/gridsight-backup.tgz -C /data .
```

Delete one session’s files: remove its rows via SQLite or delete
`reports/<sessionId>.json` + `video/<sessionId>-*` + `audio/<sessionId>-*`.
Delete everything: `docker compose down -v` (drops the volume) or
`rm -rf /tmp/opencode/gridsight`.

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `MODEL_API_KEY is not set` / `Spark misconfigured` | Set `MODEL_API_KEY` in `.env.local` (server-side only), restart. Sample mode needs no key. |
| `Only MP4/MOV are supported` | Convert to MP4/MOV first. |
| `Video exceeds 500MB` | Use a 1–3 min clip; shorter is better for the demo. |
| `No voice memo stored` / transcription skipped | Normal for video-only runs — transcription + tagging show “Skipped”. Stage audio to transcribe. |
| `Audio exceeds 10 minutes` | Trim the memo to ~10 min. |
| `Tracking stopped: time budget exceeded` | Partial results are preserved — retry the remaining prompts or continue to the report. |
| `Report failed` / `upstream_failed` | Live failure, never replaced by canned output. Check key, quota, network, then Retry report. |
| `ffmpeg` missing in health | Install `ffmpeg` + `ffprobe` on PATH (Docker image already includes them). |
| Workspace video blank after refresh | Re-select the same clip for playback only — tracking/report data is server-side and unaffected. |
| `Sample fixtures unavailable` | `fixtures/demo-session/*.json` missing — restore from git. |

## 6. Operator readiness (no secret values)

- `GET /api/health` must return `ok: true` (`ffmpeg: true`, `dbWritable: true`).
- Live inference requires `MODEL_API_KEY`; optional `SPARK_PROVIDER` (`meta` default,
  `baseten`, `modal`) plus that provider’s base URL / model / key — all server-side
  env, never `NEXT_PUBLIC_*`.
- `USE_CACHED=true` forces the truthful sample path (zero burn). It is a demo
  mode label, never a silent fallback when live inference fails.
- AI findings are inspection support, not certified engineering judgments; the
  report says so on screen and in print.
