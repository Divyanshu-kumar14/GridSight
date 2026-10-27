"use client";

import { useEffect, useState } from "react";

// Synthetic hero feed: substation sketch with severity-colored tracked boxes.
// Labeled SAMPLE everywhere a visitor could mistake it for a live feed.
const BOXES = [
  { id: "insulator-003", status: "CRITICAL", color: "#ef4444", x: "9%", y: "32%", w: "12%", h: "24%", anim: "gs-drift-a 7s ease-in-out infinite" },
  { id: "transformer-001", status: "HIGH", color: "#f97316", x: "55%", y: "38%", w: "20%", h: "34%", anim: "gs-drift-a 11s ease-in-out infinite" },
  { id: "insulator-001", status: "OK", color: "#22c55e", x: "32%", y: "27%", w: "10%", h: "21%", anim: "gs-drift-b 9s ease-in-out infinite" },
  { id: "connector-002", status: "OK", color: "#22c55e", x: "77%", y: "24%", w: "8%", h: "15%", anim: "gs-drift-b 8s ease-in-out infinite" },
  { id: "busbar-001", status: "OK", color: "#22c55e", x: "66%", y: "14%", w: "11%", h: "13%", anim: "gs-drift-a 10s ease-in-out infinite" },
] as const;

const FLAGGED = BOXES.filter((b) => b.status !== "OK").length;

export default function HeroFeed() {
  const [t, setT] = useState(12.4);
  const [flagged, setFlagged] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setT((v) => (v >= 59.9 ? 0 : v + 0.1)), 100);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setFlagged((v) => (v >= FLAGGED ? 1 : v + 1)), 1800);
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
      <div className="relative h-64 overflow-hidden bg-ink sm:h-80">
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
        {BOXES.map((b) => (
          <div key={b.id} className="absolute" style={{ left: b.x, top: b.y, width: b.w, height: b.h, animation: b.anim }}>
            <div className="h-full w-full border-2" style={{ borderColor: b.color }} />
            <span
              className="absolute -top-5 left-0 whitespace-nowrap px-1 font-mono text-[10px] font-bold"
              style={{ background: b.color, color: "#05070c" }}
            >
              {b.id} · {b.status}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t px-4 py-2" style={{ borderColor: "var(--line)" }}>
        <p className="font-mono text-[10px] tracking-wider text-slate-500">
          SYNTHETIC DEMONSTRATION — {BOXES.length} OBJECTS TRACKED
        </p>
        <p className="tabular ml-auto font-mono text-[10px] font-bold tracking-wider text-red-400" aria-live="polite">
          {flagged} ASSETS FLAGGED
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
