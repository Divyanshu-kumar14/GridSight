"use client";

import { useRef, useState } from "react";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import { Mic, Pencil, Square } from "lucide-react";
import type { TaggedNote, TranscriptSegment } from "@/lib/types";

// Contract: voice capture + transcript display + asset tags.
// Capture: file drop or in-browser MediaRecorder → onAudioReady(File).
// List: speaker chip + clickable [mm:ss] → onSeek(startTime) + asset chip → onAssetClick.
// Empty → hint, never blank.
export default function TranscriptPanel({
  segments,
  busy,
  error,
  stagedName,
  tagged,
  tagBusy,
  tagError,
  onAudioReady,
  onTranscribe,
  onTag,
  onSeek,
  onAssetClick,
  onEditSegment,
}: {
  segments: TranscriptSegment[];
  busy: boolean;
  error: string | null;
  stagedName: string | null;
  tagged: Record<string, TaggedNote>;
  tagBusy: boolean;
  tagError: string | null;
  onAudioReady: (file: File) => void;
  onTranscribe: () => void;
  onTag: () => void;
  onSeek: (t: number) => void;
  onAssetClick: (assetId: string, atTime: number) => void;
  onEditSegment: (id: string, text: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = async () => {
    setRecError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        if (blob.size > 0) onAudioReady(new File([blob], "record.webm", { type: blob.type }));
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setRecError("Microphone unavailable — check permission or upload a file instead.");
    }
  };

  const stopRecording = () => {
    recRef.current?.stop();
    setRecording(false);
  };

  return (
    <div className="panel p-4">
      <span className="micro-label">Voice notes</span>
      <span className="ml-2 font-mono text-xs text-slate-500">
        {segments.length > 0 ? `${segments.length} segments` : " transcript appears here"}
      </span>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-md border border-line px-2 py-1 text-xs text-slate-300 transition-colors hover:border-slate-500">
          {stagedName ?? "Choose audio"}
          <input
            type="file"
            accept=".wav,.mp3,.m4a,.ogg,.webm,audio/*"
            className="hidden"
            disabled={busy || recording}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onAudioReady(f);
            }}
          />
        </label>
        {recording ? (
          <button onClick={stopRecording} className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-xs font-bold text-white">
            <Square className="h-3 w-3" aria-hidden /> Stop (REC)
          </button>
        ) : (
          <button
            onClick={startRecording}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-40"
          >
            <Mic className="h-3 w-3" aria-hidden /> Record
          </button>
        )}
        <button
          onClick={onTranscribe}
          disabled={busy}
          className="rounded bg-amber-500 px-3 py-1 text-xs font-bold text-slate-950 disabled:opacity-40"
        >
          {busy ? "Transcribing…" : "Transcribe"}
        </button>
      </div>
      {recError && <p role="alert" className="mt-2 text-xs text-red-400">{recError}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}

      {segments.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={onTag}
            disabled={tagBusy || busy}
            className="rounded bg-slate-700 px-3 py-1 text-xs font-bold text-slate-100 disabled:opacity-40"
          >
            {tagBusy ? "Tagging…" : "Auto-Tag Assets"}
          </button>
          {Object.keys(tagged).length > 0 && (
            <span className="font-mono text-[10px] text-slate-500">
              {Object.values(tagged).filter((t) => t.matchedAssetId).length}/{segments.length} matched
            </span>
          )}
        </div>
      )}
      {tagError && <p role="alert" className="mt-2 text-xs text-red-400">{tagError}</p>}

      <ScrollArea.Root className="mt-3 h-64">
        <ScrollArea.Viewport className="h-full w-full">
          <ul className="space-y-2 pr-3">
        {segments.length === 0 && (
          <li className="text-xs text-slate-500">
            No transcript yet — stage audio, then Transcribe. Clicking a timestamp seeks the video.
          </li>
        )}
        {segments.map((s) => (
          <li key={s.id} className="rounded-md border border-line bg-ink p-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                {s.speaker}
              </span>
              <button onClick={() => onSeek(s.startTime)} className="font-mono text-amber-400 hover:underline">
                [{fmt(s.startTime)}]
              </button>
              <span className="font-mono text-slate-600">→ {fmt(s.endTime)}</span>
              {tagged[s.id] ? (
                tagged[s.id].matchedAssetId ? (
                  <button
                    onClick={() => onAssetClick(tagged[s.id].matchedAssetId as string, s.startTime)}
                    title={tagged[s.id].matchReason}
                    className="rounded bg-amber-950 px-1.5 py-0.5 font-mono text-[10px] text-amber-300 hover:underline"
                  >
                    {tagged[s.id].matchedAssetId} · {tagged[s.id].matchConfidence.toFixed(2)}
                  </button>
                ) : (
                  <span title={tagged[s.id].matchReason} className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                    unmatched
                  </span>
                )
              ) : null}
            </div>
            <p className="mt-1 text-slate-200">
              {editingId === s.id ? (
                <span className="block">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={2}
                    aria-label="Correct transcript text"
                    className="w-full rounded-md border border-line bg-ink px-2 py-1 text-xs text-slate-200"
                  />
                  <span className="mt-1 flex gap-2">
                    <button
                      onClick={() => {
                        if (draft.trim()) onEditSegment(s.id, draft.trim());
                        setEditingId(null);
                      }}
                      className="rounded bg-slate-700 px-2 py-0.5 text-[11px] text-slate-100"
                    >
                      Save
                    </button>
                    <button onClick={() => setEditingId(null)} className="text-[11px] text-slate-400 underline">
                      Cancel
                    </button>
                  </span>
                </span>
              ) : (
                <>
                  {s.text}{" "}
                  <button
                    onClick={() => {
                      setEditingId(s.id);
                      setDraft(s.text);
                    }}
                    title="Correct transcript (demo fix, client-side only)"
                    className="text-slate-500 hover:text-slate-200"
                  >
                    <Pencil className="inline h-3 w-3" aria-hidden />
                  </button>
                </>
              )}
            </p>
          </li>
        ))}
          </ul>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar
          className="flex w-1.5 touch-none select-none p-0.5"
          orientation="vertical"
        >
          <ScrollArea.Thumb
            className="relative flex-1 rounded-full bg-slate-700 hover:bg-slate-500 transition-colors"
          />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </div>
  );
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
