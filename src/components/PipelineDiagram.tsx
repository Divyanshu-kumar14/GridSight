"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PipelineDiagramStep {
  name: string;
  desc: string;
  icon: LucideIcon;
}

interface PipelineDiagramProps {
  steps: PipelineDiagramStep[];
  className?: string;
}

// Contract: steps in, animated single-line bus out. SMIL-only motion (no rAF),
// pulses/halos render only after mount when reduced motion is off (no hydration
// mismatch), and all SVGs pause when hidden or off-screen.
const PULSE_R = 3;
const PULSE_FILL = "#f59e0b";
const PULSE_DUR = "2.4s";
const PULSE_STAGGER = 0.45;
const HALO_R = 9;

// Desktop bus geometry: viewBox is width-proportional so node centres computed
// as fractions of width land on the real DOM grid-column centres at any
// viewport (no absolute pixel x positioning).
const BUS_W = 1000;
const BUS_H = 40;
const BUS_Y = 20;

// Mobile connector geometry: fixed 1:1 scale, centred under the w-10 node
// circle so the line sits at x=20px.
const SPINE_W = 2;
const SPINE_H = 32;

export default function PipelineDiagram({ steps, className }: PipelineDiagramProps): JSX.Element {
  const raw = useId();
  const id = raw.replace(/:/g, "");
  const [motionOK, setMotionOK] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const desktopRef = useRef<SVGSVGElement | null>(null);
  const mobileRef = useRef<HTMLDivElement | null>(null);

  // Enable pulses only after mount and only when the user has no reduced-motion
  // preference. Initial false keeps SSR and first paint identical.
  useEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMotionOK(true);
    }
  }, []);

  // Pause SMIL when the tab is hidden or the diagram scrolls off-screen.
  useEffect(() => {
    const allSvgs = (): SVGSVGElement[] => {
      const list: SVGSVGElement[] = [];
      if (desktopRef.current) list.push(desktopRef.current);
      mobileRef.current?.querySelectorAll("svg").forEach((s) => list.push(s));
      return list;
    };
    const pause = () => allSvgs().forEach((s) => s.pauseAnimations());
    const unpause = () => allSvgs().forEach((s) => s.unpauseAnimations());
    const onVisibility = () => {
      if (document.hidden) pause();
      else unpause();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const root = rootRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) unpause();
          else pause();
        });
      },
      { threshold: 0.1 },
    );
    if (root) observer.observe(root);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
    };
  }, []);

  const count = steps.length;
  const edgeCount = Math.max(count - 1, 0);
  const edges = Array.from({ length: edgeCount }, (_, i) => i);
  // Node i sits at the centre of grid column i: (i + 0.5) / count of width.
  // For 5 steps this is exactly 10/30/50/70/90%.
  const busX = (i: number) => (count > 0 ? (i + 0.5) * (BUS_W / count) : 0);

  return (
    <div ref={rootRef} className={cn(className)}>
      {/* Desktop: horizontal bus, hairline at node vertical centre (top-5 = h-10 / 2). */}
      <div className="relative hidden md:block">
        <svg
          ref={desktopRef}
          className="absolute left-0 top-0 h-10 w-full overflow-visible"
          viewBox={`0 0 ${BUS_W} ${BUS_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {edges.map((i) => (
            <path
              key={`edge-${i}`}
              id={`${id}-edge-${i}`}
              d={`M ${busX(i)} ${BUS_Y} H ${busX(i + 1)}`}
              fill="none"
              stroke="var(--line)"
              strokeWidth={1}
            />
          ))}
          {motionOK &&
            edges.map((i) => (
              <circle key={`pulse-${i}`} r={PULSE_R} fill={PULSE_FILL}>
                <animateMotion dur={PULSE_DUR} begin={`${i * PULSE_STAGGER}s`} repeatCount="indefinite">
                  <mpath href={`#${id}-edge-${i}`} />
                </animateMotion>
              </circle>
            ))}
          {motionOK &&
            edges.map((i) => (
              <circle
                key={`halo-${i}`}
                cx={busX(i + 1)}
                cy={BUS_Y}
                r={0}
                fill="none"
                stroke={PULSE_FILL}
                strokeWidth={1}
                opacity={0}
              >
                <animate
                  attributeName="r"
                  values={`0;${HALO_R};0`}
                  dur={PULSE_DUR}
                  begin={`${i * PULSE_STAGGER}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="1;0"
                  dur={PULSE_DUR}
                  begin={`${i * PULSE_STAGGER}s`}
                  repeatCount="indefinite"
                />
              </circle>
            ))}
        </svg>
        <ol className="grid grid-cols-5 gap-4">
          {steps.map((s, i) => (
            <li key={s.name} className="relative">
              <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-amber-500 bg-ink font-mono text-xs font-bold text-amber-400">
                {i + 1}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <s.icon className="h-4 w-4 text-slate-300" aria-hidden="true" />
                <h3 className="text-sm font-bold">{s.name}</h3>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-slate-500">{s.desc}</p>
            </li>
          ))}
        </ol>
      </div>

      {/* Mobile: vertical stack, connector drops down the node centre (x=20px). */}
      <div ref={mobileRef} className="md:hidden">
        <ol>
          {steps.map((s, i) => (
            <li key={s.name} className="relative flex gap-4">
              <div className="flex flex-col items-center">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-amber-500 bg-ink font-mono text-xs font-bold text-amber-400">
                  {i + 1}
                </div>
                {i < count - 1 && (
                  <svg
                    width={SPINE_W}
                    height={SPINE_H}
                    viewBox={`0 0 ${SPINE_W} ${SPINE_H}`}
                    aria-hidden="true"
                    className="w-[2px] shrink-0 overflow-visible"
                  >
                    <path
                      id={`${id}-m-edge-${i}`}
                      d={`M1 0 V${SPINE_H}`}
                      fill="none"
                      stroke="var(--line)"
                      strokeWidth={1}
                    />
                    {motionOK && (
                      <circle r={PULSE_R} fill={PULSE_FILL}>
                        <animateMotion dur={PULSE_DUR} begin={`${i * PULSE_STAGGER}s`} repeatCount="indefinite">
                          <mpath href={`#${id}-m-edge-${i}`} />
                        </animateMotion>
                      </circle>
                    )}
                    {motionOK && (
                      <circle
                        cx={1}
                        cy={SPINE_H}
                        r={0}
                        fill="none"
                        stroke={PULSE_FILL}
                        strokeWidth={1}
                        opacity={0}
                      >
                        <animate
                          attributeName="r"
                          values={`0;${HALO_R};0`}
                          dur={PULSE_DUR}
                          begin={`${i * PULSE_STAGGER}s`}
                          repeatCount="indefinite"
                        />
                        <animate
                          attributeName="opacity"
                          values="1;0"
                          dur={PULSE_DUR}
                          begin={`${i * PULSE_STAGGER}s`}
                          repeatCount="indefinite"
                        />
                      </circle>
                    )}
                  </svg>
                )}
              </div>
              <div className={cn(i < count - 1 && "pb-8")}>
                <div className="flex items-center gap-2 pt-2">
                  <s.icon className="h-4 w-4 text-slate-300" aria-hidden="true" />
                  <h3 className="text-sm font-bold">{s.name}</h3>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-slate-500">{s.desc}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
