// Contract: fetch with a hard timeout (PRD §15 — no hanging pipeline steps).
// Normal: resolves/rejects as upstream does. Timeout: rejects with Error("timed out after Nms").
// Invalid ms (≤0/NaN) → throws immediately (fail loudly, never silent no-timeout).

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  ms: number,
): Promise<Response> {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`fetchWithTimeout: invalid timeout ${String(ms)}.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${ms}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Route budgets (client side): track ≤ 5 min, transcribe/tag ≤ 2 min, report ≤ 3 min.
export const TIMEOUTS = {
  track: 5 * 60 * 1000,
  transcribe: 2 * 60 * 1000,
  tag: 2 * 60 * 1000,
  report: 3 * 60 * 1000,
} as const;
