import { describe, expect, it, vi } from "vitest";
import { haltNotice, loadPersistedTracking } from "../track-status";
import type { TrackedObject } from "../types";

const obj = (id: string): TrackedObject => ({
  id,
  sessionId: "s1",
  category: "pole",
  color: "#fff",
  firstSeenFrame: 1,
  lastSeenFrame: 2,
  totalFrameCount: 2,
  frames: [],
});

function fetchOk(payload: unknown) {
  const seen: string[] = [];
  const f = vi.fn(async (url: string) => {
    seen.push(url);
    return { ok: true, json: async () => payload };
  });
  return Object.assign(f, { seen });
}

describe("loadPersistedTracking", () => {
  it("returns objects plus job state from the sessions API", async () => {
    const f = fetchOk({
      session: { id: "s1" },
      tracking: [obj("pole-001"), obj("pole-002")],
      trackJob: { status: "complete", error: null, progress: 5, total: 5 },
    });
    const out = await loadPersistedTracking("s1", f as never);
    expect(out?.objects).toHaveLength(2);
    expect(out?.job).toMatchObject({ status: "complete", progress: 5, total: 5 });
    expect(f).toHaveBeenCalledOnce();
    expect(String(f.seen[0])).toContain("sessionId=s1");
  });

  it("returns empty objects (not failure) when the workspace is genuinely empty", async () => {
    const out = await loadPersistedTracking(
      "s1",
      fetchOk({ session: { id: "s1" }, tracking: [], trackJob: null }) as never,
    );
    expect(out).toEqual({ objects: [], job: null });
  });

  it("returns null on HTTP error or network failure", async () => {
    const bad = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    expect(await loadPersistedTracking("nope", bad as never)).toBeNull();
    const down = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await loadPersistedTracking("s1", down as never)).toBeNull();
  });
});

describe("haltNotice", () => {
  it("reports cancelled runs with kept counts, never as success", () => {
    expect(
      haltNotice({ objects: [obj("a"), obj("b")], job: { status: "cancelled", error: null, progress: 2, total: 5 } }),
    ).toBe("Tracking cancelled — 2 saved objects kept.");
    expect(
      haltNotice({ objects: [], job: { status: "cancelled", error: null, progress: 0, total: 5 } }),
    ).toBe("Tracking cancelled before any objects were saved.");
  });

  it("reports timeouts with the server message and saved counts", () => {
    expect(
      haltNotice({
        objects: [obj("a")],
        job: { status: "error", error: "time budget exceeded after 1 of 5 prompts; partial results preserved (1 objects)", progress: 1, total: 5 },
      }),
    ).toContain("time budget exceeded");
  });

  it("reports disconnects as connection loss, never as confirmed cancellation", () => {
    const note = haltNotice({
      objects: [obj("a")],
      job: { status: "error", error: "client disconnected; partial results preserved (1 objects)", progress: 3, total: 5 },
    })!;
    expect(note).toMatch(/Connection lost/);
    expect(note).not.toMatch(/[Cc]ancelled/);
  });

  it("stays silent for completed or fresh sessions; reports restored in-progress work", () => {
    expect(
      haltNotice({ objects: [obj("a")], job: { status: "complete", error: null, progress: 5, total: 5 } }),
    ).toBeNull();
    expect(
      haltNotice({ objects: [obj("a")], job: { status: "running", error: null, progress: 3, total: 5 } }),
    ).toBe("Restored 1 saved object from the in-progress run.");
    expect(haltNotice({ objects: [], job: null })).toBeNull();
    expect(haltNotice(null)).toBeNull();
  });
});
