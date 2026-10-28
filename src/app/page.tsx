"use client";

import { useState } from "react";
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
import HeroFeed from "@/components/HeroFeed";
import DotGridBackdrop from "@/components/DotGridBackdrop";
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
  { id: SAM_MODEL, icon: ScanLine, headline: "Eyes on every asset", sub: "Object Multiplex tracks 40+ grid assets simultaneously — one pass, ~7× the speed of solo tracking." },
  { id: ASR_MODEL, icon: Mic, headline: "Ears on the drive back", sub: "Diarized transcription turns drive-back voice memos into timestamped evidence." },
  { id: SPARK_MODEL, icon: FileCheck, headline: "Analyst on the record", sub: "Aligns notes to assets, then writes the severity-ranked defect report as structured JSON." },
];

// Persuade surface: footage in, ranked defects out. No kickers, no metric cards,
// no gradient text — the viewport is the thesis.
export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);

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

  return (
    <main className="min-h-screen bg-ink text-slate-100">
      {/* Nav */}
      <header className="border-b" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-4">
          <Zap className="h-5 w-5 text-amber-500" strokeWidth={2.5} />
          <span className="text-lg font-bold tracking-tight">GridSight</span>
          <nav className="ml-8 hidden items-center gap-6 text-sm text-slate-400 md:flex">
            <a href="#how" className="transition-colors hover:text-white">How it works</a>
            <a href="#models" className="transition-colors hover:text-white">Models</a>
            <a href="#start" className="transition-colors hover:text-white">Open app</a>
            <a href="/dashboard" className="transition-colors hover:text-white">Dashboard</a>
          </nav>
          <a href="#start" className="btn-primary ml-auto !px-4 !py-2">
            Start inspection
          </a>
        </div>
      </header>

      {/* Hero */}
      <div className="relative">
        <DotGridBackdrop />
      <section className="relative z-10 mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-14 lg:grid-cols-2 lg:pt-20">
        <div style={{ animation: "gs-rise 0.9s cubic-bezier(0.16,1,0.3,1) both" }}>
          <h1 className="text-balance text-5xl font-bold leading-[1.04] tracking-tight sm:text-6xl">
            Every defect on the yard, tagged.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-400">
            Upload drone footage of any substation — no training data needed — and get a
            prioritized defect report in minutes, not hours.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="#start" className="btn-primary inline-flex items-center gap-2">
              Start inspection <ArrowRight className="h-4 w-4" />
            </a>
            <a href="#how" className="btn-ghost inline-flex items-center gap-2">
              See how it works
            </a>
          </div>
          <p className="mt-6 max-w-xl border-t pt-5 text-sm leading-relaxed text-slate-500" style={{ borderColor: "var(--line)" }}>
            Manual climbs cover 10–20% of assets, and a fifth of defects escape entirely.
            GridSight watches all of the footage — every insulator, transformer, and
            connector, frame by frame.
          </p>
        </div>
        <div style={{ animation: "gs-rise 0.9s cubic-bezier(0.16,1,0.3,1) 0.12s both" }}>
          <HeroFeed />
        </div>
      </section>
      </div>

      {/* Pipeline */}
      <section id="how" className="border-t" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="text-3xl font-bold tracking-tight">From footage to work order</h2>
          <div className="mt-10">
            <PipelineDiagram steps={PIPELINE} />
          </div>
        </div>
      </section>

      {/* Models */}
      <section id="models" className="border-t" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="text-3xl font-bold tracking-tight">Three Meta models, one closed loop</h2>
          <p className="mt-3 max-w-2xl text-slate-400">
            No wrappers around a single chatbot — each model does the job it was built for,
            and the pipeline closes the loop from pixels to work order.
          </p>
          <div className="mt-8 flex flex-col items-stretch gap-3 md:flex-row md:items-center">
            {MODELS.map((m, i) => (
              <div key={m.id} className="contents md:flex md:flex-1 md:items-center md:gap-3">
                <article className="panel flex-1 p-5">
                  <m.icon className="h-8 w-8 text-amber-500" strokeWidth={1.75} aria-hidden />
                  <h3 className="mt-3 text-lg font-bold tracking-tight text-slate-100">{m.headline}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-slate-400">{m.sub}</p>
                  <p className="mt-4 font-mono text-xs text-amber-400">{m.id}</p>
                </article>
                {i < MODELS.length - 1 && (
                  <ArrowRight className="mx-auto h-5 w-5 shrink-0 rotate-90 text-slate-600 md:rotate-0" aria-hidden />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Before / after — full-width timeline split */}
      <section className="border-t" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto flex max-w-6xl flex-col px-4 py-14 md:flex-row">
          <div className="flex-1 border border-red-900/60 bg-red-950/30 p-6 md:border-r-0">
            <h3 className="micro-label !text-red-400">The climb</h3>
            <p className="mt-3 text-3xl font-bold tracking-tight text-slate-100">6 hours · ~80% coverage · defects escape</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              A ladder, a clipboard, and a thermal camera. About 20% of components eyeballed;
              handwritten notes become a report nobody opens.
            </p>
          </div>
          <div className="flex-1 border border-amber-900/60 bg-amber-950/30 p-6">
            <h3 className="micro-label !text-amber-400">The GridSight pass</h3>
            <p className="mt-3 text-3xl font-bold tracking-tight text-slate-100">15 min · every frame · zero missed</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">
              Drone footage in, every visible asset tracked, voice notes pinned to the asset
              they describe, severity-ranked defects ready to assign.
            </p>
          </div>
        </div>
      </section>

      {/* Start */}
      <section id="start" className="border-t" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto max-w-3xl px-4 py-14">
          <h2 className="text-3xl font-bold tracking-tight">Run an inspection</h2>
          <p className="mt-2 text-sm text-slate-500">MP4/MOV up to 500MB · voice memo optional · 1–3 minute clips demo best</p>
          {uploadPct !== null && (
            <div className="mt-4">
              <PipelineProgress
                steps={[
                  {
                    key: "upload",
                    label: uploadPct >= 100 ? "UPLOAD" : `UPLOAD ${uploadPct}%`,
                    status: uploadPct >= 100 ? "complete" : "running",
                  },
                  { key: "track", label: "TRACK", status: "pending" },
                ]}
              />
            </div>
          )}
          <div className="mt-6">
            <UploadZone onSubmit={submit} busy={busy} error={error} onUploadProgress={setUploadPct} />
          </div>
        </div>
      </section>

      <footer className="border-t" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-6">
          <Zap className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-bold">GridSight</span>
          <span className="ml-auto font-mono text-xs text-slate-600">BUILT WITH SAM · SPARK · VOICE TRANSCRIBE</span>
        </div>
      </footer>
    </main>
  );
}
