"use client";

import { useState } from "react";
import * as Progress from "@radix-ui/react-progress";
import { FileUp, Loader2, Mic } from "lucide-react";

// Contract: collects video + optional voice + metadata + asset prompts.
// Output: onSubmit({ video, audio, substationName, inspectorName, prompts }).
// Errors: submit disabled until video + names + ≥1 prompt; shows inline hints.
export interface UploadForm {
  video: File;
  audio: File | null;
  substationName: string;
  inspectorName: string;
  prompts: string[];
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
  const [promptText, setPromptText] = useState("insulator, transformer, busbar, connector, arrester");
  const [pct, setPct] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const prompts = promptText.split(",").map((p) => p.trim()).filter(Boolean);
  const valid = video !== null && substation.trim() !== "" && inspector.trim() !== "" && prompts.length > 0;
  const uploading = pct !== null;

  const startUpload = () => {
    if (!video || !valid || busy || uploading) return;
    const form: UploadForm = {
      video,
      audio,
      substationName: substation.trim(),
      inspectorName: inspector.trim(),
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
      setLocalError("Upload failed (network error).");
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
          <span className="mt-2 block text-sm font-semibold">Drone video · MP4/MOV · 500MB</span>
          <span className="mt-1 block font-mono text-xs text-slate-500">
            {video ? video.name : "Drop a clip or click to browse"}
          </span>
          <input
            type="file"
            accept=".mp4,.mov,video/mp4,video/quicktime"
            disabled={busy}
            onChange={(e) => setVideo(e.target.files?.[0] ?? null)}
            className="hidden"
          />
        </label>
        <label className={`${drop} ${audio ? dropFull : dropIdle}`} style={{ borderColor: audio ? undefined : "var(--line)" }}>
          <Mic className="mx-auto h-6 w-6 text-slate-400" />
          <span className="mt-2 block text-sm font-semibold">Voice memo · optional</span>
          <span className="mt-1 block font-mono text-xs text-slate-500">
            {audio ? audio.name : "WAV or MP3, up to 10 minutes"}
          </span>
          <input
            type="file"
            accept=".wav,.mp3,audio/*"
            disabled={busy}
            onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
            className="hidden"
          />
        </label>
        <label className="block">
          <span className="micro-label mb-1 block">Substation</span>
          <input
            value={substation}
            disabled={busy}
            onChange={(e) => setSubstation(e.target.value)}
            placeholder="East Bus Substation"
            className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
          />
        </label>
        <label className="block">
          <span className="micro-label mb-1 block">Inspector</span>
          <input
            value={inspector}
            disabled={busy}
            onChange={(e) => setInspector(e.target.value)}
            placeholder="Carlos Mendez"
            className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
          />
        </label>
      </div>
      <label className="mt-4 block">
        <span className="micro-label mb-1 block">Asset prompts</span>
        <input
          value={promptText}
          disabled={busy}
          onChange={(e) => setPromptText(e.target.value)}
          className="tabular w-full rounded-md border border-line bg-ink px-3 py-2 font-mono text-sm text-amber-300 placeholder:text-slate-600"
        />
        <p className="text-xs text-slate-500 mt-1">Fewer prompts = faster tracking. Combine categories where possible.</p>
      </label>
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
      {!valid && <p className="mt-2 text-xs text-slate-600">Video, names, and at least one prompt are required.</p>}
    </div>
  );
}
