"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import AssetList from "@/components/AssetList";
import PipelineProgress, { type PipeStep } from "@/components/PipelineProgress";
import Timeline from "@/components/Timeline";
import TranscriptPanel from "@/components/TranscriptPanel";
import VideoOverlayPlayer from "@/components/VideoOverlayPlayer";
import WorkspaceSplit from "@/components/WorkspaceSplit";
import { getVideoFile, stashVideoFile, videoObjectUrl } from "@/lib/client-video";
import { TIMEOUTS, fetchWithTimeout } from "@/lib/net";
import { haltNotice, loadPersistedTracking } from "@/lib/track-status";
import type { DefectReport, TaggedNote, TrackedObject, TranscriptSegment } from "@/lib/types";

// Native fps loads per-session (probed at upload); 30 until then.

// Workspace: playback + SSE tracking (POST /api/track) → overlays + assets + timeline.
// Normal: Start → progress → boxes. Empty: pre-track hint states. Invalid: unknown
// session / SSE error → inline alert with retry (never blank).
export default function InspectionPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const sessionId = params.id;
  const prompts = useMemo(
    () => (search.get("prompts") ?? "transmission tower").split(",").map((p) => p.trim()).filter(Boolean),
    [search],
  );

  const [src, setSrc] = useState<string | null>(null);
  const [objects, setObjects] = useState<TrackedObject[]>([]);
  const [tracking, setTracking] = useState<"idle" | "running" | "done" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [persistNotice, setPersistNotice] = useState<string | null>(null);
  const [seekTo, setSeekTo] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [transcribing, setTranscribing] = useState<"idle" | "running" | "done" | "error">("idle");
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [stagedAudio, setStagedAudio] = useState<File | null>(null);
  const [tagged, setTagged] = useState<Record<string, TaggedNote>>({});
  const [tagging, setTagging] = useState<"idle" | "running" | "done" | "error">("idle");
  const [tagError, setTagError] = useState<string | null>(null);
  const [tagFallback, setTagFallback] = useState(false);
  const [report, setReport] = useState<DefectReport | null>(null);
  const [reporting, setReporting] = useState<"idle" | "running" | "done" | "error">("idle");
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportFound, setReportFound] = useState(0);
  const [fps, setFps] = useState(30);

  const fetchThumbs = useCallback(
    async (objs: TrackedObject[]) => {
    if (objs.length === 0) return;
    try {
      const res = await fetch("/api/frames", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const json = await res.json().catch(() => null);
      const map: Record<string, string> = {};
      const list = (json?.thumbs ?? []) as { objectId: string; url: string }[];
      for (const t of list) map[t.objectId] = t.url;
      setThumbs(map);
    } catch {
      // Thumbnails are enhancement-only; the asset list works without them.
    }
    },
    [sessionId],
  );

  // Restore persisted tracking after a timeout, cancel, or page revisit so
  // saved partials are visible instead of leaving an empty workspace.
  // "refresh" also runs right after an abort/error to surface what survived.
  const refreshPersisted = useCallback(
    async (mode: "mount" | "abort" | "cancel" | "error"): Promise<void> => {
      const state = await loadPersistedTracking(sessionId);
      if (!state) return;
      if (state.objects.length > 0) {
        setObjects(state.objects);
        void fetchThumbs(state.objects);
      }
      if (mode === "error") return; // server message already shown in the error banner
      const note =
        haltNotice(state) ??
        (mode === "abort"
          ? state.objects.length > 0
            ? `Request ended on this page — recovered ${state.objects.length} saved object(s). The server run reports its own terminal status.`
            : "Request ended on this page before anything was saved."
          : null);
      if (note) setPersistNotice(note);
    },
    [sessionId, fetchThumbs],
  );

  useEffect(() => {
    setSrc(videoObjectUrl(sessionId));
    const t = Number(search.get("t"));
    if (Number.isFinite(t) && t >= 0) setSeekTo(t);
    // Native fps probed at upload — SAM frame indices are native-rate.
    fetch(`/api/sessions?sessionId=${encodeURIComponent(sessionId)}`)
      .then((res) => res.json().catch(() => null))
      .then((json) => {
        const f = Number(json?.session?.videoFps);
        if (Number.isFinite(f) && f > 0) setFps(f);
      })
      .catch(() => null);
    void refreshPersisted("mount");
  }, [sessionId, search, refreshPersisted]);

  const duration = useMemo(() => {
    let max = 0;
    for (const o of objects) {
      const last = o.frames[o.frames.length - 1];
      if (last) max = Math.max(max, last.timestamp);
    }
    return max;
  }, [objects]);

  const steps: PipeStep[] = [
    { key: "upload", label: "Upload", status: "complete" },
    {
      key: "track",
      label: tracking === "running" ? `Tracking ${progress}%` : "Tracking",
      status: tracking === "idle" ? "pending" : tracking === "running" ? "running" : tracking === "done" ? "complete" : "error",
      error: tracking === "error" ? (error ?? "failed") : undefined,
    },
    { key: "transcribe", label: "Transcribe", status: transcribing === "idle" ? "pending" : transcribing === "running" ? "running" : transcribing === "done" ? "complete" : "error",
      error: transcribing === "error" ? (transcribeError ?? "failed") : undefined },
    { key: "tag", label: tagging === "done" && tagFallback ? "Tag assets (fallback)" : "Tag assets",
      status: tagging === "idle" ? "pending" : tagging === "running" ? "running" : tagging === "done" ? "complete" : "error",
      error: tagging === "error" ? (tagError ?? "failed") : undefined },
    { key: "report", label: "Report",
      status: reporting === "idle" ? "pending" : reporting === "running" ? "running" : reporting === "done" ? "complete" : "error",
      error: reporting === "error" ? (reportError ?? "failed") : undefined },
  ];

  const [trackJobId, setTrackJobId] = useState<string | null>(null);
  const trackAbort = useRef<AbortController | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const startTracking = async () => {
    setTracking("running");
    setProgress(0);
    setError(null);
    setPersistNotice(null);
    setTrackJobId(null);
    const controller = new AbortController();
    trackAbort.current = controller;
    try {
      const res = await fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, prompts }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error?.message ?? `Track request failed (${res.status}).`);
      }
      const timeout = setTimeout(() => controller.abort(), TIMEOUTS.track);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const evt = JSON.parse(line.slice(5)) as { type: string; data?: unknown };
            const d = evt.data as Record<string, unknown>;
            if (evt.type === "started" && typeof d?.jobId === "string") {
              setTrackJobId(d.jobId as string);
            } else if (evt.type === "progress" && typeof d?.progress === "number") {
              setProgress(Math.min(99, Math.round(d.progress as number)));
            } else if (evt.type === "tracking_complete") {
              const objs = Array.isArray(d?.objects) ? (d.objects as TrackedObject[]) : [];
              setObjects(objs);
              setProgress(100);
              setTracking("done");
              void fetchThumbs(objs);
            } else if (evt.type === "cancelled") {
              setTracking("idle");
              // Server-confirmed cancel (the job row carries it too) — report
              // partials explicitly rather than a bare "cancelled".
              void refreshPersisted("cancel");
            } else if (evt.type === "error") {
              throw new Error(typeof d?.message === "string" ? d.message : "Tracking failed.");
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // Client-side abort only — do NOT call it a confirmed cancellation.
        // The server may still be winding down; show what actually persisted.
        setTracking("idle");
        setError(null);
        void refreshPersisted("abort");
      } else {
        setError(err instanceof Error ? err.message : "Tracking failed.");
        setTracking("error");
        void refreshPersisted("error");
      }
    } finally {
      trackAbort.current = null;
    }
  };

  const cancelTracking = async () => {
    trackAbort.current?.abort();
    if (trackJobId) {
      await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", jobId: trackJobId }),
      }).catch(() => null);
    }
  };

  const transcribe = async () => {
    setTranscribing("running");
    setTranscribeError(null);
    try {
      let res: Response;
      if (stagedAudio) {
        const fd = new FormData();
        fd.append("sessionId", sessionId);
        fd.append("audio", stagedAudio);
        res = await fetchWithTimeout("/api/transcribe", { method: "POST", body: fd }, TIMEOUTS.transcribe);
      } else {
        res = await fetchWithTimeout("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        }, TIMEOUTS.transcribe);
      }
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error?.message ?? `Transcribe failed (${res.status}).`);
      }
      setSegments(Array.isArray(json?.segments) ? json.segments : []);
      setTranscribing("done");
    } catch (err) {
      setTranscribeError(err instanceof Error ? err.message : "Transcription failed.");
      setTranscribing("error");
    }
  };

  const tagAssets = async () => {
    setTagging("running");
    setTagError(null);
    try {
      const res = await fetchWithTimeout("/api/tag-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }, TIMEOUTS.tag);
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error?.message ?? `Tagging failed (${res.status}).`);
      }
      const notes: TaggedNote[] = Array.isArray(json?.taggedNotes) ? json.taggedNotes : [];
      const map: Record<string, TaggedNote> = {};
      for (const n of notes) map[n.segmentId] = n;
      setTagged(map);
      setTagFallback(json?.fallback === true);
      setTagging("done");
    } catch (err) {
      setTagError(err instanceof Error ? err.message : "Tagging failed.");
      setTagging("error");
    }
  };

  const [reportJobId, setReportJobId] = useState<string | null>(null);
  const reportAbort = useRef<AbortController | null>(null);

  const generateReport = async () => {
    setReporting("running");
    setReportError(null);
    setReportFound(0);
    setReportJobId(null);
    const controller = new AbortController();
    reportAbort.current = controller;
    try {
      const res = await fetch("/api/generate-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error?.message ?? `Report failed (${res.status}).`);
      }
      const timeout = setTimeout(() => controller.abort(), TIMEOUTS.report);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const evt = JSON.parse(line.slice(5)) as { type: string; data?: unknown };
            const d = evt.data as Record<string, unknown>;
            if (evt.type === "report_started" && typeof d?.jobId === "string") {
              setReportJobId(d.jobId as string);
            } else if (evt.type === "defect_found") {
              setReportFound((n) => n + 1);
            } else if (evt.type === "report_complete") {
              setReport((d?.report as DefectReport) ?? null);
              setReporting("done");
            } else if (evt.type === "cancelled") {
              setReporting("idle");
              setReportError("Report cancelled.");
            } else if (evt.type === "error") {
              throw new Error(typeof d?.message === "string" ? d.message : "Report generation failed.");
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setReporting("idle");
        setReportError("Report cancelled.");
      } else {
        setReportError(err instanceof Error ? err.message : "Report generation failed.");
        setReporting("error");
      }
    } finally {
      reportAbort.current = null;
    }
  };

  const cancelReport = async () => {
    reportAbort.current?.abort();
    if (reportJobId) {
      await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", jobId: reportJobId }),
      }).catch(() => null);
    }
  };

  const seekToObject = (id: string) => {
    setSelectedId(id);
    const obj = objects.find((o) => o.id === id);
    const first = obj?.frames[0];
    if (first) setSeekTo(first.timestamp);
  };

  const highlightAsset = (assetId: string, atTime: number) => {
    setSelectedId(assetId);
    setSeekTo(atTime);
  };

  const editSegment = (id: string, text: string) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, text } : s)));
  };

  return (
    <main className="min-h-screen bg-ink text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <span className="micro-label">Inspection workspace</span>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Session {sessionId.slice(0, 8)}</h1>
        <p className="mt-1 font-mono text-xs text-slate-400">prompts: {prompts.join(", ")}</p>
        <div className="mt-3">
          <PipelineProgress steps={steps} />
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
            {error}{" "}
            <button onClick={startTracking} className="underline">Retry</button>
          </p>
        )}

        {persistNotice && (
          <p className="mt-3 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300">
            {persistNotice}
          </p>
        )}

        {!src && (
          <div className="mt-4 rounded-md border border-dashed border-slate-700 p-4 text-sm text-slate-300">
            Video file isn&apos;t in this tab&apos;s memory (e.g. after refresh). Re-select the
            same clip for playback — tracking data is unaffected.
            <label className="mt-2 inline-block cursor-pointer rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-500">
              Choose clip
              <input
                type="file"
                accept=".mp4,.mov,video/mp4,video/quicktime"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    stashVideoFile(sessionId, f);
                    setSrc(videoObjectUrl(sessionId));
                  }
                }}
              />
            </label>
            {getVideoFile(sessionId) === null && null}
          </div>
        )}

        <WorkspaceSplit
          left={
          <div>
            <VideoOverlayPlayer src={src} objects={objects} fps={fps} seekTo={seekTo} selectedId={selectedId} onTime={setCurrentTime} />
            <div className="mt-3">
              <Timeline objects={objects} duration={duration} currentTime={currentTime} onSeek={setSeekTo} />
            </div>
          </div>
          }
          right={
          <div className="space-y-3">
            <button
              onClick={startTracking}
              disabled={tracking === "running"}
              className="w-full rounded-md bg-amber-500 px-4 py-2.5 text-sm font-bold text-slate-950 transition-colors hover:bg-amber-400 disabled:opacity-40"
            >
              {tracking === "running" ? `Tracking… ${progress}%` : objects.length > 0 ? "Re-run Tracking" : "Start Tracking"}
            </button>
            {tracking === "running" && (
              <button
                onClick={cancelTracking}
                className="w-full rounded-md border border-line px-4 py-2 text-sm font-semibold text-slate-300 transition-colors hover:border-red-500 hover:text-red-300"
              >
                Cancel tracking
              </button>
            )}
            <AssetList objects={objects} selectedId={selectedId} thumbs={thumbs} onSelect={seekToObject} />
            <TranscriptPanel
              segments={segments}
              busy={transcribing === "running"}
              error={transcribeError}
              stagedName={stagedAudio ? stagedAudio.name : null}
              tagged={tagged}
              tagBusy={tagging === "running"}
              tagError={tagError}
              onAudioReady={setStagedAudio}
              onTranscribe={transcribe}
              onTag={tagAssets}
              onSeek={setSeekTo}
              onAssetClick={highlightAsset}
              onEditSegment={editSegment}
            />
            <div className="panel p-4">
              <div className="flex items-center gap-2">
                <span className="micro-label">Defect report</span>
                {report && (
                  <span className="font-mono text-xs text-slate-500">
                    C:{report.statistics.critical} H:{report.statistics.high} M:{report.statistics.medium} L:{report.statistics.low}
                  </span>
                )}
              </div>
              <button
                onClick={generateReport}
                disabled={reporting === "running" || objects.length === 0}
                className="mt-2 w-full rounded-md bg-amber-500 px-4 py-2 text-sm font-bold text-slate-950 transition-colors hover:bg-amber-400 disabled:opacity-40"
              >
                {reporting === "running" ? `Analyzing… ${reportFound} defects` : report ? "Regenerate Report" : "Generate Report"}
              </button>
              {reporting === "running" && (
                <button
                  onClick={cancelReport}
                  className="mt-2 w-full rounded-md border border-line px-4 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:border-red-500 hover:text-red-300"
                >
                  Cancel report
                </button>
              )}
              {reportError && <p role="alert" className="mt-2 text-xs text-red-400">{reportError}</p>}
              {report ? (
                <div className="mt-2">
                  <p className="text-xs text-slate-300">{report.summary}</p>
                  <ul className="mt-2 space-y-1">
                    {report.defects.slice(0, 5).map((d) => (
                      <li key={d.id}>
                        <button onClick={() => setSeekTo(d.frameTimestamp)} className="flex w-full items-center gap-2 rounded bg-ink px-2 py-1 text-left text-xs hover:bg-slate-800">
                          <SeverityBadge severity={d.severity} />
                          <span className="truncate text-slate-200">{d.title}</span>
                          <span className="ml-auto font-mono text-slate-500">[{fmtClock(d.frameTimestamp)}]</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {report.defects.length > 5 && (
                    <p className="mt-1 font-mono text-[10px] text-slate-500">+{report.defects.length - 5} more</p>
                  )}
                  <a href={`/inspection/${sessionId}/report`} className="mt-2 block text-xs text-amber-400 underline">
                    Open full report →
                  </a>
                </div>
              ) : (
                objects.length > 0 && (
                  <p className="mt-2 text-xs text-slate-500">The full report opens here after generation.</p>
                )
              )}
            </div>
          </div>
          }
        />
      </div>
    </main>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const color =
    severity === "CRITICAL" ? "bg-red-600" :
    severity === "HIGH" ? "bg-orange-500" :
    severity === "MEDIUM" ? "bg-yellow-500" : "bg-green-600";
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-950 ${color}`}>
      {severity}
    </span>
  );
}

function fmtClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
