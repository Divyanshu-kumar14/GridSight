"use client";

import { useEffect, useRef, useState, type JSX } from "react";
import { ChevronDown } from "lucide-react";

// Contract: collapsed-by-default reveal of the real stored report JSON.
// The text is typed from the `json` prop via a rAF loop (~3 chars/frame);
// nothing is generated or streamed — copy stays `RAW OUTPUT` only.
const CAP = 6000;

export default function RawJsonPanel({
  json,
  className = "",
}: {
  json: string;
  className?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const raf = useRef<number>(0);
  const pos = useRef(0);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
      cancelAnimationFrame(raf.current);
    };
  }, []);

  const target = json.slice(0, CAP);
  const overflowSuffix =
    json.length > CAP ? `\n… ${json.length - CAP} more bytes` : "";

  const startTyping = () => {
    cancelAnimationFrame(raf.current);
    pos.current = 0;
    setOpen(true);
    setDone(false);
    if (reducedMotion || target.length === 0) {
      setTyped(target);
      setDone(true);
      return;
    }
    const tick = () => {
      pos.current += 3;
      if (pos.current >= target.length) {
        setTyped(target);
        setDone(true);
        return;
      }
      setTyped(target.slice(0, pos.current));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  const handleToggle = () => {
    if (open) {
      cancelAnimationFrame(raf.current);
      pos.current = 0;
      setTyped("");
      setDone(false);
      setOpen(false);
      return;
    }
    startTyping();
  };

  return (
    <div className={`panel p-0 overflow-hidden ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="raw-json-pre"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Raw output
        </span>
        <span className="font-mono text-xs text-slate-500">
          {json.length} bytes
        </span>
        <ChevronDown
          className={`ml-auto h-4 w-4 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <>
          <pre
            id="raw-json-pre"
            aria-hidden="true"
            className="bg-ink p-4 font-mono text-xs leading-relaxed text-slate-300 whitespace-pre-wrap break-all max-h-[420px] overflow-auto"
          >
            {done ? `${typed}${overflowSuffix}` : typed}
            {!done && (
              <span
                className="inline-block w-[1px] h-4 bg-amber-500 align-middle"
                style={{ animation: "gs-blink 1s infinite" }}
              />
            )}
          </pre>
          <pre className="sr-only">{json}</pre>
        </>
      )}
    </div>
  );
}
