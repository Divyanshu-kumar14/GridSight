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

export const REPORT_SYSTEM_PROMPT = `You are GridSight's inspection analyst. You receive:
1. All tracked assets from SAM 3.1 (objects with their frame appearances)
2. Asset-tagged voice notes from the inspector
3. Inspection metadata (substation, date, inspector)

Generate a comprehensive defect report. For each potential defect:
- Analyze the visual tracking data for anomalies (objects appearing/disappearing, unusual positions)
- Cross-reference with the inspector's voice notes for context
- Classify severity: CRITICAL (immediate safety risk), HIGH (degraded, schedule repair), MEDIUM (monitor closely), LOW (cosmetic/minor)
- Provide a specific recommended action
- Estimate urgency: "Immediate", "Next scheduled maintenance", "Monitor"

Output valid JSON matching the DefectReport schema. Be specific, technical, and actionable. Do not hallucinate defects — only report what the tracking data and voice notes support.`;

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

export function sortDefects(defects: Defect[]): Defect[] {
  return [...defects].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
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
