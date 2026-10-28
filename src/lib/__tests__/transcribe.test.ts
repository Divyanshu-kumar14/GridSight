import { describe, expect, it } from "vitest";
import {
  assertAudioValid,
  buildTranscriptSegments,
  needsConversion,
  summarizeSegments,
} from "../audio";

describe("assertAudioValid", () => {
  it("accepts a normal wav/mp3 under the cap", () => {
    expect(() => assertAudioValid(1024, "memo.wav")).not.toThrow();
    expect(() => assertAudioValid(5 * 1024 * 1024, "note.MP3")).not.toThrow();
  });

  it("rejects empty files", () => {
    expect(() => assertAudioValid(0, "memo.wav")).toThrow();
  });

  it("rejects oversize files", () => {
    expect(() => assertAudioValid(33 * 1024 * 1024, "memo.wav")).toThrow(/32MB/);
  });

  it("rejects unsupported extensions", () => {
    expect(() => assertAudioValid(1024, "clip.txt")).toThrow(/Unsupported/);
    expect(() => assertAudioValid(1024, "video.mp4")).toThrow(/Unsupported/);
  });
});

describe("needsConversion", () => {
  it("passes wav through, converts everything else", () => {
    expect(needsConversion("a.wav")).toBe(false);
    expect(needsConversion("A.WAV")).toBe(false);
    expect(needsConversion("a.mp3")).toBe(true);
    expect(needsConversion("record.webm")).toBe(true);
  });
});

describe("buildTranscriptSegments", () => {
  const raw = {
    segments: [
      { speaker: "SPEAKER_0", start: 12.4, end: 18.2, text: " Corrosion on insulator three " },
      { speaker: "SPEAKER_1", start: 19.0, end: 24.5, text: "T4 oil low" },
    ],
  };

  it("maps Meta response to TranscriptSegments with trimmed text + stable ids", () => {
    const out = buildTranscriptSegments(raw, "s1");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "s1-seg-000", speaker: "SPEAKER_0", startTime: 12.4, text: "Corrosion on insulator three" });
  });

  it("accepts a bare array", () => {
    expect(buildTranscriptSegments(raw.segments, "s1")).toHaveLength(2);
  });

  it("drops invalid entries instead of crashing", () => {
    const out = buildTranscriptSegments(
      { segments: [{ speaker: "S", start: "x", end: 1, text: "bad" }, { speaker: "S", start: 0, end: 1, text: "   " }, null] },
      "s1",
    );
    expect(out).toHaveLength(0);
  });

  it("returns [] for empty / malformed payloads", () => {
    expect(buildTranscriptSegments({}, "s1")).toEqual([]);
    expect(buildTranscriptSegments(null, "s1")).toEqual([]);
  });

  it("defaults missing speaker", () => {
    const out = buildTranscriptSegments([{ start: 0, end: 1, text: "hi" }], "s1");
    expect(out[0].speaker).toBe("SPEAKER_0");
  });

  it("maps Meta turns (ms timestamps) to segments", () => {
    const out = buildTranscriptSegments(
      {
        sessionId: "9f1c",
        transcript: "How is the weather? It is raining.",
        audioDurationMs: 8240,
        turns: [
          { turnId: 1, startMs: 1520, endMs: 4640, transcript: " How is the weather? ", speaker: "A" },
          { turnId: 2, startMs: 5900, endMs: 8240, transcript: "It is raining.", speaker: "B" },
        ],
      },
      "s1",
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "s1-seg-000", speaker: "A", startTime: 1.52, endTime: 4.64, text: "How is the weather?" });
    expect(out[1]).toMatchObject({ id: "s1-seg-001", speaker: "B", startTime: 5.9, text: "It is raining." });
  });

  it("drops malformed turns instead of crashing", () => {
    const out = buildTranscriptSegments(
      { turns: [{ turnId: 1, startMs: "x", endMs: 2, transcript: "bad" }, null] },
      "s1",
    );
    expect(out).toEqual([]);
  });
});

describe("summarizeSegments", () => {
  it("reports max end time + distinct speaker count", () => {
    const segs = buildTranscriptSegments(
      {
        segments: [
          { speaker: "SPEAKER_0", start: 0, end: 5, text: "a" },
          { speaker: "SPEAKER_0", start: 6, end: 12, text: "b" },
          { speaker: "SPEAKER_1", start: 13, end: 20, text: "c" },
        ],
      },
      "s1",
    );
    expect(summarizeSegments(segs)).toEqual({ totalDuration: 20, speakerCount: 2 });
  });

  it("handles empty transcript", () => {
    expect(summarizeSegments([])).toEqual({ totalDuration: 0, speakerCount: 0 });
  });
});
