import { randomUUID } from "node:crypto";
import { beforeEach } from "vitest";
import { describe, expect, it } from "vitest";
import { closeDb } from "../db";
import {
  createSession,
  getSession,
  getTaggedNotes,
  getTracking,
  getTranscript,
  listSessions,
  setTaggedNotes,
  setTracking,
  setTranscript,
  updateSession,
} from "../store";

const sid = () => `t-${randomUUID().slice(0, 8)}`;

beforeEach(() => {
  closeDb();
  process.env.GRIDSIGHT_DB_PATH = `/tmp/opencode/gridsight-test-${process.pid}.db`;
});

function session(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    substationName: "East",
    inspectorName: "Carlos",
    date: now,
    status: "tracking" as const,
    videoFileId: "cached-x",
    videoFileName: "x.mp4",
    videoDurationSec: 45,
    videoFps: 30,
    createdAt: now,
    updatedAt: now,
  };
}

describe("sqlite store", () => {
  it("create/get/update round-trips; unknown update throws", () => {
    const id = sid();
    createSession(session(id));
    expect(getSession(id)?.substationName).toBe("East");
    updateSession(id, { status: "complete" });
    expect(getSession(id)?.status).toBe("complete");
    expect(() => updateSession(`missing-${id}`, {})).toThrow(/unknown session/);
    expect(getSession(`missing-${id}`)).toBeUndefined();
  });

  it("artifacts round-trip per session", () => {
    const id = sid();
    createSession(session(id));
    setTracking(id, []);
    setTranscript(id, [{ id: "a", sessionId: id, speaker: "S", startTime: 0, endTime: 1, text: "hi" }]);
    setTaggedNotes(id, []);
    expect(getTracking(id)).toHaveLength(0);
    expect(getTranscript(id)).toHaveLength(1);
    expect(getTaggedNotes(id)).toHaveLength(0);
    expect(getTracking(`missing-${id}`)).toEqual([]);
  });

  it("survives a process restart (close + reopen)", () => {
    const id = sid();
    createSession(session(id));
    setTranscript(id, [{ id: "a", sessionId: id, speaker: "S", startTime: 0, endTime: 1, text: "hi" }]);
    closeDb(); // fresh process would open a new connection
    expect(getSession(id)?.inspectorName).toBe("Carlos");
    expect(getTranscript(id)).toHaveLength(1);
  });

  it("listSessions feeds the dashboard newest-first, with SQL-side counts", () => {
    const a = sid();
    const b = sid();
    createSession(session(a));
    createSession({ ...session(b), substationName: "West" });
    const mk = (i: number) => ({
      id: `o-${i}`,
      sessionId: b,
      category: "insulator",
      color: "#fff",
      firstSeenFrame: i,
      lastSeenFrame: i,
      totalFrameCount: 1,
      frames: [{ frameIndex: i, timestamp: i, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 1 }],
    });
    setTracking(b, [mk(1), mk(2), mk(3)]);
    const list = listSessions();
    const ids = list.map((s) => s.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    const rowB = list.find((s) => s.id === b);
    expect(rowB?.substationName).toBe("West");
    expect(rowB?.totalTracked).toBe(3);
    expect(rowB?.totalDefects).toBe(0);
  });

  it("parameterized queries neutralize id trickery", () => {
    const evil = `x' OR '1'='1`;
    expect(getSession(evil)).toBeUndefined();
    expect(getTracking(evil)).toEqual([]);
  });
});
