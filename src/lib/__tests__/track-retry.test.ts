import { afterEach, describe, expect, it, vi } from "vitest";

const createMock = vi.hoisted(() => vi.fn());

vi.mock("../meta-client", () => ({
  getMetaClient: () => ({ responses: { create: createMock } }),
}));

import {
  formatSamDebug,
  isRetryableProviderError,
  isStreamClosedError,
  SAM_DEBUG_HEAD_CHARS,
  samDebugEnabled,
  TRACK_CANCELLED,
  TRACK_TIMEOUT,
  trackPrompt,
} from "../sam";

// One valid SAM wire line (grammar: <Nf>id<|box;...|><|mask;...|>).
const LINE =
  "<0f>0<|box;x1=10;y1=20;x2=30;y2=40;w=1280;h=720|><|mask;x=0;y=0;data=1,1,~AAAA|>\n";
const LINE2 =
  "<3f>1<|box;x1=40;y1=50;x2=90;y2=120;w=1280;h=720|><|mask;x=0;y=0;data=2,2,~BBBB|>\n";

async function* streamOf(events: Array<{ delta?: string } | Error>) {
  for (const e of events) {
    if (e instanceof Error) throw e;
    yield e;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  createMock.mockReset();
});

function statusErr(status: number): Error {
  return Object.assign(new Error(`provider failed with ${status}`), { status });
}

describe("trackPrompt retry isolation (mocked provider, no network)", () => {
  it("a failed attempt after records does not leak into the retry", async () => {
    vi.useFakeTimers();
    createMock
      .mockImplementationOnce(async () => streamOf([{ delta: LINE }, new Error("mid-stream boom")]))
      .mockImplementationOnce(async () => streamOf([{ delta: LINE2 }]));
    const p = trackPrompt("f1", "pole");
    await vi.advanceTimersByTimeAsync(5000);
    const res = await p;
    // Attempt 1 parsed a frame then died; attempt 2 parsed one frame.
    // Retry isolation: only the successful attempt's frames survive.
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(res).toHaveLength(1);
    expect(res[0].frameIndex).toBe(3);
  });

  it("a failing progress callback is not retried as a provider error", async () => {
    createMock.mockImplementation(async () => streamOf([{ delta: LINE }]));
    await expect(
      trackPrompt("f1", "pole", () => {
        throw new Error(TRACK_CANCELLED);
      }),
    ).rejects.toThrow(TRACK_CANCELLED);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("retries 500s and rate limits but not auth errors, aborts, or closed streams", async () => {
    vi.useFakeTimers();
    // 500 → retried.
    createMock.mockImplementationOnce(async () => {
      throw statusErr(500);
    });
    createMock.mockImplementationOnce(async () => streamOf([{ delta: LINE }]));
    const p500 = trackPrompt("f1", "pole");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p500)).toHaveLength(1);
    expect(createMock).toHaveBeenCalledTimes(2);

    // 429 → retried.
    createMock.mockReset();
    createMock.mockImplementationOnce(async () => {
      throw statusErr(429);
    });
    createMock.mockImplementationOnce(async () => streamOf([{ delta: LINE }]));
    const p429 = trackPrompt("f1", "pole");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p429)).toHaveLength(1);
    expect(createMock).toHaveBeenCalledTimes(2);

    // 401 → NOT retried (would never heal).
    createMock.mockReset();
    createMock.mockImplementation(async () => {
      throw statusErr(401);
    });
    await expect(trackPrompt("f1", "pole")).rejects.toThrow("401");
    expect(createMock).toHaveBeenCalledTimes(1);

    // Abort → NOT retried.
    createMock.mockReset();
    createMock.mockImplementation(async () =>
      streamOf([{ delta: LINE }, Object.assign(new Error("aborted"), { name: "AbortError" })]),
    );
    await expect(trackPrompt("f1", "pole")).rejects.toThrow("aborted");
    expect(createMock).toHaveBeenCalledTimes(1);

    // Closed stream → NOT retried.
    createMock.mockReset();
    createMock.mockImplementation(async () =>
      streamOf([{ delta: LINE }, new Error("Invalid state: Controller is already closed")]));
    await expect(trackPrompt("f1", "pole")).rejects.toThrow(/already closed/);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("forwards the abort signal to the provider request", async () => {
    const controller = new AbortController();
    createMock.mockImplementation(async () => streamOf([{ delta: LINE }]));
    await trackPrompt("f1", "pole", undefined, { signal: controller.signal });
    expect(createMock).toHaveBeenCalledOnce();
    const opts = createMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(controller.signal);
  });

  it("isStreamClosedError only matches dead-stream failures", () => {
    expect(isStreamClosedError(new Error("Invalid state: Controller is already closed"))).toBe(true);
    expect(isStreamClosedError(new Error("boom"))).toBe(false);
    expect(isStreamClosedError(new Error(TRACK_CANCELLED))).toBe(false);
    expect(isStreamClosedError("already closed")).toBe(true);
    expect(isStreamClosedError(null)).toBe(false);
  });

  it("isRetryableProviderError classifies without guessing", () => {
    expect(isRetryableProviderError(new Error("boom"))).toBe(true);
    expect(isRetryableProviderError(statusErr(500))).toBe(true);
    expect(isRetryableProviderError(statusErr(429))).toBe(true);
    expect(isRetryableProviderError(statusErr(401))).toBe(false);
    expect(isRetryableProviderError(statusErr(404))).toBe(false);
    expect(isRetryableProviderError(new Error(TRACK_CANCELLED))).toBe(false);
    expect(isRetryableProviderError(new Error(TRACK_TIMEOUT))).toBe(false);
    expect(isRetryableProviderError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(false);
    expect(isRetryableProviderError(new Error("Invalid state: Controller is already closed"))).toBe(false);
  });

  it("an expired budget stops retries: one attempt, timeout error, no extra quota", async () => {
    vi.useFakeTimers();
    createMock.mockRejectedValueOnce(statusErr(500));
    let checks = 0;
    const p = trackPrompt("f1", "pole", undefined, { isExpired: () => ++checks > 1 });
    await expect(p).rejects.toThrow(TRACK_TIMEOUT);
    // Pre-loop check passed (call 1), attempt failed retryably, expiry check
    // (call 2) stopped the retry before a second provider call.
    expect(checks).toBe(2);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("per-chunk checks fire on unparseable streams that yield zero frames", async () => {
    // Unparseable prose: no <Nf> heads, so no parsed frames ever emit.
    const chunks = [{ delta: "still looking at the video feed " }, { delta: "no objects visible yet " }];
    let calls = 0;
    createMock.mockImplementation(async () => streamOf(chunks));
    await expect(
      trackPrompt("f1", "pole", undefined, { isCancelled: () => ++calls > 1 }),
    ).rejects.toThrow(TRACK_CANCELLED);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("per-chunk budget fires on unparseable streams without waiting for frames", async () => {
    const chunks = [{ delta: "scanning " }, { delta: "scanning more " }];
    let calls = 0;
    createMock.mockImplementation(async () => streamOf(chunks));
    await expect(
      trackPrompt("f1", "pole", undefined, { isExpired: () => ++calls > 1 }),
    ).rejects.toThrow(TRACK_TIMEOUT);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe("bounded redacted diagnostics (GRIDSIGHT_DEBUG_SAM=1)", () => {
  it("stays off unless the flag is exactly 1", () => {
    const prev = process.env.GRIDSIGHT_DEBUG_SAM;
    try {
      delete process.env.GRIDSIGHT_DEBUG_SAM;
      expect(samDebugEnabled()).toBe(false);
      process.env.GRIDSIGHT_DEBUG_SAM = "true";
      expect(samDebugEnabled()).toBe(false);
      process.env.GRIDSIGHT_DEBUG_SAM = "1";
      expect(samDebugEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GRIDSIGHT_DEBUG_SAM;
      else process.env.GRIDSIGHT_DEBUG_SAM = prev;
    }
  });

  it("redacts mask blobs but keeps box coordinates", () => {
    const head = `<0f>0<|box;x1=10;y1=20;x2=30;y2=40;w=1280;h=720|><|mask;x=0;y=0;data=1,1,${"A".repeat(5000)}|>`;
    const line = formatSamDebug({
      prompt: "pole",
      totalChars: 9000,
      maxDeltaChars: 8000,
      maxLineBuffer: 8100,
      streamCompleted: true,
      parsedFrames: 1,
      matchedRecords: 1,
      head,
    });
    expect(line).toContain("[sam-debug]");
    expect(line).toContain("x1=10");
    expect(line).not.toContain("A".repeat(100));
    expect(line).toContain("data=<redacted>");
    expect(line).toContain("maxDelta=8000");
    expect(line).toContain("maxLine=8100");
    expect(line.length).toBeLessThan(SAM_DEBUG_HEAD_CHARS + 400);
  });

  it("logs one bounded line per prompt when enabled, nothing when disabled", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.GRIDSIGHT_DEBUG_SAM = "1";
      createMock.mockImplementation(async () => streamOf([{ delta: LINE }]));
      await trackPrompt("f1", "pole");
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0][0])).toMatch(/^\[sam-debug\] prompt="pole" chars=\d+/);
    } finally {
      delete process.env.GRIDSIGHT_DEBUG_SAM;
      errSpy.mockRestore();
    }
    const errSpy2 = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createMock.mockImplementation(async () => streamOf([{ delta: LINE }]));
      await trackPrompt("f1", "pole");
      expect(errSpy2).not.toHaveBeenCalled();
    } finally {
      errSpy2.mockRestore();
    }
  });

  it("long mask-heavy lines parse without retaining the blob", async () => {
    const big = `<9f>2<|box;x1=1;y1=2;x2=3;y2=4;w=1280;h=720|><|mask;x=0;y=0;data=9,9,~${"Z".repeat(200000)}|>\n`;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.GRIDSIGHT_DEBUG_SAM = "1";
      createMock.mockImplementation(async () => streamOf([{ delta: big }]));
      const res = await trackPrompt("f1", "pole");
      expect(res).toHaveLength(1);
      expect(res[0].detections).toHaveLength(1);
      const logged = String(errSpy.mock.calls[0][0]);
      expect(logged).toContain("data=<redacted>");
      expect(logged).not.toContain("Z".repeat(100));
      expect(logged).toContain("maxLine=");
    } finally {
      delete process.env.GRIDSIGHT_DEBUG_SAM;
      errSpy.mockRestore();
    }
  });
});
