import { readFile } from "node:fs/promises";
import type OpenAI from "openai";
import { extractFrame } from "./ffmpeg";
import { sortDefects, type KeyFrame } from "./report";
import { scratchDir } from "./store";
import type { Defect } from "./types";

// Contract: second-pass audit of the model's own visual claims (verifiable-agent
// loop, not a re-prompt). The model reviews each visual defect against a
// higher-resolution re-extraction of the CITED frame and returns keep/downgrade/
// drop. Every decision is recorded on the defect (verification) and surfaced via
// onVerdict/SSE — the action is auditable.
// Safety invariants (non-negotiable):
// - Voice-only defects are never verified (nothing visual asserted).
// - A defect is NEVER dropped on an error path: any failure → "skipped", retained.
// - Cancellation (checkCancel throwing) propagates — it is not converted to skipped.

export type Verdict = "keep" | "downgrade" | "drop";

export interface VerificationResult {
  verdict: Verdict;
  reason: string;
}

// What onVerdict reports (and what the route counts): a model verdict, or
// "skipped" when verification could not run. "skipped" is deliberately NOT a
// Verdict — skipped defects keep their evidence fields and are never dropped.
export interface AuditOutcome {
  verdict: Verdict | "skipped";
  reason: string;
}

export const VERIFY_SYSTEM_PROMPT = `You are GridSight's verification reviewer. You are shown ONE key frame and ONE claimed defect for an asset in a power substation.

Rules (no exceptions):
- Reply "keep" ONLY if the frame concretely shows the claimed damage described in the observation (visible corrosion, crack, deformation, leak, or staining — not a blur, not a shadow).
- Reply "downgrade" if damage is plausible (the asset looks aged, the view is unclear) but NOT concretely visible. The finding becomes a voice-only note.
- Reply "drop" if the frame contradicts the claim or shows a healthy asset.
- Output JSON only: {"verdict":"keep|downgrade|drop","reason":"..."} where reason is one sentence citing what is visible in the frame.`;

type UserPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export function buildVerificationUserParts(
  defect: Defect,
  frameBase64: string,
): UserPart[] {
  return [
    {
      type: "text",
      text: [
        `Asset category: ${defect.assetCategory}`,
        `Defect: ${defect.title}`,
        `Claimed observation: ${defect.observation ?? "(none given)"}`,
        `Frame timestamp: ${defect.frameTimestamp.toFixed(2)}s`,
        "Review the attached frame against the claim. Reply with JSON only.",
      ].join("\n"),
    },
    {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${frameBase64}` },
    },
  ];
}

// Tolerant reader: bare JSON, ```json fences, or prose-wrapped JSON.
// Anything unparseable or off-schema throws — the caller converts that to "skipped".
export function parseVerdict(raw: string): VerificationResult {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed) candidates.push(trimmed);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced?.[1]?.trim()) candidates.push(fenced[1].trim());
  const greedy = /\{[\s\S]*\}/.exec(raw);
  if (greedy?.[0]) candidates.push(greedy[0]);
  const braceRe = /\{[\s\S]*?\}/g;
  let m: RegExpExecArray | null;
  while ((m = braceRe.exec(raw)) !== null) candidates.push(m[0]);
  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const { verdict, reason } = parsed as Record<string, unknown>;
    if (
      (verdict === "keep" || verdict === "downgrade" || verdict === "drop") &&
      typeof reason === "string" &&
      reason.trim().length > 0
    ) {
      return { verdict, reason: reason.trim() };
    }
  }
  throw new Error("Unparseable verification verdict: no valid {verdict, reason} JSON found.");
}

// Server-side application of the model's audit decision.
// keep → annotate, leave evidence fields alone.
// downgrade → voice-only: strip visual claims, keep the finding.
// drop → null (caller removes it from the array).
export function applyVerdict(defect: Defect, v: VerificationResult): Defect | null {
  if (v.verdict === "drop") return null;
  if (v.verdict === "downgrade") {
    const d: Defect = { ...defect };
    delete d.observation;
    delete d.evidenceFrameIndex;
    delete d.frameCapture;
    d.evidenceSource = "voice";
    d.verification = { verdict: "downgrade", reason: v.reason };
    return d;
  }
  return { ...defect, verification: { verdict: "keep", reason: v.reason } };
}

export interface VerifyDefectsOpts {
  frames: KeyFrame[];
  videoPath: string | null;
  sessionId: string;
  client: OpenAI;
  model: string;
  onVerdict?: (defectId: string, v: AuditOutcome) => void;
  checkCancel?: () => void;
  cap?: number; // default 8 — never exceed 8 verification calls per report
}

const VERIFY_MAX_EDGE = 1024;

// Higher-resolution re-extraction of the CITED frame (not a re-pick: the exact
// frame the first pass cited). No video → reuse the stored key-frame bytes.
async function citedFrameBase64(
  defect: Defect,
  frames: KeyFrame[],
  videoPath: string | null,
  sessionId: string,
): Promise<string> {
  const i = defect.evidenceFrameIndex;
  const cited =
    typeof i === "number" && Number.isInteger(i) && i >= 0 && i < frames.length
      ? frames[i]
      : null;
  if (!cited) throw new Error("No cited frame available for verification.");
  if (!videoPath) return cited.base64;
  const safeId = defect.id.replace(/[^A-Za-z0-9-_]/g, "_").slice(0, 40) || "defect";
  const out = `${scratchDir()}/frames/${sessionId}-verify-${safeId}.jpg`;
  await extractFrame(videoPath, cited.timestamp, out, VERIFY_MAX_EDGE);
  return readFile(out, "base64");
}

export async function verifyDefects(
  defects: Defect[],
  opts: VerifyDefectsOpts,
): Promise<Defect[]> {
  const cap = opts.cap ?? 8;
  // Only visual claims are auditable — voice-only findings pass through untouched.
  // CRITICAL first (sortDefects is severity-ordered; all candidates are visual).
  const candidates = sortDefects(defects.filter((d) => d.evidenceSource === "visual")).slice(
    0,
    Math.max(0, cap),
  );
  if (candidates.length === 0) return [...defects];
  const decided = new Map<string, Defect | null>();
  for (const d of candidates) {
    // Outside try: cancellation must propagate, never become "skipped".
    opts.checkCancel?.();
    try {
      const b64 = await citedFrameBase64(d, opts.frames, opts.videoPath, opts.sessionId);
      const res = await opts.client.chat.completions.create({
        model: opts.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: VERIFY_SYSTEM_PROMPT },
          { role: "user", content: buildVerificationUserParts(d, b64) },
        ],
      });
      const text = res.choices[0]?.message?.content ?? "";
      const v = parseVerdict(text); // throws → skipped, never dropped
      decided.set(d.id, applyVerdict(d, v));
      opts.onVerdict?.(d.id, v);
    } catch (err) {
      // Fail safe: keep the defect, mark why. Never delete findings on errors.
      const reason = (
        err instanceof Error ? err.message : String(err)
      ).slice(0, 200);
      decided.set(d.id, { ...d, verification: { verdict: "skipped", reason } });
      opts.onVerdict?.(d.id, { verdict: "skipped", reason });
    }
  }
  const out: Defect[] = [];
  for (const d of defects) {
    if (!decided.has(d.id)) {
      out.push(d); // untouched: voice-only or beyond cap
      continue;
    }
    const applied = decided.get(d.id);
    if (applied) out.push(applied); // null = dropped by verdict
  }
  return out;
}
