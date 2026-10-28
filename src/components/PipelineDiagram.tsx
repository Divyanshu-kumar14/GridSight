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

const EFFORT = [12, 36, 12, 22, 18];
const TRACK_INDEX = 1;

export default function PipelineDiagram({ steps, className }: PipelineDiagramProps): JSX.Element {
  return (
    <div className={className}>
      <div className="flex gap-1" role="img" aria-label="Inspection pipeline by effort: tracking is the longest stage">
        {steps.map((s, i) => (
          <div
            key={s.name}
            title={`${s.name} — ${EFFORT[i] ?? 12}% of effort`}
            style={{ flexGrow: EFFORT[i] ?? 12, flexBasis: 0 }}
            className={cn(
              "flex h-[52px] min-w-0 items-center justify-center rounded-md border text-center",
              i === TRACK_INDEX
                ? "border-amber-500 bg-amber-500 text-slate-950"
                : "border-line bg-panel text-steel",
            )}
          >
            <span className="flex items-center gap-1.5 px-2 text-[13px] font-bold leading-none">
              <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[11px]", i === TRACK_INDEX ? "bg-slate-950 text-amber-400" : "border border-line bg-ink text-steel")}>{i + 1}</span>
              <span className="hidden lg:inline">{s.name}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Bar widths show true effort — tracking the full flight is the long pole. Tap a stage below for detail.
      </p>
      <ol className="mt-6 grid gap-4 sm:grid-cols-2 md:flex md:gap-3">
        {steps.map((s, i) => (
          <li
            key={s.name}
            className="min-w-0 rounded-md border border-line bg-panel px-3 py-3 md:flex-1"
            style={{ flexGrow: EFFORT[i] ?? 12, flexBasis: 0 }}
            aria-label={`Step ${i + 1} of ${steps.length}: ${s.name}`}
          >
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-amber-500 text-xs font-bold text-amber-400">
                {i + 1}
              </span>
              <s.icon className="h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />
              <h3 className="text-sm font-bold text-slate-100">{s.name}</h3>
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{s.desc}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
