import { describe, expect, it } from "vitest";
import {
  cancelJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  getJobs,
  isCancelled,
  updateJobProgress,
} from "../jobs";
import { closeDb } from "../db";

describe("jobs", () => {
  it("runs the full lifecycle", () => {
    process.env.GRIDSIGHT_DB_PATH = `/tmp/opencode/gridsight-test-${process.pid}.db`;
    const job = createJob("s1", "track", 100);
    expect(job.status).toBe("running");
    updateJobProgress(job.id, 42);
    expect(getJob(job.id)?.progress).toBe(42);
    completeJob(job.id);
    expect(getJob(job.id)?.status).toBe("complete");
    expect(isCancelled(job.id)).toBe(false);
  });

  it("cancels cooperatively and records failures", () => {
    process.env.GRIDSIGHT_DB_PATH = `/tmp/opencode/gridsight-test-${process.pid}.db`;
    const a = createJob("s1", "report");
    cancelJob(a.id);
    expect(isCancelled(a.id)).toBe(true);
    const b = createJob("s1", "track");
    failJob(b.id, "boom");
    expect(getJob(b.id)?.status).toBe("error");
    expect(getJob(b.id)?.error).toBe("boom");
  });

  it("fails loudly on unknown jobs; lists newest-first", () => {
    process.env.GRIDSIGHT_DB_PATH = `/tmp/opencode/gridsight-test-${process.pid}.db`;
    expect(getJob("nope")).toBeUndefined();
    expect(() => cancelJob("nope")).toThrow(/unknown job/);
    createJob("s-list", "track");
    createJob("s-list", "report");
    const kinds = getJobs("s-list").map((j) => j.kind);
    expect(kinds).toEqual(["report", "track"]);
    closeDb();
  });
});
