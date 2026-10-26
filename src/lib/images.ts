import type { Defect } from "./types";

// Contract: Muse Image annotated visuals (PRD §6.5).
// Normal: CRITICAL/HIGH with frameCapture → annotated (cap 5, severity-first).
// Empty: nothing annotatable → []. Invalid/single failure → that defect skipped,
// never fails the batch (report still completes).
// Pure selection + prompt are offline-testable; the network call is injected.

export const MAX_ANNOTATED = 5;

export function selectAnnotatable(defects: Defect[], cap: number = MAX_ANNOTATED): Defect[] {
  const rank = (s: Defect["severity"]) =>
    s === "CRITICAL" ? 0 : s === "HIGH" ? 1 : s === "MEDIUM" ? 2 : 3;
  return defects
    .filter((d) => (d.severity === "CRITICAL" || d.severity === "HIGH") && !!d.frameCapture)
    .sort((a, b) => rank(a.severity) - rank(b.severity))
    .slice(0, Math.max(0, cap));
}

export function buildAnnotationPrompt(d: Defect): string {
  return (
    `Add red severity overlay and annotation arrows pointing to the ${d.assetCategory} ` +
    `(${d.assetId}). Severity ${d.severity}: ${d.title}. ${d.description} ` +
    `Label the defect location clearly for a field inspection report.`
  ).slice(0, 900);
}

export function toDataUrl(b64: string, mime = "image/jpeg"): string {
  return `data:${mime};base64,${b64}`;
}

// editFn: (frameBase64, prompt) → annotated base64 or null on failure.
// Never throws for per-defect failures; collects successes only.
export async function annotateDefects(
  defects: Defect[],
  editFn: (frameBase64: string, prompt: string) => Promise<string | null>,
  cap: number = MAX_ANNOTATED,
): Promise<Defect[]> {
  const targets = selectAnnotatable(defects, cap);
  if (targets.length === 0) return defects;
  const annotated = new Map<string, string>();
  for (const d of targets) {
    try {
      const out = await editFn(d.frameCapture as string, buildAnnotationPrompt(d));
      if (out) annotated.set(d.id, out);
    } catch {
      // skip loudly at the call site (logged there); keep marching
    }
  }
  if (annotated.size === 0) return defects;
  return defects.map((d) => (annotated.has(d.id) ? { ...d, annotatedImage: annotated.get(d.id) } : d));
}
