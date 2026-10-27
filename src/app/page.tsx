"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  FileCheck,
  Mic,
  ScanLine,
  Tags,
  Upload,
  X,
  Zap,
} from "lucide-react";
import TrackingViewport from "@/components/TrackingViewport";
import DotGridBackdrop from "@/components/DotGridBackdrop";
import PipelineDiagram, { type PipelineDiagramStep } from "@/components/PipelineDiagram";
import UploadZone, { type UploadForm } from "@/components/UploadZone";
import { stashVideoFile } from "@/lib/client-video";
import { ASR_MODEL, IMAGE_MODEL, SAM_MODEL, SPARK_MODEL } from "@/lib/models";

const PIPELINE: PipelineDiagramStep[] = [
  { icon: Upload, name: "Drop footage", desc: "Drone MP4, straight from the flight." },
  { icon: ScanLine, name: "Track everything", desc: "SAM 3.1 multiplex holds every asset, every frame." },
  { icon: Mic, name: "Dictate notes", desc: "Talk on the drive back. Diarized, timestamped." },
  { icon: Tags, name: "Tag to assets", desc: "Each note pinned to the object it means." },
  { icon: FileCheck, name: "Ship the report", desc: "Severity-ranked, with actions. Not prose." },
];

const MODELS = [
  { id: SAM_MODEL, role: "Eyes", desc: "Object Multiplex tracks 40+ grid assets simultaneously — one pass, ~7× the speed of solo tracking." },
  { id: ASR_MODEL, role: "Ears", desc: "Diarized transcription turns drive-back voice memos into timestamped evidence." },
  { id: SPARK_MODEL, role: "Analyst", desc: "Aligns notes to assets, then writes the severity-ranked defect report as structured JSON." },
  { id: IMAGE_MODEL, role: "Marker", desc: "Deterministic overlays pin each defect to its tracked box on the real key frame — no painted damage." },
  { id: "files-api", role: "Loader", desc: "Pre-uploads footage so every model call references one file_id." },
];

// Persuade surface: footage in, ranked defects out. No kickers, no metric cards,
// no gradient text — the viewport is the thesis.
export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (form: UploadForm) => {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("video", form.video);
      if (form.audio) fd.append("audio", form.audio);
      fd.append("substationName", form.substationName);
      fd.append("inspectorName", form.inspectorName);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error?.message ?? `Upload failed (${res.status}).`);
      }
      stashVideoFile(json.sessionId, form.video);
      router.push(
        `/inspection/${json.sessionId}?prompts=${encodeURIComponent(form.prompts.join(","))}`,
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
          <TrackingViewport />
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
          <h2 className="text-3xl font-bold tracking-tight">Five Meta models, one closed loop</h2>
          <p className="mt-3 max-w-2xl text-slate-400">
            No wrappers around a single chatbot — each model does the job it was built for,
            and the pipeline closes the loop from pixels to work order.
          </p>
          <dl className="mt-8 divide-y rounded-md border" style={{ borderColor: "var(--line)", ["--tw-divide-opacity" as string]: 1 }}>
            {MODELS.map((m) => (
              <div key={m.id} className="grid gap-1 px-4 py-4 sm:grid-cols-[220px_90px_1fr] sm:gap-4">
                <dt className="font-mono text-sm text-amber-400">{m.id}</dt>
                <dd className="micro-label">{m.role}</dd>
                <dd className="text-sm leading-relaxed text-slate-400">{m.desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Before / after */}
      <section className="border-t" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto grid max-w-6xl gap-4 px-4 py-14 md:grid-cols-2">
          <div className="panel p-6">
            <h3 className="text-lg font-bold text-slate-300">The climb</h3>
            <ul className="mt-4 space-y-3 text-sm text-slate-400">
              {[
                "6 hours on a ladder with a clipboard and a thermal camera",
                "About 20% of components eyeballed; the rest on hope",
                "Handwritten notes become a PDF nobody opens",
                "Outages cost $100K+ when the missed 80% fails",
              ].map((t) => (
                <li key={t} className="flex gap-2">
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-red-400" /> {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="panel border-amber-500/40 p-6">
            <h3 className="text-lg font-bold text-white">The GridSight pass</h3>
            <ul className="mt-4 space-y-3 text-sm text-slate-300">
              {[
                "12 minutes of drone footage, zero ladders",
                "Every visible asset tracked across every frame",
                "Voice notes pinned to the exact asset they describe",
                "Severity-ranked defects with actions, ready to assign",
              ].map((t) => (
                <li key={t} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-400" /> {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Start */}
      <section id="start" className="border-t" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto max-w-3xl px-4 py-14">
          <h2 className="text-3xl font-bold tracking-tight">Run an inspection</h2>
          <p className="mt-2 text-sm text-slate-500">MP4/MOV up to 500MB · voice memo optional · 1–3 minute clips demo best</p>
          <div className="mt-6">
            <UploadZone onSubmit={submit} busy={busy} error={error} />
          </div>
        </div>
      </section>

      <footer className="border-t" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-6">
          <Zap className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-bold">GridSight</span>
          <span className="ml-auto font-mono text-xs text-slate-600">BUILT WITH 5 META MODELS · ZERO TRAINING DATA</span>
        </div>
      </footer>
    </main>
  );
}
