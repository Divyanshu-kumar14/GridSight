import { z } from "zod";
import type {
  AssetReviewStatus,
  Defect,
  DefectReport,
  EvidenceCoverage,
  ReportStatistics,
  TaggedNote,
  TrackedObject,
} from "./types";

// Contract: defect report support.
// Normal: Spark JSON → validated → severity-sorted → stats recomputed → frames attached.
// Empty: zero defects → valid report with zero stats. Invalid: schema mismatch → throws.

export const REPORT_SYSTEM_PROMPT = `You are GridSight's inspection analyst. You receive ATTACHED KEY FRAMES FIRST — they are the visual ground truth, in order FRAME 0..N with timestamps. Inspection metadata follows the frames.

Coverage honesty: you receive only a SUBSET of frames (at most 8) covering a SUBSET of tracked assets. Never claim that all assets were visually checked. Only describe as visible what an attached frame concretely shows.

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
  voiceNoteExcerpt: z.string().optional(),
  recommendedAction: z.string().min(1),
  estimatedUrgency: z.enum(["Immediate", "Next scheduled", "Monitor"]),
  // Model-cited visual evidence (optional → old fixtures and envelope-tolerant
  // parsing keep working). evidenceSource/overlayBox/assetAssociation are
  // server-computed, but the schema tolerates them so stored reports and
  // fixtures round-trip intact. Models must not assert their own association.
  evidenceFrameIndex: z.number().int().min(0).optional(),
  observation: z.string().min(1).optional(),
  evidenceSource: z.enum(["visual", "voice"]).optional(),
  assetAssociation: z.enum(["confirmed", "unresolved"]).optional(),
  // Second-pass audit marker (server-applied via applyVerdict; optional so old
  // fixtures and stored reports still parse).
  verification: z
    .object({
      verdict: z.enum(["keep", "downgrade", "drop", "skipped"]),
      reason: z.string().min(1),
    })
    .optional(),
  // Human review (server-applied via report-review API; optional so old
  // reports still parse). Never overwrites model fields.
  humanReview: z
    .object({
      status: z.enum(["confirmed", "rejected", "needs-inspection"]),
      note: z.string().max(2000).optional(),
      correctedAssetId: z.string().min(1).max(120).optional(),
      correctedDescription: z.string().min(1).max(5000).optional(),
      correctedAction: z.string().min(1).max(2000).optional(),
      updatedAt: z.string().min(1),
    })
    .optional(),
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
  // Provenance (optional → existing fixtures and stored reports still parse).
  modelRun: z
    .object({
      provider: z.enum(["meta", "baseten", "modal"]),
      model: z.string().min(1),
    })
    .optional(),
  statistics: z.object({
    critical: z.number(),
    high: z.number(),
    medium: z.number(),
    low: z.number(),
    byCategory: z.record(z.string(), z.number()),
    verification: z
      .object({
        kept: z.number(),
        downgraded: z.number(),
        dropped: z.number(),
        skipped: z.number(),
      })
      .optional(),
  }),
  // Coverage transparency (server-computed; optional so legacy reports parse).
  evidenceCoverage: z
    .object({
      totalAssetsTracked: z.number().int().min(0),
      assetsRepresented: z.number().int().min(0),
      visualFindings: z.number().int().min(0),
      voiceOnlyFindings: z.number().int().min(0),
      verificationSkipped: z.number().int().min(0),
      assetsNotRepresented: z.number().int().min(0).optional(),
      verificationKept: z.number().int().min(0).optional(),
      verificationDowngraded: z.number().int().min(0).optional(),
      verificationDropped: z.number().int().min(0).optional(),
      unresolvedAssociations: z.number().int().min(0).optional(),
      needsReview: z.number().int().min(0).optional(),
    })
    .optional(),
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
// HONEST LABEL: "stable-track rate" — NOT the share of equipment visually
// inspected or proven defect-free. Tracking an asset across video does not
// mean every frame was reviewed for every defect. The report UI must label
// this as stable-track rate and show evidenceCoverage (assets actually
// represented in the selected key frames) alongside it.
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

// Attaches the deterministic overlay ONLY on an exact assetId hit with a valid
// bbox from that same asset's track (nearest valid observation to the defect
// timestamp). No category/position/name fallback: borrowing a sibling asset's
// box misplaces the defect. Unresolved associations preserve the finding with
// assetAssociation="unresolved" and no overlayBox. evidenceSource is untouched
// here — a frame can show damage even when the asset link is unconfirmed.
// Pure + offline.
export function isValidBbox(b: unknown): boolean {
  if (!b || typeof b !== "object") return false;
  const { x, y, w, h } = b as Record<string, unknown>;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number"
  )
    return false;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h))
    return false;
  if (x < 0 || x > 1 || y < 0 || y > 1 || w <= 0 || w > 1 || h <= 0 || h > 1) return false;
  if (x + w > 1 + 1e-6 || y + h > 1 + 1e-6) return false;
  return true;
}

function isValidTimestamp(t: unknown): t is number {
  return typeof t === "number" && Number.isFinite(t) && t >= 0;
}

export function attachOverlayBox(defects: Defect[], objects: TrackedObject[]): Defect[] {
  const byId = new Map<string, TrackedObject>();
  if (Array.isArray(objects)) {
    for (const o of objects) {
      if (o && typeof o.id === "string") byId.set(o.id, o);
    }
  }
  return defects.map((d) => {
    const obj = byId.get(d.assetId);
    const objFrames = obj?.frames;
    if (!obj || !Array.isArray(objFrames) || objFrames.length === 0) {
      const { overlayBox: _drop, ...rest } = d as Defect & { overlayBox?: unknown };
      void _drop;
      return { ...rest, assetAssociation: "unresolved" as const };
    }
    const valid = objFrames.filter(
      (f) => f && isValidTimestamp(f.timestamp) && isValidBbox(f.bbox),
    );
    if (valid.length === 0) {
      const { overlayBox: _drop, ...rest } = d as Defect & { overlayBox?: unknown };
      void _drop;
      return { ...rest, assetAssociation: "unresolved" as const };
    }
    const t = isValidTimestamp(d.frameTimestamp) ? d.frameTimestamp : valid[0].timestamp;
    let best = valid[0];
    for (const f of valid) {
      if (Math.abs(f.timestamp - t) < Math.abs(best.timestamp - t)) best = f;
    }
    return { ...d, overlayBox: { ...best.bbox }, assetAssociation: "confirmed" as const };
  });
}

// Key-frame picks (capped cost/latency guard). Algorithm:
//  1. Per object, keep only usable observations: finite ts >= 0 + valid bbox.
//     Objects with none contribute nothing (never an invalid frame).
//  2. For each tagged note with an EXACT matchedAssetId hit, target the note's
//     midpoint (else start) and pick the nearest usable observation of THAT
//     asset. The asset must actually be visible there — proximity alone is not
//     enough. Multiple notes on one asset may yield multiple candidates.
//  3. Assets with no note candidate contribute their median usable observation
//     (not first-seen: damage often appears later in a track).
//  4. Select under budget: mentioned candidates first (confidence desc), then
//     fill with farthest-point spread across the timeline so frames do not all
//     cluster at the start. Near-duplicates within KEY_FRAME_MIN_GAP_SEC merge.
//  5. Return timestamps sorted ascending: the route sends frames in this exact
//     order, so FRAME i === stamps[i] and evidenceFrameIndex stays mapped.
// Timestamps are raw tracking seconds (no fps requantization), so they stay
// consistent with extractFrame(t) which seeks in seconds.
export const MAX_KEY_FRAMES = 8;

// Minimum separation between selected key frames. Merges near-identical picks
// from overlapping notes/tracks while preserving materially different evidence.
export const KEY_FRAME_MIN_GAP_SEC = 0.5;

// Hard ceiling per encoded frame. extractFrame downscales to ~60–150KB; anything
// bigger means the filter did not apply, and shipping it would blow the request.
export const MAX_KEY_FRAME_BYTES = 400_000;

interface KeyCandidate {
  timestamp: number;
  priority: 0 | 1; // 0 = note-referenced, 1 = representative
  confidence: number;
}

export function pickKeyTimestamps(objects: TrackedObject[], tagged: TaggedNote[]): number[] {
  if (!Array.isArray(objects) || objects.length === 0) return [];
  const notes = Array.isArray(tagged) ? tagged : [];

  // Usable observations per asset.
  const usable = new Map<string, number[]>();
  for (const o of objects) {
    if (!o || typeof o.id !== "string" || !Array.isArray(o.frames)) continue;
    const ts = o.frames
      .filter((f) => f && isValidTimestamp(f.timestamp) && isValidBbox(f.bbox))
      .map((f) => f.timestamp as number)
      .sort((a, b) => a - b);
    if (ts.length > 0) usable.set(o.id, ts);
  }
  if (usable.size === 0) return [];

  const candidates: KeyCandidate[] = [];
  const hasNoteCandidate = new Set<string>();

  // Note-anchored candidates (exact ID only — never category fallback).
  for (const n of notes) {
    const id = (n as TaggedNote | null)?.matchedAssetId;
    if (typeof id !== "string" || id.length === 0) continue;
    const stamps = usable.get(id);
    if (!stamps) continue;
    const s = (n as TaggedNote).startTime;
    const e = (n as TaggedNote).endTime;
    let target: number | null = null;
    if (Number.isFinite(s) && Number.isFinite(e) && (s as number) >= 0 && (e as number) >= 0) {
      target = ((s as number) + (e as number)) / 2;
    } else if (Number.isFinite(s) && (s as number) >= 0) {
      target = s as number;
    } else {
      continue; // invalid note times → representative path covers the asset
    }
    let best = stamps[0];
    for (const t of stamps) {
      if (Math.abs(t - (target as number)) < Math.abs(best - (target as number))) best = t;
    }
    const conf =
      typeof (n as TaggedNote).matchConfidence === "number" &&
      Number.isFinite((n as TaggedNote).matchConfidence)
        ? ((n as TaggedNote).matchConfidence as number)
        : 0;
    candidates.push({ timestamp: best, priority: 0, confidence: conf });
    hasNoteCandidate.add(id);
  }

  // Representative median for assets with no note candidate.
  Array.from(usable.entries()).forEach(([id, stamps]) => {
    if (hasNoteCandidate.has(id)) return;
    candidates.push({
      timestamp: stamps[Math.floor(stamps.length / 2)],
      priority: 1,
      confidence: 0,
    });
  });

  const valid = candidates.filter((c) => isValidTimestamp(c.timestamp));
  if (valid.length === 0) return [];

  const withinGap = (ts: number, accepted: number[]): boolean =>
    accepted.some((a) => Math.abs(a - ts) < KEY_FRAME_MIN_GAP_SEC);

  // Mentioned first (confidence desc, then time asc for determinism), deduped.
  const mentioned = valid
    .filter((c) => c.priority === 0)
    .sort((a, b) => b.confidence - a.confidence || a.timestamp - b.timestamp);
  const accepted: number[] = [];
  for (const c of mentioned) {
    if (accepted.length >= MAX_KEY_FRAMES) break;
    if (withinGap(c.timestamp, accepted)) continue;
    accepted.push(c.timestamp);
  }

  // Fill remainder with timeline spread (farthest-point sampling).
  if (accepted.length < MAX_KEY_FRAMES) {
    let pool = valid
      .filter((c) => c.priority === 1 && !withinGap(c.timestamp, accepted))
      .map((c) => c.timestamp)
      .sort((a, b) => a - b);
    // Dedupe pool up-front within gap (keep earliest).
    const deduped: number[] = [];
    for (const t of pool) {
      if (!withinGap(t, deduped)) deduped.push(t);
    }
    pool = deduped;
    while (accepted.length < MAX_KEY_FRAMES && pool.length > 0) {
      let pickIdx = 0;
      if (accepted.length > 0) {
        let bestDist = -1;
        for (let i = 0; i < pool.length; i++) {
          let minD = Infinity;
          for (const a of accepted) minD = Math.min(minD, Math.abs(pool[i] - a));
          if (minD > bestDist) {
            bestDist = minD;
            pickIdx = i;
          }
        }
      } else {
        pickIdx = Math.floor(pool.length / 2);
      }
      const pick = pool.splice(pickIdx, 1)[0];
      accepted.push(pick);
      pool = pool.filter((t) => Math.abs(t - pick) >= KEY_FRAME_MIN_GAP_SEC);
    }
  }

  return accepted.sort((a, b) => a - b).slice(0, MAX_KEY_FRAMES);
}

// Server-computed coverage ledger from actual pipeline data (never model counts).
// frames: the exact ordered key frames sent to the model (post-extraction).
// Extended breakdown fields are always populated for new reports; older stored
// reports parse without them (optional) and the UI falls back with `?. ?? 0`.
export function computeEvidenceCoverage(
  objects: TrackedObject[],
  frames: KeyFrame[],
  defects: Defect[],
): EvidenceCoverage {
  const totalAssetsTracked = Array.isArray(objects) ? objects.length : 0;
  const stamps = Array.isArray(frames) ? frames.map((f) => f.timestamp) : [];
  let assetsRepresented = 0;
  if (Array.isArray(objects)) {
    for (const o of objects) {
      if (!o || !Array.isArray(o.frames)) continue;
      const hit = o.frames.some(
        (f) =>
          f &&
          isValidTimestamp(f.timestamp) &&
          isValidBbox(f.bbox) &&
          stamps.some((s) => Math.abs((f.timestamp as number) - s) < 1e-6),
      );
      if (hit) assetsRepresented++;
    }
  }
  const list = Array.isArray(defects) ? defects : [];
  const visualFindings = list.filter((d) => d?.evidenceSource === "visual").length;
  const verificationSkipped = list.filter(
    (d) => d?.evidenceSource === "visual" && (!d?.verification || d.verification.verdict === "skipped"),
  ).length;
  const verificationKept = list.filter((d) => d?.verification?.verdict === "keep").length;
  const verificationDowngraded = list.filter(
    (d) => d?.verification?.verdict === "downgrade",
  ).length;
  const verificationDropped = list.filter((d) => d?.verification?.verdict === "drop").length;
  const unresolvedAssociations = list.filter(
    (d) => d?.assetAssociation === "unresolved",
  ).length;
  const needsReview = list.filter(needsHumanReview).length;
  return {
    totalAssetsTracked,
    assetsRepresented,
    visualFindings,
    voiceOnlyFindings: list.length - visualFindings,
    verificationSkipped,
    assetsNotRepresented: Math.max(0, totalAssetsTracked - assetsRepresented),
    verificationKept,
    verificationDowngraded,
    verificationDropped,
    unresolvedAssociations,
    needsReview,
  };
}

// A finding needs human review when it is not yet confirmed/rejected by a
// reviewer AND carries residual uncertainty: unresolved asset link, skipped
// AI re-check, or a high-severity voice-only claim. Explicit
// "needs-inspection" human reviews always count until resolved.
export function needsHumanReview(d: Defect | null | undefined): boolean {
  if (!d || typeof d !== "object") return false;
  const hr = (d as Defect).humanReview;
  if (hr?.status === "confirmed" || hr?.status === "rejected") return false;
  if (hr?.status === "needs-inspection") return true;
  if ((d as Defect).assetAssociation === "unresolved") return true;
  const v = (d as Defect).verification?.verdict;
  if ((d as Defect).evidenceSource === "visual" && (!v || v === "skipped")) return true;
  if (
    (d as Defect).evidenceSource !== "visual" &&
    ((d as Defect).severity === "CRITICAL" || (d as Defect).severity === "HIGH")
  )
    return true;
  return false;
}

// Per-asset review status for the evidence table. Pure + offline.
export function computeAssetReview(
  objects: TrackedObject[],
  frames: KeyFrame[],
  defects: Defect[],
): AssetReviewStatus[] {
  const stamps = Array.isArray(frames) ? frames.map((f) => f.timestamp) : [];
  const list = Array.isArray(defects) ? defects : [];
  const byAsset = new Map<string, Defect[]>();
  for (const d of list) {
    if (!d || typeof d.assetId !== "string") continue;
    const arr = byAsset.get(d.assetId) ?? [];
    arr.push(d);
    byAsset.set(d.assetId, arr);
  }
  const out: AssetReviewStatus[] = [];
  if (!Array.isArray(objects)) return out;
  for (const o of objects) {
    if (!o || typeof o.id !== "string") continue;
    const obs = Array.isArray(o.frames) ? o.frames.length : 0;
    const represented = Array.isArray(o.frames)
      ? o.frames.some(
          (f) =>
            f &&
            isValidTimestamp(f.timestamp) &&
            isValidBbox(f.bbox) &&
            stamps.some((s) => Math.abs((f.timestamp as number) - s) < 1e-6),
        )
      : false;
    const findings = byAsset.get(o.id) ?? [];
    const hasUnresolved = findings.some((d) => d.assetAssociation === "unresolved");
    const hasSkipped = findings.some(
      (d) => d.evidenceSource === "visual" && (!d.verification || d.verification.verdict === "skipped"),
    );
    const needs = findings.some(needsHumanReview) || (!represented && findings.length > 0);
    const states: AssetReviewStatus["states"] = [];
    states.push(represented ? "Evidence represented" : "Not represented in selected evidence");
    if (findings.length > 0) {
      states.push(hasSkipped ? "Verification skipped" : "Verification complete");
    }
    if (hasUnresolved) states.push("Unresolved asset association");
    if (needs || findings.some((d) => d.humanReview?.status === "needs-inspection"))
      states.push("Needs human review");
    out.push({
      assetId: o.id,
      assetCategory: o.category ?? "unknown",
      observationCount: obs,
      representedInEvidence: represented,
      findingCount: findings.length,
      hasUnresolvedAssociation: hasUnresolved,
      hasSkippedVerification: hasSkipped,
      needsReview: needs,
      states,
    });
  }
  return out;
}
