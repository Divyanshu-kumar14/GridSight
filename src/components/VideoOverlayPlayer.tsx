"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TrackedObject } from "@/lib/types";

// SAM 3.1 multiplex ceiling: 128 simultaneous objects on a single H100.
const MAX_BOXES_PER_FRAME = 128;

// Contract: HTML5 video + canvas bbox overlay synced by frame (frame = floor(t*fps)).
// Normal: boxes track playback. Empty (no objects): plain video + note.
// Invalid (no src): empty-state prompt. Perf: rAF loop runs only while playing;
// paused seeks redraw once (web-perf: no idle canvas work).
export default function VideoOverlayPlayer({
  src,
  objects,
  fps,
  seekTo,
  selectedId,
  onTime,
}: {
  src: string | null;
  objects: TrackedObject[];
  fps: number;
  seekTo: number | null;
  selectedId?: string | null;
  onTime?: (t: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [overlay, setOverlay] = useState(true);
  const [time, setTime] = useState(0);

  const safeFps = fps > 0 ? fps : 30;
  const index = useMemo(() => {
    const m = new Map<number, { id: string; color: string; bbox: TrackedObject["frames"][number]["bbox"] }[]>();
    for (const o of objects) {
      for (const f of o.frames) {
        const list = m.get(f.frameIndex) ?? [];
        list.push({ id: o.id, color: o.color, bbox: f.bbox });
        m.set(f.frameIndex, list);
      }
    }
    return m;
  }, [objects]);

  const draw = (frameIdx: number) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !overlay) return;
    const rect = video.getBoundingClientRect();
    if (canvas.width !== Math.max(1, Math.round(rect.width)) || canvas.height !== Math.max(1, Math.round(rect.height))) {
      canvas.width = Math.max(1, Math.round(rect.width));
      canvas.height = Math.max(1, Math.round(rect.height));
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const boxes = index.get(frameIdx) ?? [];
    ctx.lineWidth = 2;
    ctx.font = "12px monospace";
    // Cap: SAM multiplex claims 128 simultaneous objects; drawing more tanks
    // canvas frame rate, so extra boxes are skipped (count logged to console).
    const visible = boxes.slice(0, MAX_BOXES_PER_FRAME);
    if (boxes.length > MAX_BOXES_PER_FRAME) {
      console.warn(`overlay capped: ${boxes.length} boxes, drawing ${MAX_BOXES_PER_FRAME}`);
    }
    for (const b of visible) {
      const selected = selectedId !== undefined && b.id === selectedId;
      const x = b.bbox.x * canvas.width;
      const y = b.bbox.y * canvas.height;
      const w = b.bbox.w * canvas.width;
      const h = b.bbox.h * canvas.height;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = selected ? 4 : 2;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = b.color;
      ctx.fillText(b.id, x + 3, y + 13);
    }
  };

  // rAF loop only while playing; single draw on pause/seek.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    let running = false;
    const loop = () => {
      if (!running) return;
      const t = video.currentTime;
      setTime(t);
      onTime?.(t);
      draw(Math.floor(t * safeFps));
      raf = requestAnimationFrame(loop);
    };
    const onPlay = () => { running = true; raf = requestAnimationFrame(loop); };
    const onPause = () => { running = false; cancelAnimationFrame(raf); draw(Math.floor(video.currentTime * safeFps)); };
    const onSeek = () => {
      const t = video.currentTime;
      setTime(t);
      onTime?.(t);
      if (video.paused) draw(Math.floor(t * safeFps));
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeek);
    video.addEventListener("timeupdate", onSeek);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeek);
      video.removeEventListener("timeupdate", onSeek);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, index, overlay, safeFps, selectedId]);

  // External seek requests (asset click / timeline click).
  const lastSeek = useRef<number | null>(null);
  useEffect(() => {
    if (seekTo !== null && seekTo !== lastSeek.current && videoRef.current) {
      lastSeek.current = seekTo;
      videoRef.current.currentTime = seekTo;
    }
  }, [seekTo]);

  if (!src) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-slate-700 text-sm text-slate-400">
        No video loaded — upload a clip to preview tracking here.
      </div>
    );
  }

  const step = (frames: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, v.currentTime + frames / safeFps);
  };

  return (
    <div>
      <div className="relative overflow-hidden rounded-md border border-line bg-black">
        <video ref={videoRef} src={src} controls className="max-h-[480px] w-full" preload="metadata" />
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button onClick={() => step(-1)} className="rounded-md border border-line px-2 py-1 text-slate-300">−1f</button>
        <button onClick={() => step(1)} className="rounded-md border border-line px-2 py-1 text-slate-300">+1f</button>
        <label className="ml-2 flex items-center gap-1 text-slate-300">
          <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
          Overlay
        </label>
        <span className="ml-auto font-mono text-slate-400">
          t={time.toFixed(2)}s · f={Math.floor(time * safeFps)}
          {objects.length === 0 && " · no tracked objects yet"}
        </span>
      </div>
    </div>
  );
}
