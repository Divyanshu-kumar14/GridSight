"use client";

import { useRef, useState } from "react";
import * as Progress from "@radix-ui/react-progress";
import { FileUp, Loader2, Mic } from "lucide-react";

// Contract: collects video + optional voice + metadata + asset prompts.
// Output: onSubmit({ video, audio, substationName, inspectorName, prompts }).
// Errors: submit disabled until video + ≥1 prompt; names optional ("Not provided").
// Shows real file feedback (name/size/duration/resolution) + format/size pre-checks.
export interface UploadForm {
  video: File;
  audio: File | null;
  substationName: string;
  inspectorName: string;
  prompts: string[];
}

export const DEFAULT_PROMPTS = ["insulator", "transformer", "busbar", "connector", "circuit breaker", "arrester"];

export const PRESET_CATEGORIES = [
  "insulator",
  "transformer",
  "busbar",
  "connector",
  "circuit breaker",
  "arrester",
] as const;

const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

async function probeVideo(file: File): Promise<{ duration: number | null; width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      const done = (out: { duration: number | null; width: number | null; height: number | null }) => {
        URL.revokeObjectURL(url);
        resolve(out);
      };
      v.onloadedmetadata = () =>
        done({
          duration: Number.isFinite(v.duration) ? v.duration : null,
          width: v.videoWidth || null,
          height: v.videoHeight || null,
        });
      v.onerror = () => done({ duration: null, width: null, height: null });
      v.src = url;
      setTimeout(() => done({ duration: null, width: null, height: null }), 8000);
    } catch {
      resolve({ duration: null, width: null, height: null });
    }
  });
}

export default function UploadZone({
  onSubmit,
  busy,
  error,
  onUploadProgress,
}: {
  onSubmit: (form: UploadForm, upload: { sessionId: string; videoFileId?: string }) => void;
  busy: boolean;
  error: string | null;
  onUploadProgress?: (pct: number) => void;
}) {
  const [video, setVideo] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [substation, setSubstation] = useState("");
  const [inspector, setInspector] = useState("");
  const [promptText, setPromptText] = useState(DEFAULT_PROMPTS.join(", "));
  const [selectedPresets, setSelectedPresets] = useState<string[]>([...DEFAULT_PROMPTS]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [videoMeta, setVideoMeta] = useState<{ duration: number | null; width: number | null; height: number | null } | null>(null);
  const [lowResWarn, setLowResWarn] = useState<string | null>(null);
  const videoInput = useRef<HTMLInputElement | null>(null);

  const prompts = promptText.split(",").map((p) => p.trim()).filter(Boolean);
  const videoProblem = !video
    ? null
    : video.size > MAX_VIDEO_BYTES
      ? `That video is ${fmtBytes(video.size)} — the limit is 500 MB. Try a shorter clip or lower resolution.`
      : !/\.mp4$|\.mov$/i.test(video.name) && video.type !== "video/mp4" && video.type !== "video/quicktime"
        ? "That file doesn't look like MP4 or MOV. Convert it first, or pick another clip."
        : null;
  const audioProblem = !audio
    ? null
    : audio.size > MAX_AUDIO_BYTES
      ? `That audio is ${fmtBytes(audio.size)} — keep voice memos under ~100 MB (about 10 minutes).`
      : null;
  const valid = video !== null && !videoProblem && !audioProblem && prompts.length > 0;
  const uploading = pct !== null;

  const onVideoFile = async (f: File | null) => {
    setLocalError(null);
    setLowResWarn(null);
    setVideoMeta(null);
    setVideo(f);
    if (!f) return;
    if (f.size > MAX_VIDEO_BYTES) return;
    const meta = await probeVideo(f);
    setVideoMeta(meta);
    // Measured low-resolution warning only — never a blocking error, never a blur claim.
    if (meta.width !== null && meta.height !== null && Math.min(meta.width, meta.height) < 480) {
      setLowResWarn(
        `Low resolution detected (${meta.width}×${meta.height}). Small defects may be harder to see — this is a warning, not a block.`,
      );
    }
  };

  const togglePreset = (cat: string) => {
    const next = selectedPresets.includes(cat)
      ? selectedPresets.filter((c) => c !== cat)
      : [...selectedPresets, cat];
    setSelectedPresets(next);
    // Keep custom text in sync unless the user opened Advanced and edited manually.
    if (!showAdvanced) setPromptText(next.join(", "));
    else {
      const custom = promptText.split(",").map((p) => p.trim()).filter(Boolean);
      const merged = Array.from(new Set([...custom.filter((c) => next.includes(c)), ...next.filter((c) => !custom.includes(c))]));
      void merged;
    }
  };

  const applyPresets = () => setPromptText(selectedPresets.join(", "));

  const startUpload = () => {
    if (!video || !valid || busy || uploading) return;
    if (videoProblem || audioProblem) {
      setLocalError(videoProblem ?? audioProblem);
      return;
    }
    const form: UploadForm = {
      video,
      audio,
      substationName: substation.trim() || "Not provided",
      inspectorName: inspector.trim() || "Not provided",
      prompts,
    };
    const fd = new FormData();
    fd.append("video", form.video);
    if (form.audio) fd.append("audio", form.audio);
    fd.append("substationName", form.substationName);
    fd.append("inspectorName", form.inspectorName);
    setLocalError(null);
    setPct(0);
    onUploadProgress?.(0);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const next = Math.min(100, Math.round((e.loaded / e.total) * 100));
        setPct(next);
        onUploadProgress?.(next);
      }
    };
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText ?? "{}") as { sessionId?: string; videoFileId?: string; message?: string };
        if (xhr.status < 200 || xhr.status >= 300 || !json.sessionId) {
          throw new Error(
            (json as { error?: { message?: string } }).error?.message ??
              json.message ??
              `Upload failed (${xhr.status}).`,
          );
        }
        setPct(100);
        onUploadProgress?.(100);
        onSubmit(form, { sessionId: json.sessionId, videoFileId: json.videoFileId });
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : "Upload failed.");
        setPct(null);
      }
    };
    xhr.onerror = () => {
      setLocalError("Upload failed (network error). Check your connection and retry.");
      setPct(null);
    };
    xhr.send(fd);
  };

  const drop = "rounded-md border px-4 py-6 text-center transition-colors cursor-pointer";
  const dropIdle = "border-dashed hover:border-amber-500/60 hover:bg-amber-500/[0.03]";
  const dropFull = "border-amber-500/50 bg-amber-500/[0.05]";

  return (
    <div className="panel p-6">
      <div className="grid gap-4 md:grid-cols-2">
        <label className={`${drop} ${video ? dropFull : dropIdle}`} style={{ borderColor: video ? undefined : "var(--line)" }}>
          <FileUp className="mx-auto h-6 w-6 text-amber-500" />
          <span className="mt-2 block text-sm font-semibold">Drone video · MP4/MOV · max 500 MB</span>
          <span className="mt-1 block font-mono text-xs text-slate-500">
            {video ? `${video.name} · ${fmtBytes(video.size)}` : "Drop a clip or click to browse"}
          </span>
          {videoMeta && video && (
            <span className="mt-1 block font-mono text-[11px] text-slate-400">
              {videoMeta.duration !== null ? `Duration ${fmtClock(videoMeta.duration)}` : "Duration unknown"} ·{" "}
              {videoMeta.width !== null ? `${videoMeta.width}×${videoMeta.height}` : "resolution unknown"}
            </span>
          )}
          <input
            ref={videoInput}
            type="file"
            accept=".mp4,.mov,video/mp4,video/quicktime"
            disabled={busy}
            onChange={(e) => void onVideoFile(e.target.files?.[0] ?? null)}
            className="hidden"
            aria-label="Drone video file (MP4 or MOV, up to 500 MB)"
          />
        </label>
        <label className={`${drop} ${audio ? dropFull : dropIdle}`} style={{ borderColor: audio ? undefined : "var(--line)" }}>
          <Mic className="mx-auto h-6 w-6 text-slate-400" />
          <span className="mt-2 block text-sm font-semibold">Voice memo · optional</span>
          <span className="mt-1 block font-mono text-xs text-slate-500">
            {audio ? `${audio.name} · ${fmtBytes(audio.size)}` : "WAV or MP3, up to ~10 min"}
          </span>
          <span className="mt-1 block text-[11px] text-slate-500">
            Dictate defects on the drive back — notes are timestamped and pinned to the asset visible when spoken. Skip this if you have no audio.
          </span>
          <input
            type="file"
            accept=".wav,.mp3,audio/*"
            disabled={busy}
            onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
            className="hidden"
            aria-label="Optional voice memo (audio file)"
          />
        </label>
        <label className="block">
          <span className="micro-label mb-1 block">Substation <span className="font-normal normal-case text-slate-500">(optional)</span></span>
          <input
            value={substation}
            disabled={busy}
            onChange={(e) => setSubstation(e.target.value)}
            placeholder="East Bus Substation (or leave blank)"
            className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
          />
        </label>
        <label className="block">
          <span className="micro-label mb-1 block">Inspector <span className="font-normal normal-case text-slate-500">(optional)</span></span>
          <input
            value={inspector}
            disabled={busy}
            onChange={(e) => setInspector(e.target.value)}
            placeholder="Your name (or leave blank)"
            className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
          />
        </label>
      </div>

      <div className="mt-4">
        <span className="micro-label mb-1 block">Equipment to track</span>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Equipment presets">
          {PRESET_CATEGORIES.map((cat) => {
            const on = selectedPresets.includes(cat);
            return (
              <button
                key={cat}
                type="button"
                disabled={busy}
                aria-pressed={on}
                onClick={() => {
                  togglePreset(cat);
                  if (!showAdvanced) {
                    const next = on ? selectedPresets.filter((c) => c !== cat) : [...selectedPresets, cat];
                    setPromptText(next.join(", "));
                  }
                }}
                className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                  on ? "border-amber-500 bg-amber-500/15 text-amber-300" : "border-line text-slate-400 hover:border-slate-500"
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-slate-500">Defaults cover common substation gear — good for a first run. Fewer categories = faster tracking.</p>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          className="mt-2 font-mono text-[11px] text-amber-400 hover:underline"
        >
          {showAdvanced ? "Hide advanced prompts" : "Advanced settings: custom prompts"}
        </button>
        {showAdvanced && (
          <div className="mt-2">
            <label className="block">
              <span className="micro-label mb-1 block">Custom asset prompts (comma-separated)</span>
              <input
                value={promptText}
                disabled={busy}
                onChange={(e) => setPromptText(e.target.value)}
                className="tabular w-full rounded-md border border-line bg-ink px-3 py-2 font-mono text-sm text-amber-300 placeholder:text-slate-600"
                aria-label="Custom asset prompts"
              />
            </label>
            <button type="button" onClick={applyPresets} disabled={busy} className="mt-1 font-mono text-[11px] text-slate-400 hover:text-slate-200 hover:underline">
              Reset to presets
            </button>
          </div>
        )}
      </div>

      {lowResWarn && (
        <p role="status" className="mt-3 rounded-md border border-amber-800 bg-amber-950/60 px-3 py-2 text-xs text-amber-200">
          {lowResWarn}
        </p>
      )}
      {(videoProblem ?? audioProblem) && (
        <p role="alert" className="mt-3 rounded-md border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
          {videoProblem ?? audioProblem}
        </p>
      )}
      {(error ?? localError) && (
        <p role="alert" className="mt-3 rounded-md border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
          {error ?? localError}
        </p>
      )}
      <button
        disabled={!valid || busy || uploading}
        onClick={startUpload}
        className="btn-primary mt-4 inline-flex items-center gap-2"
      >
        {(busy || uploading) && <Loader2 className="h-4 w-4 animate-spin" />}
        {uploading ? "Uploading…" : busy ? "Uploading…" : "Start Inspection"}
      </button>
      {uploading && pct !== null && (
        <div className="mt-3 space-y-1">
          <div className="flex justify-between font-mono text-[11px] text-slate-400">
            <span>Uploading…</span>
            <span>{pct}%</span>
          </div>
          <Progress.Root
            className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-800"
            value={pct}
          >
            <Progress.Indicator
              className="h-full bg-amber-500 transition-all duration-300 ease-out"
              style={{ transform: `translateX(-${100 - pct}%)` }}
            />
          </Progress.Root>
        </div>
      )}
      {!valid && <p className="mt-2 text-xs text-slate-600">Pick a video and at least one equipment type to begin. Names are optional.</p>}
    </div>
  );
}
