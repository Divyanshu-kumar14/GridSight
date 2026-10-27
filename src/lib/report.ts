import { z } from "zod";
import type {
  Defect,
  DefectReport,
  ReportStatistics,
  TaggedNote,
  TrackedObject,
} from "./types";

// Contract: defect report support (PRD §7 Feature 3, Appendix A report prompt).
// Normal: Spark JSON → validated → severity-sorted → stats recomputed → frames attached.
// Empty: zero defects → valid report with zero stats. Invalid: schema mismatch → throws.

export const REPORT_SYSTEM_PROMPT = `You are GridSight's inspection analyst. You receive ATTACHED KEY FRAMES FIRST — they are the visual ground truth, in order FRAME 0..N with timestamps. Inspection metadata follows the frames.

For each defect, output the standard fields (id, assetId, assetCategory, severity, title, description, frameTimestamp, recommendedAction, estimatedUrgency, voiceNoteExcerpt when an inspector note supports it).
Evidence rules (no exceptions):
- If the claim is VISUAL (damage, corrosion, deformation, leak, crack seen in a frame): you MUST set observation (what is concretely visible, not inferred) AND evidenceFrameIndex (the index of the attached frame that shows it).
- Never describe anything as visible unless one of the attached frames supports it. Cite the exact frame.
- If no attached frame supports the claim (the inspector said it, or tracking merely suggests it): OMIT observation and evidenceFrameIndex. The server marks such findings voice-only.
- An empty defects array is correct when nothing is supported. Do not hallucinate defects.`;

const defectSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  assetCategory: z.string().min(1),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  title: z.string().min(1),
  description: z.string().min(1),
  frameTimestamp: z.number(),
  frameCapture: z.string().optional(),
  annotatedImage: z.string().optional(),
  voiceNoteExcerpt: z.string().optional(),
  recommendedAction: z.string().min(1),
  estimatedUrgency: z.enum(["Immediate", "Next scheduled", "Monitor"]),
  // Model-cited visual evidence (optional → old fixtures and envelope-tolerant
  // parsing keep working). evidenceSource/overlayBox are server-computed, but the
  // schema tolerates them so stored reports and fixtures round-trip intact.
  evidenceFrameIndex: z.number().int().min(0).optional(),
  observation: z.string().min(1).optional(),
  evidenceSource: z.enum(["visual", "voice"]).optional(),
  overlayBox: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .optional(),
});

const reportSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  inspection: z.object({
    substationId: z.string(),
    substationName: z.string(),
    date: z.string(),
    inspector: z.string(),
    totalAssetsTracked: z.number(),
    totalDefectsFound: z.number(),
    coveragePercent: z.number(),
  }),
  summary: z.string(),
  defects: z.array(defectSchema),
  statistics: z.object({
    critical: z.number(),
    high: z.number(),
    medium: z.number(),
    low: z.number(),
    byCategory: z.record(z.string(), z.number()),
  }),
  generatedAt: z.string(),
});

// Accepts a bare array or {defects:[...]} (models often skip the envelope).
// Throws on any invalid defect — fail loudly, never persist garbage.
export function validateDefects(raw: unknown): Defect[] {
  const list: unknown =
    Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { defects?: unknown }).defects)
      ? (raw as { defects: unknown }).defects
      : raw;
  const parsed = z.array(defectSchema).safeParse(list);
  if (!parsed.success) {
    throw new Error(`Invalid defects: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}

// Accepts bare {defects, summary, ...} or full report; fills server-side fields via opts.
export function validateReport(
  raw: unknown,
  opts: { id: string; sessionId: string },
): DefectReport {
  const parsed = reportSchema.safeParse(
    raw && typeof raw === "object" && "defects" in (raw as object) && !("inspection" in (raw as object))
      ? { ...((raw as Record<string, unknown>) ?? {}), ...opts }
      : raw,
  );
  if (!parsed.success) {
    throw new Error(`Invalid DefectReport: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}

// ============ Severity sort / stats ============

const SEVERITY_RANK: Record<Defect["severity"], number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

// Sort: severity first, visual evidence before voice-only within the same severity.
// Missing evidenceSource (pre-evidence reports) sorts as voice — honest fallback.
export function sortDefects(defects: Defect[]): Defect[] {
  return [...defects].sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return (a.evidenceSource === "visual" ? 0 : 1) - (b.evidenceSource === "visual" ? 0 : 1);
  });
}

export function rollupStats(defects: Defect[]): ReportStatistics {
  const stats: ReportStatistics = { critical: 0, high: 0, medium: 0, low: 0, byCategory: {} };
  for (const d of defects) {
    if (d.severity === "CRITICAL") stats.critical++;
    else if (d.severity === "HIGH") stats.high++;
    else if (d.severity === "MEDIUM") stats.medium++;
    else stats.low++;
    stats.byCategory[d.assetCategory] = (stats.byCategory[d.assetCategory] ?? 0) + 1;
  }
  return stats;
}

// Coverage = share of tracked objects with stable tracks (≥3 frames).
// Documented approximation: no ground-truth asset count exists in a zero-shot demo.
export function coveragePercent(objects: TrackedObject[]): number {
  if (objects.length === 0) return 0;
  const stable = objects.filter((o) => o.totalFrameCount >= 3).length;
  return Math.round((stable / objects.length) * 100);
}

// ============ Key-frame attach ============

export interface KeyFrame {
  timestamp: number;
  base64: string;
}

// Attaches the nearest key frame (by timestamp) to each defect lacking frameCapture.
// Normal: nearest found. Empty frames → defect untouched. Pure + offline.
export function attachFrameCaptures(defects: Defect[], frames: KeyFrame[]): Defect[] {
  if (frames.length === 0) return defects;
  return defects.map((d) => {
    if (d.frameCapture) return d;
    let best = frames[0];
    for (const f of frames) {
      if (Math.abs(f.timestamp - d.frameTimestamp) < Math.abs(best.timestamp - d.frameTimestamp)) {
        best = f;
      }
    }
    return { ...d, frameCapture: best.base64 };
  });
}

// Labels each defect's evidence source SERVER-SIDE — never trust the model for it.
// "visual" only when evidenceFrameIndex resolves to a real frame AND an observation
// is present; everything else is "voice". A visual defect's frameCapture is pinned
// to the cited frame so the UI shows the actual evidence, not a nearest guess.
export function labelEvidence(defects: Defect[], frames: KeyFrame[]): Defect[] {
  return defects.map((d) => {
    const i = d.evidenceFrameIndex;
    if (
      typeof i === "number" &&
      Number.isInteger(i) &&
      i >= 0 &&
      i < frames.length &&
      typeof d.observation === "string" &&
      d.observation.length > 0
    ) {
      return { ...d, evidenceSource: "visual" as const, frameCapture: frames[i].base64 };
    }
    return { ...d, evidenceSource: "voice" as const };
  });
}

// Attaches the deterministic overlay: the tracked bbox of the defect's asset at
// the frame nearest the defect timestamp. Pure + offline. No match → untouched.
export function attachOverlayBox(defects: Defect[], objects: TrackedObject[]): Defect[] {
  return defects.map((d) => {
    const obj =
      objects.find((o) => o.id === d.assetId) ??
      objects.find((o) => o.category === d.assetCategory);
    const objFrames = obj?.frames;
    if (!obj || !objFrames || objFrames.length === 0) return d;
    let best = objFrames[0];
    for (const f of objFrames) {
      if (Math.abs(f.timestamp - d.frameTimestamp) < Math.abs(best.timestamp - d.frameTimestamp)) {
        best = f;
      }
    }
    return { ...d, overlayBox: { ...best.bbox } };
  });
}

// Key-frame picks: first-seen timestamp per object, capped (cost/latency guard).
export const MAX_KEY_FRAMES = 8;

export function pickKeyTimestamps(objects: TrackedObject[], tagged: TaggedNote[]): number[] {
  const mentioned = new Set(tagged.map((t) => t.matchedAssetId).filter(Boolean) as string[]);
  const ranked = [...objects].sort((a, b) => {
    const am = mentioned.has(a.id) ? 0 : 1;
    const bm = mentioned.has(b.id) ? 0 : 1;
    return am - bm || a.firstSeenFrame - b.firstSeenFrame;
  });
  return ranked.slice(0, MAX_KEY_FRAMES).map((o) => o.frames[0]?.timestamp ?? 0);
}
