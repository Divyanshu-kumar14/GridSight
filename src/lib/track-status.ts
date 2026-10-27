// Helpers for restoring persisted tracking after a timeout, cancel, or page
// revisit. Pure + testable: the page supplies fetch, this module shapes the
// result into objects plus an honest human-readable status line.
// Never claims cancellation: only a server-confirmed cancel reports it.
import type { TrackedObject } from "./types";

export interface PersistedTrackJob {
  status: string;
  error: string | null;
  progress: number;
  total: number;
}

export interface PersistedTrackState {
  objects: TrackedObject[];
  job: PersistedTrackJob | null;
}

type FetchLike = (input: string) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

/** Load persisted tracking objects + latest track job for a session. Null when unreachable. */
export async function loadPersistedTracking(
  sessionId: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<PersistedTrackState | null> {
  let json: unknown;
  try {
    const res = await fetchImpl(`/api/sessions?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    json = await res.json().catch(() => null);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const rec = json as Record<string, unknown>;
  const objects = Array.isArray(rec.tracking) ? (rec.tracking as TrackedObject[]) : [];
  const jobRaw = rec.trackJob;
  const job =
    jobRaw !== null && typeof jobRaw === "object"
      ? {
          status: String((jobRaw as Record<string, unknown>).status ?? ""),
          error: ((jobRaw as Record<string, unknown>).error as string | null) ?? null,
          progress: Number((jobRaw as Record<string, unknown>).progress ?? 0),
          total: Number((jobRaw as Record<string, unknown>).total ?? 0),
        }
      : null;
  return { objects, job };
}

/**
 * Human-readable status for a halted or restored run. Returns null when there
 * is nothing worth saying (fresh session, or completed run already shown).
 * Never reports a client-side abort as a confirmed cancellation.
 */
export function haltNotice(state: PersistedTrackState | null): string | null {
  if (!state) return null;
  const n = state.objects.length;
  const kept = n === 1 ? "1 saved object" : `${n} saved objects`;
  const job = state.job;
  if (!job) return n > 0 ? `Restored ${kept} from the saved run.` : null;
  if (job.status === "cancelled") {
    return n > 0
      ? `Tracking cancelled — ${kept} kept.`
      : "Tracking cancelled before any objects were saved.";
  }
  if (job.status === "complete") return null;
  const err = job.error ?? "";
  if (/time budget exceeded|track_timeout/i.test(err)) {
    return `${err} Showing ${n > 0 ? kept : "no saved objects"}.`;
  }
  if (/client disconnected/i.test(err)) {
    return n > 0
      ? `Connection lost — recovered ${kept}.`
      : "Connection lost before any objects were saved.";
  }
  if (job.status === "error") {
    return n > 0
      ? `Tracking stopped with an error — ${kept} recovered. ${err}`
      : `Tracking stopped with an error. ${err}`.trim();
  }
  // Job still running (or unknown status): don't claim anything terminal.
  return n > 0 ? `Restored ${kept} from the in-progress run.` : null;
}
