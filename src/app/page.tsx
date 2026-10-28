"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  FileCheck,
  Mic,
  ScanLine,
  Tags,
  Upload,
  Zap,
} from "lucide-react";
import PipelineDiagram, { type PipelineDiagramStep } from "@/components/PipelineDiagram";
import UploadZone, { type UploadForm } from "@/components/UploadZone";
import PipelineProgress from "@/components/PipelineProgress";
import { stashVideoFile } from "@/lib/client-video";
import { ASR_MODEL, SAM_MODEL, SPARK_MODEL } from "@/lib/models";

const PIPELINE: PipelineDiagramStep[] = [
  { icon: Upload, name: "Drop footage", desc: "Drone MP4, straight from the flight." },
  { icon: ScanLine, name: "Track everything", desc: "SAM 3.1 multiplex holds every asset, every frame." },
  { icon: Mic, name: "Dictate notes", desc: "Talk on the drive back. Diarized, timestamped." },
  { icon: Tags, name: "Tag to assets", desc: "Each note pinned to the object it means." },
  { icon: FileCheck, name: "Ship the report", desc: "Severity-ranked, with actions. Not prose." },
];

const MODELS = [
  { id: SAM_MODEL, headline: "Eyes on every asset", sub: "Object Multiplex tracks 40+ grid assets simultaneously — one pass, ~7× the speed of solo tracking." },
  { id: ASR_MODEL, headline: "Ears on the drive back", sub: "Diarized transcription turns drive-back voice memos into timestamped evidence." },
  { id: SPARK_MODEL, headline: "Analyst on the record", sub: "Aligns notes to assets, then writes the severity-ranked defect report as structured JSON." },
];

export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [costOpen, setCostOpen] = useState(false);

  useEffect(() => {
    const els = Array.from(document.querySelectorAll(".gs-reveal"));
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("is-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const submit = async (form: UploadForm, upload: { sessionId: string }) => {
    setBusy(true);
    setError(null);
    try {
      stashVideoFile(upload.sessionId, form.video);
      router.push(
        `/inspection/${upload.sessionId}?prompts=${encodeURIComponent(form.prompts.join(","))}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setBusy(false);
    }
  };

  const openSample = async () => {
    setSampleBusy(true);
    setSampleError(null);
    try {
      const res = await fetch("/api/demo-session", { method: "POST" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.sessionId) {
        throw new Error(json?.error?.message ?? "Sample inspection unavailable.");
      }
      router.push(`/inspection/${json.sessionId}/report?sample=1`);
    } catch (err) {
      setSampleError(err instanceof Error ? err.message : "Sample inspection unavailable.");
      setSampleBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-ink text-slate-100">
      {/* Nav — hairline bottom, tighter tracking, amber wordmark */}
      <header className="sticky top-0 z-30 border-b border-line bg-ink/80 backdrop-blur supports-[backdrop-filter]:bg-ink/80">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3.5">
          <Zap className="h-5 w-5 text-amber-500" strokeWidth={2.5} />
          <span className="text-[15px] font-bold tracking-tight">GridSight</span>
          <span className="hidden rounded border border-line px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-steel sm:inline-flex">
            Field report · switchyard
          </span>
          <nav className="ml-6 hidden items-center gap-5 text-[13px] font-medium text-slate-400 md:flex">
            <a href="#how" className="hover:text-white">How it works</a>
            <a href="#models" className="hover:text-white">Models</a>
            <a href="#before" className="hover:text-white">Field view</a>
            <a href="/dashboard" className="hover:text-white">Dashboard</a>
          </nav>
          <a href="#start" className="btn-primary ml-auto !px-4 !py-2 text-[13px]">
            Start inspection
          </a>
        </div>
      </header>

      {/* Hero — poster headline, two-card intent split, illustrative still */}
      <section className="mx-auto max-w-6xl px-4 pb-10 pt-10 sm:pb-14 sm:pt-14 lg:pt-16">
        <div className="gs-reveal" style={{ animationDelay: "0ms" }}>
          <p className="eyebrow">Substation drone footage → defect report · 15 min pass</p>
          <h1
            className="mt-3 text-balance font-bold"
            style={{
              fontSize: "clamp(44px, 8.5vw, 102px)",
              lineHeight: 0.92,
              letterSpacing: "-0.03em",
            }}
          >
            Every defect,
            <br />
            <span className="text-steel">tagged.</span>
          </h1>
          <p className="prose-copy mt-4 max-w-[48ch] text-[17px] leading-relaxed text-slate-400">
            Upload a 1–3 min drone pass — no training data, no model prep — and get a severity-ranked defect report.
            Every visual claim cites its frame.
          </p>
          <div className="gs-reveal mt-7 grid max-w-[640px] gap-3 sm:grid-cols-2" style={{ animationDelay: "80ms" }}>
            {/* Primary path: sample — zero cost, zero key */}
            <div className="rounded-md border border-amber-500 bg-amber-500 p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-950/70">Try it with no upload</p>
              <p className="mt-1 text-[15px] font-bold leading-tight text-slate-950">Explore a sample inspection</p>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-900">
                Frozen fixtures — clearly marked SAMPLE/CACHED. No key, no cost, no upload.
              </p>
              <button
                onClick={openSample}
                disabled={sampleBusy}
                className="gs-ctl mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-2.5 text-[13px] font-bold text-white hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sampleBusy ? "Opening…" : "Open sample report"} <FileCheck className="h-4 w-4" />
              </button>
              {sampleError && (
                <p role="alert" className="mt-2 rounded bg-slate-950/10 px-2 py-1 text-xs font-semibold text-slate-950">{sampleError}</p>
              )}
            </div>
            {/* Secondary path: live */}
            <div className="rounded-md border border-line bg-panel p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-steel">Your own footage</p>
              <p className="mt-1 text-[15px] font-bold leading-tight text-slate-100">Start a live inspection</p>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
                MP4/MOV up to 500 MB · voice memo optional. Live inference uses your model provider.
              </p>
              <a href="#start" className="gs-ctl mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-slate-100 px-4 py-2.5 text-[13px] font-bold text-slate-950 hover:bg-white">
                Start live inspection <ArrowRight className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>
        <div className="gs-reveal mt-8" style={{ animationDelay: "160ms" }}>
          <figure className="panel overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: "var(--line)" }}>
              <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-300">
                <span className="inline-block h-2 w-2 rounded-full bg-red-500" style={{ animation: "gs-blink 1.6s infinite" }} />
                Illustrative field still
              </span>
              <span className="hidden text-[11px] font-semibold uppercase tracking-[0.12em] text-steel sm:inline">public/stills/yard-wide.jpg · not a live feed</span>
            </div>
            <img
              src="/stills/yard-wide.jpg"
              alt="Wide view of a substation yard with busbars and insulators"
              className="h-[48vh] min-h-[320px] w-full bg-ink object-cover sm:h-[52vh] sm:min-h-[380px]"
              loading="eager"
            />
            <figcaption className="border-t px-3 py-2 text-xs leading-relaxed text-slate-500" style={{ borderColor: "var(--line)" }}>
              Substation yard, wide view — sample imagery from <code>public/stills</code> (license unrecorded, do not redistribute). Illustrative sample imagery, not a live feed.
            </figcaption>
          </figure>
        </div>
        <p className="prose-copy mt-5 max-w-[56ch] border-t border-line pt-5 text-sm leading-relaxed text-slate-500">
          Manual climbs cover 10–20% of assets; a fifth of defects escape. GridSight watches the whole flight — every insulator, transformer, and connector, frame by frame.
        </p>
      </section>

      {/* Pipeline — schedule bar + legible legend */}
      <section id="how" className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="gs-reveal text-2xl font-bold tracking-tight sm:text-3xl" style={{ animationDelay: "0ms" }}>From footage to work order</h2>
            <p className="gs-reveal text-xs font-semibold uppercase tracking-[0.12em] text-steel" style={{ animationDelay: "60ms" }}>5 stages · tracking is the long pole</p>
          </div>
          <div className="gs-reveal mt-8" style={{ animationDelay: "80ms" }}>
            <PipelineDiagram steps={PIPELINE} />
          </div>
          <figure className="gs-reveal mt-4 overflow-hidden rounded-md border border-line" style={{ animationDelay: "120ms" }}>
            <img
              src="/stills/busbar.jpg"
              alt="Busbar hardware tracked across frames"
              className="h-36 w-full object-cover sm:h-44"
              loading="lazy"
            />
          </figure>
        </div>
      </section>

      {/* Models — one amber hero + two board rows */}
      <section id="models" className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
          <div className="max-w-2xl">
            <h2 className="gs-reveal text-2xl font-bold tracking-tight sm:text-3xl" style={{ animationDelay: "0ms" }}>Three Meta models, one closed loop</h2>
            <p className="gs-reveal prose-copy mt-3 text-sm leading-relaxed text-slate-400" style={{ animationDelay: "60ms" }}>
              Not one chatbot behind a toggle — each model does the job it was trained for, and the pipeline closes the loop from pixels to work order.
            </p>
          </div>
          <div className="gs-reveal mt-8 flex flex-col gap-1" style={{ animationDelay: "100ms" }}>
            <article className="overflow-hidden rounded-md border border-amber-500 bg-amber-500">
              <div className="flex flex-col sm:flex-row">
                <img
                  src="/stills/transformer.jpg"
                  alt="Transformer tracked in one pass"
                  className="h-44 w-full object-cover sm:h-auto sm:min-h-[220px] sm:w-[48%]"
                  loading="lazy"
                />
                <div className="min-w-0 flex-1 p-5 sm:p-6">
                  <p className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-slate-950/60">{MODELS[0].id}</p>
                  <h3 className="mt-1 text-xl font-bold tracking-tight text-slate-950">{MODELS[0].headline}</h3>
                  <p className="mt-2 text-[15px] leading-snug text-slate-950/90">
                    Object Multiplex tracks 40+ grid assets in one pass — frame-accurate, without per-asset prompts.
                  </p>
                  <p className="mt-3 inline-flex rounded-full bg-slate-950 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-white">Longest stage · ~7× vs solo tracking</p>
                </div>
              </div>
            </article>
            {MODELS.slice(1).map((m) => (
              <article key={m.id} className="board-row gap-4 px-5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h3 className="text-sm font-bold tracking-tight text-slate-100">{m.headline}</h3>
                    <span className="rounded border border-line bg-ink px-1.5 py-0.5 font-mono text-[11px] font-semibold text-steel">{m.id}</span>
                  </div>
                  <p className="mt-1 max-w-[62ch] text-sm leading-relaxed text-slate-400">{m.sub}</p>
                </div>
                <ArrowRight className="hidden h-4 w-4 shrink-0 text-steel sm:block" aria-hidden />
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Field view — pictures + honest comparison */}
      <section id="before" className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-10 sm:py-14 md:flex-row">
          <figure className="gs-reveal grid flex-1 grid-cols-2 gap-1" style={{ animationDelay: "0ms" }} aria-label="Field stills: insulator and hardware detail">
            <img src="/stills/insulator.jpg" alt="Insulator close-up from field stills" className="h-48 w-full rounded-md object-cover sm:h-56" loading="lazy" />
            <img src="/stills/detail.jpg" alt="Hardware detail from field stills" className="h-48 w-full rounded-md object-cover sm:h-56" loading="lazy" />
          </figure>
          <div className="gs-reveal flex flex-1 flex-col gap-1" style={{ animationDelay: "80ms" }}>
            <div className="rounded-md border border-line bg-panel p-5">
              <p className="eyebrow">Manual climb</p>
              <h3 className="mt-1 text-xl font-bold tracking-tight text-slate-100">6 hours, partial cover</h3>
              <p className="prose-copy mt-2 max-w-[42ch] text-sm leading-relaxed text-slate-400">
                Ladder and clipboard. ~20% eyeballed; notes become a report that sits unread.
              </p>
            </div>
            <div className="rounded-md border border-amber-500 bg-amber-500 p-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-900">GridSight pass</p>
              <h3 className="mt-1 text-xl font-bold tracking-tight text-slate-950">15 minutes, every frame</h3>
              <p className="mt-2 max-w-[42ch] text-sm leading-relaxed text-slate-900">
                Drone footage in, every visible asset tracked, voice notes pinned, defects ranked with evidence.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Start — UploadZone is the hero; cost disclosure is progressive */}
      <section id="start" className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="gs-reveal text-2xl font-bold tracking-tight sm:text-3xl" style={{ animationDelay: "0ms" }}>Start a new inspection</h2>
            <p className="gs-reveal text-xs font-medium text-slate-500" style={{ animationDelay: "60ms" }}>MP4/MOV · 500 MB max · 1–3 min clips demo best · voice memo optional</p>
          </div>
          <div className="gs-reveal mt-3 flex flex-wrap items-center gap-2" style={{ animationDelay: "80ms" }}>
            <span className="rounded-full border border-line bg-panel px-2.5 py-1 text-xs font-semibold text-slate-300">No training data</span>
            <span className="rounded-full border border-line bg-panel px-2.5 py-1 text-xs font-semibold text-slate-300">CSV + print</span>
            <span className="rounded-full border border-line bg-panel px-2.5 py-1 text-xs font-semibold text-slate-300">Zero hallucination default</span>
            <button type="button" onClick={() => setCostOpen((v) => !v)} aria-expanded={costOpen} className="ml-auto text-xs font-semibold text-amber-400 hover:underline">
              {costOpen ? "Hide" : "Show"} cost & privacy →
            </button>
          </div>
          {costOpen && (
            <div className="mt-3 rounded-md border border-line bg-panel px-3 py-3 text-xs leading-relaxed text-slate-400">
              <p className="text-xs font-bold text-slate-200">Before live inference</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                <li>Uploaded video (and optional audio) is sent to the configured model provider for tracking, transcription, and analysis. This can consume promotional credits or incur cost — exact cost depends on your provider plan.</li>
                <li>Never put secrets in the browser. API keys live server-side in <code>.env.local</code> only.</li>
                <li>Sample mode (<code>USE_CACHED=true</code> or “Open sample report”) runs zero inference and is clearly labelled as cached demo data.</li>
                <li>Artifacts live under the server scratch dir + SQLite (<code>GRIDSIGHT_TMP_DIR/gridsight.db</code>). See <code>docs/SETUP.md</code>.</li>
              </ul>
            </div>
          )}
          {uploadPct !== null && (
            <div className="mt-4">
              <PipelineProgress
                steps={[
                  { key: "upload", label: uploadPct >= 100 ? "UPLOAD" : `UPLOAD ${uploadPct}%`, status: uploadPct >= 100 ? "complete" : "running" },
                  { key: "track", label: "TRACK", status: "pending" },
                ]}
              />
            </div>
          )}
          <div className="gs-reveal mt-6" style={{ animationDelay: "120ms" }}>
            <UploadZone onSubmit={submit} busy={busy} error={error} onUploadProgress={setUploadPct} />
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-6">
          <span className="inline-flex items-center gap-2 text-sm font-bold tracking-tight"><Zap className="h-4 w-4 text-amber-500" /> GridSight</span>
          <span className="text-xs text-slate-500">Switchyard at night — review footage in a dark room. Built with SAM 3.1 · Spark · Voice transcribe.</span>
          <a href="/dashboard" className="ml-auto text-xs font-semibold text-amber-400 hover:underline">Dashboard →</a>
        </div>
      </footer>
    </main>
  );
}
