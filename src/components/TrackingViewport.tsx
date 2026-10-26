"use client";

import { useEffect, useState } from "react";

// Synthetic tracking viewport for the landing hero — the mechanism dramatized.
// Labeled SAMPLE everywhere a visitor could mistake it for a live feed.
const BOXES = [
  { id: "insulator-003", color: "#f87171", x: "10%", y: "30%", w: "12%", h: "22%", anim: "gs-drift-a 7s ease-in-out infinite" },
  { id: "insulator-001", color: "#f5a524", x: "32%", y: "26%", w: "10%", h: "20%", anim: "gs-drift-b 9s ease-in-out infinite" },
  { id: "transformer-001", color: "#f5a524", x: "55%", y: "38%", w: "20%", h: "34%", anim: "gs-drift-a 11s ease-in-out infinite" },
  { id: "connector-002", color: "#4ade80", x: "80%", y: "24%", w: "8%", h: "14%", anim: "gs-drift-b 8s ease-in-out infinite" },
];

export default function TrackingViewport() {
  const [t, setT] = useState(12.4);
  useEffect(() => {
    const id = setInterval(() => setT((v) => (v >= 59.9 ? 0 : v + 0.1)), 100);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="panel overflow-hidden" aria-label="Sample tracking feed demonstration">
      <div className="flex items-center gap-2 border-b px-4 py-2" style={{ borderColor: "var(--line)" }}>
        <span className="inline-block h-2 w-2 rounded-full bg-red-500" style={{ animation: "gs-blink 1.6s infinite" }} />
        <span className="font-mono text-[11px] tracking-wider text-slate-400">SAMPLE FEED — EAST BUS 04</span>
        <span className="tabular ml-auto font-mono text-[11px] text-amber-400">
          {formatClock(t)} · F{Math.floor(t * 30)}
        </span>
      </div>
      <div
        className="relative h-64 overflow-hidden sm:h-80"
        style={{
          backgroundImage:
            "linear-gradient(rgba(148,163,184,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.07) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        }}
      >
        {/* Single-line yard sketch */}
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 400 260" fill="none" aria-hidden>
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
          <circle cx="20" cy="200" r="3" fill="#f5a524" />
          <circle cx="380" cy="200" r="3" fill="#f5a524" />
        </svg>
        {/* Scan sweep — the one authored motion */}
        <div
          className="pointer-events-none absolute left-0 h-10 w-full"
          style={{
            top: 0,
            animation: "gs-scan 5.5s cubic-bezier(0.4, 0, 0.2, 1) infinite",
            background: "linear-gradient(to bottom, transparent, rgba(245,165,36,0.13), transparent)",
          }}
        />
        {/* Tracked boxes */}
        {BOXES.map((b) => (
          <div
            key={b.id}
            className="absolute"
            style={{ left: b.x, top: b.y, width: b.w, height: b.h, animation: b.anim }}
          >
            <div className="h-full w-full border-2" style={{ borderColor: b.color }} />
            <span
              className="absolute -top-5 left-0 whitespace-nowrap px-1 font-mono text-[10px]"
              style={{ background: b.color, color: "#05070c" }}
            >
              {b.id}
            </span>
          </div>
        ))}
      </div>
      <div className="border-t px-4 py-2" style={{ borderColor: "var(--line)" }}>
        <p className="font-mono text-[10px] tracking-wider text-slate-500">
          SYNTHETIC DEMONSTRATION — 4 OBJECTS · MULTIPLEX ×7
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
