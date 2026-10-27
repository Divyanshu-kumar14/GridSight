import { describe, expect, it, vi } from "vitest";
import {
  runTrackPrompts,
  TRACK_BUDGET_MS,
  type TrackRunDeps,
} from "../track-run";
import { isStreamClosedError, TRACK_CANCELLED } from "../sam";
import type { TrackedObject } from "../types";

// Deterministic canned SAM frames — no network, no quota.
const det = (objectId: string, x = 0.1, y = 0.1, w = 0.2, h = 0.2) => ({
  frameIndex: 5,
  detections: [{ objectId, bbox: { x, y, w, h }, maskRaw: "" }],
});
const far = (objectId: string) => ({
  frameIndex: 7,
  detections: [{ objectId, bbox: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 }, maskRaw: "" }],
});

function harness(over: Partial<TrackRunDeps> & { prompts: string[] }) {
  const persisted: TrackedObject[][] = [];
  const events: Array<{ type: string; data: unknown }> = [];
  const deps: TrackRunDeps = {
    sessionId: "s1",
    fileId: "f1",
    fps: 30,
    trackPrompt: async () => [],
    persist: (o) => void persisted.push(o),
    isCancelled: () => false,
    onFrame: () => {},
    onPromptDone: (d) => void events.push({ type: "promptDone", data: d }),
    ...over,
  };
  return { deps, persisted, events };
}

describe("runTrackPrompts orchestration", () => {
  it("valid prompt followed by an empty prompt keeps the valid objects", async () => {
    const trackPrompt = vi.fn(async (_f: string, c: string) => (c === "pole" ? [det("0"), det("0")] : []));
    const { deps, persisted, events } = harness({ prompts: ["pole", "tower"], trackPrompt });
    const out = await runTrackPrompts(deps);
    expect(out.status).toBe("complete");
    expect(out.completedPrompts).toBe(2);
    expect(out.objects).toHaveLength(1);
    expect(out.objects[0].id).toBe("pole-001");
    // Incremental persistence: first prompt saved alone, second keeps it.
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toHaveLength(1);
    expect(persisted[1]).toHaveLength(1);
    expect(events.map((e) => (e.data as { count: number }).count)).toEqual([1, 0]);
  });

  it("multiple valid prompts merge and persist incrementally", async () => {
    const trackPrompt = vi.fn(async (_f: string, c: string) =>
      c === "pole" ? [det("0")] : [far("7")],
    );
    const { deps, persisted } = harness({ prompts: ["pole", "tower"], trackPrompt });
    const out = await runTrackPrompts(deps);
    expect(out.status).toBe("complete");
    expect(out.objects).toHaveLength(2);
    expect(persisted.map((p) => p.length)).toEqual([1, 2]);
  });

  it("cancel during the second prompt preserves the first prompt's partials", async () => {
    let calls = 0;
    const trackPrompt = vi.fn(async () => [det("0")]);
    const { deps, persisted } = harness({
      prompts: ["pole", "tower"],
      trackPrompt,
      isCancelled: () => ++calls > 1,
    });
    const out = await runTrackPrompts(deps);
    expect(out.status).toBe("cancelled");
    expect(out.completedPrompts).toBe(1);
    expect(out.objects).toHaveLength(1);
    expect(persisted).toHaveLength(1);
  });

  it("cancel before any prompt yields empty cancelled, never an error", async () => {
    const trackPrompt = vi.fn(async () => [det("0")]);
    const { deps, persisted } = harness({
      prompts: ["pole"],
      trackPrompt,
      isCancelled: () => true,
    });
    const out = await runTrackPrompts(deps);
    expect(out.status).toBe("cancelled");
    expect(out.completedPrompts).toBe(0);
    expect(out.objects).toEqual([]);
    expect(trackPrompt).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
  });

  it("closed stream mid-run rejects as disconnect without losing persisted prompts", async () => {
    const trackPrompt = vi.fn(async () => [det("0")]);
    const { deps, persisted } = harness({
      prompts: ["pole", "tower"],
      trackPrompt,
      onPromptDone: () => {
        throw new Error("Invalid state: Controller is already closed");
      },
    });
    await expect(runTrackPrompts(deps)).rejects.toThrow(/already closed/);
    // First prompt was persisted BEFORE the failed send.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toHaveLength(1);
  });

  it("budget timeout stops with partials and an explicit timeout status", async () => {
    let t = 0;
    const trackPrompt = vi.fn(async () => [det("0")]);
    const { deps, persisted } = harness({
      prompts: ["pole", "tower", "fence"],
      trackPrompt,
      now: () => (t += 1000),
      budgetMs: 1500,
    });
    const out = await runTrackPrompts(deps);
    expect(out.status).toBe("timeout");
    expect(out.completedPrompts).toBe(1);
    expect(out.objects).toHaveLength(1);
    expect(persisted).toHaveLength(1);
    expect(TRACK_BUDGET_MS).toBeGreaterThan(0);
  });

  it("cooperative cancel inside a prompt converts to cancelled, not error", async () => {
    const trackPrompt = vi.fn(
      async (_f: string, _c: string, onProgress?: (p: { frameIndex: number; totalSoFar: number }) => void) => {
        onProgress?.({ frameIndex: 3, totalSoFar: 1 });
        return [det("0")];
      },
    );
    const { deps } = harness({
      prompts: ["pole"],
      trackPrompt,
      onFrame: () => {
        throw new Error(TRACK_CANCELLED);
      },
    });
    const out = await runTrackPrompts(deps);
    expect(out.status).toBe("cancelled");
    expect(out.completedPrompts).toBe(0);
  });

  it("isStreamClosedError only matches dead-stream failures", () => {
    expect(isStreamClosedError(new Error("Invalid state: Controller is already closed"))).toBe(true);
    expect(isStreamClosedError(new Error("boom"))).toBe(false);
    expect(isStreamClosedError(new Error(TRACK_CANCELLED))).toBe(false);
    expect(isStreamClosedError("already closed")).toBe(true);
    expect(isStreamClosedError(null)).toBe(false);
  });

  it("passes the abort signal through to the provider call", async () => {
    const seen: unknown[] = [];
    const trackPrompt = vi.fn(async (...a: unknown[]) => {
      seen.push(a[3]);
      return [det("0")];
    });
    const controller = new AbortController();
    const { deps } = harness({
      prompts: ["pole"],
      trackPrompt: trackPrompt as never,
      signal: controller.signal,
    });
    const out = await runTrackPrompts(deps);
    expect(out.status).toBe("complete");
    expect(trackPrompt).toHaveBeenCalledOnce();
    expect((seen[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  it("enforces the budget during a prompt, not just between prompts", async () => {
    let t = 0;
    const trackPrompt = vi.fn(
      async (_f: string, _c: string, onProgress?: (p: { frameIndex: number; totalSoFar: number }) => void) => {
        onProgress?.({ frameIndex: 1, totalSoFar: 1 });
        return [det("0")];
      },
    );
    const { deps, persisted } = harness({
      prompts: ["pole", "tower"],
      trackPrompt,
      now: () => (t += 1000),
      budgetMs: 1500,
    });
    const out = await runTrackPrompts(deps);
    // Budget blows mid-first-prompt: nothing completed, nothing persisted.
    expect(out.status).toBe("timeout");
    expect(out.completedPrompts).toBe(0);
    expect(out.objects).toEqual([]);
    expect(persisted).toHaveLength(0);
  });

  it("maps an aborted provider request to disconnected with partials kept", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    let calls = 0;
    const trackPrompt = vi.fn(async () => {
      calls++;
      if (calls === 1) return [det("0")];
      throw abort;
    });
    const { deps, persisted } = harness({ prompts: ["pole", "tower"], trackPrompt });
    const out = await runTrackPrompts(deps);
    expect(out.status).toBe("disconnected");
    expect(out.completedPrompts).toBe(1);
    expect(out.objects).toHaveLength(1);
    expect(persisted).toHaveLength(1);
  });
});
