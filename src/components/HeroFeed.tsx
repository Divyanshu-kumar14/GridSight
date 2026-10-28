"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

// Synthetic hero feed: substation sketch with severity-colored tracked boxes.
// Labeled SAMPLE everywhere a visitor could mistake it for a live feed.
const BOXES = [
  { id: "insulator-003", status: "CRITICAL", color: "#ef4444", x: "9%", y: "32%", w: "12%", h: "24%" },
  { id: "transformer-001", status: "HIGH", color: "#f97316", x: "55%", y: "38%", w: "20%", h: "34%" },
  { id: "insulator-001", status: "OK", color: "#22c55e", x: "32%", y: "27%", w: "10%", h: "21%" },
  { id: "connector-002", status: "OK", color: "#22c55e", x: "77%", y: "24%", w: "8%", h: "15%" },
  { id: "busbar-001", status: "OK", color: "#22c55e", x: "66%", y: "14%", w: "11%", h: "13%" },
] as const;

// Fixed confidence per box, counted up on first detection.
const CONFIDENCE: Record<string, number> = {
  "insulator-003": 97,
  "transformer-001": 89,
  "insulator-001": 94,
  "connector-002": 96,
  "busbar-001": 92,
};

// Corner-bracket reticle: four L-shaped corners, no full border.
function CornerBox({ color }: { color: string }) {
  const arm = "absolute h-3 w-3";
  const s = { borderColor: color };
  return (
    <>
      <span aria-hidden className={`${arm} left-0 top-0 border-l-2 border-t-2`} style={s} />
      <span aria-hidden className={`${arm} right-0 top-0 border-r-2 border-t-2`} style={s} />
      <span aria-hidden className={`${arm} bottom-0 left-0 border-b-2 border-l-2`} style={s} />
      <span aria-hidden className={`${arm} bottom-0 right-0 border-b-2 border-r-2`} style={s} />
    </>
  );
}

// Counts 0 → `to` over 600ms once mounted.
function Confidence({ to }: { to: number }) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min((now - start) / 600, 1);
      setVal(Math.round(p * to));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <span className="mt-0.5 block font-mono text-[10px] font-bold text-slate-200">{val}%</span>;
}

const FLAGGED = BOXES.filter((b) => b.status !== "OK").length;

export default function HeroFeed() {
  const [t, setT] = useState(12.4);
  const [flagged, setFlagged] = useState(1);
  // Boxes snap on as the 5.5s scan sweep crosses their vertical centre.
  const [detected, setDetected] = useState<Set<string>>(new Set());
  const prevT = useRef(t);
  useEffect(() => {
    const id = setInterval(() => setT((v) => (v >= 59.9 ? 0 : v + 0.1)), 100);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setFlagged((v) => (v >= FLAGGED ? 1 : v + 1)), 1800);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const sweepY = ((t % 5.5) / 5.5) * 100;
    const wrapped = t < prevT.current;
    prevT.current = t;
    setDetected((prev) => {
      let next: Set<string> | null = wrapped ? new Set() : null;
      for (const b of BOXES) {
        const centerY = parseFloat(b.y) + parseFloat(b.h) / 2;
        const base = next ?? prev;
        if (sweepY >= centerY && !base.has(b.id)) {
          if (!next) next = new Set(prev);
          next.add(b.id);
        }
      }
      return next ?? prev;
    });
  }, [t]);

  return (
    <div className="panel overflow-hidden" aria-label="Sample tracking feed demonstration">
      <div className="flex items-center gap-2 border-b px-4 py-2" style={{ borderColor: "var(--line)" }}>
        <span className="inline-block h-2 w-2 rounded-full bg-red-500" style={{ animation: "gs-blink 1.6s infinite" }} />
        <span className="font-mono text-[11px] tracking-wider text-slate-400">SAMPLE FEED — EAST BUS 04</span>
        <span className="tabular ml-auto font-mono text-[11px] text-amber-400">
          {formatClock(t)} · F{Math.floor(t * 30)}
        </span>
      </div>
      <motion.div
        className="relative h-64 overflow-hidden bg-ink sm:h-80"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6 }}
      >
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 400 260" fill="none" aria-hidden>
          {Array.from({ length: 15 }, (_, i) => (
            <path key={`v${i}`} d={`M${i * 28} 0 V260`} stroke="rgba(148,163,184,0.07)" strokeWidth="1" />
          ))}
          {Array.from({ length: 10 }, (_, i) => (
            <path key={`h${i}`} d={`M0 ${i * 28} H400`} stroke="rgba(148,163,184,0.07)" strokeWidth="1" />
          ))}
          <path d="M20 200 H380" stroke="#334155" strokeWidth="3" />
          <path d="M20 188 H380" stroke="#334155" strokeWidth="1.5" />
          {[70, 150, 240, 320].map((x) => (
            <g key={x} stroke="#475569" strokeWidth="1.5">
              <path d={`M${x} 188 V120`} />
              <path d={`M${x - 8} 130 H${x + 8} M${x - 8} 142 H${x + 8} M${x - 8} 154 H${x + 8}`} />
            </g>
          ))}
          <rect x="250" y="150" width="70" height="38" stroke="#475569" strokeWidth="1.5" />
          <path d="M250 162 H320 M250 176 H320" stroke="#334155" strokeWidth="1" />
          <circle cx="20" cy="200" r="3" fill="#f59e0b" />
          <circle cx="380" cy="200" r="3" fill="#f59e0b" />
        </svg>
        {/* Scan sweep (solid band, no gradient) */}
        <div
          className="pointer-events-none absolute left-0 h-10 w-full border-y border-amber-500/25 bg-amber-500/10"
          style={{ top: 0, animation: "gs-scan 5.5s cubic-bezier(0.4, 0, 0.2, 1) infinite" }}
        />
        {BOXES.map((b) => {
          const isDetected = detected.has(b.id);
          const isCritical = b.id === "insulator-003";
          return (
            <motion.div
              key={b.id}
              className="absolute"
              style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={isDetected ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.85 }}
              transition={{ type: "spring", stiffness: 400, damping: 20 }}
            >
              <CornerBox color={b.color} />
              {isCritical && isDetected && (
                <motion.div
                  aria-hidden
                  className="absolute rounded-sm border-2 border-red-500 inset-[-6px]"
                  animate={{ opacity: [0.6, 0, 0.6], scale: [1, 1.18, 1] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                />
              )}
              <span
                className="absolute -top-5 left-0 whitespace-nowrap px-1 font-mono text-[10px] font-bold"
                style={{ background: b.color, color: "#05070c" }}
              >
                {b.id} · {b.status}
              </span>
              {isDetected && <Confidence to={CONFIDENCE[b.id] ?? 93} />}
            </motion.div>
          );
        })}
      </motion.div>
      <div className="flex items-center gap-2 border-t px-4 py-2" style={{ borderColor: "var(--line)" }}>
        <p className="font-mono text-[10px] tracking-wider text-slate-500">
          SYNTHETIC DEMONSTRATION — {BOXES.length} OBJECTS TRACKED
        </p>
        <p className="tabular ml-auto font-mono text-[10px] font-bold tracking-wider text-red-400" aria-live="polite">
          <motion.span
            key={flagged}
            className="inline-block"
            initial={{ scale: 1.15, color: "#fc8181" }}
            animate={{ scale: 1, color: "#f87171" }}
            transition={{ duration: 0.3 }}
          >
            {flagged} ASSETS FLAGGED
          </motion.span>
        </p>
      </div>
    </div>
  );
}

function formatClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}.${Math.floor((t % 1) * 10)}`;
}
