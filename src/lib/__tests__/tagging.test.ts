import { describe, expect, it } from "vitest";
import {
  buildTaggingPayload,
  fallbackTag,
  validateTaggedNotes,
} from "../tagging";
import type { TrackedObject, TranscriptSegment } from "../types";

const obj = (
  id: string,
  category: string,
  start: number,
  end: number,
): TrackedObject => ({
  id,
  sessionId: "s1",
  category,
  color: "#fff",
  firstSeenFrame: Math.round(start * 10),
  lastSeenFrame: Math.round(end * 10),
  totalFrameCount: 5,
  frames: [start, (start + end) / 2, end].map((t, i) => ({
    frameIndex: Math.round(start * 10) + i,
    timestamp: t,
    bbox: { x: 0, y: 0, w: 0.5, h: 0.5 },
    confidence: 1,
  })),
});

const seg = (id: string, start: number, end: number, text: string): TranscriptSegment => ({
  id,
  sessionId: "s1",
  speaker: "SPEAKER_0",
  startTime: start,
  endTime: end,
  text,
});

describe("buildTaggingPayload", () => {
  it("serializes compact object + segment summaries", () => {
    const p = buildTaggingPayload([obj("insulator-001", "insulator", 10, 20)], [seg("a", 12, 14, "hi")]);
    expect(p.objects).toEqual([{ id: "insulator-001", category: "insulator", firstSeen: 10, lastSeen: 20, frameCount: 5 }]);
    expect(p.segments).toEqual([{ id: "a", start: 12, end: 14, text: "hi" }]);
  });
});

describe("fallbackTag", () => {
  it("matches keyword + overlap at 0.9", () => {
    const out = fallbackTag(
      [obj("insulator-001", "insulator", 10, 20)],
      [seg("a", 12, 14, "Corrosion on the insulator")],
    );
    expect(out[0]).toMatchObject({ matchedAssetId: "insulator-001", matchedCategory: "insulator", matchConfidence: 0.9 });
  });

  it("matches keyword-only at 0.6 without overlap", () => {
    const out = fallbackTag(
      [obj("insulator-001", "insulator", 50, 60)],
      [seg("a", 12, 14, "The insulator looks fine")],
    );
    expect(out[0]).toMatchObject({ matchedAssetId: "insulator-001", matchConfidence: 0.6 });
  });

  it("matches overlap-only at 0.4", () => {
    const out = fallbackTag(
      [obj("transformer-001", "transformer", 10, 20)],
      [seg("a", 12, 14, "Something looks odd here")],
    );
    expect(out[0]).toMatchObject({ matchedAssetId: "transformer-001", matchConfidence: 0.4 });
  });

  it("returns unmatched null when nothing aligns", () => {
    const out = fallbackTag(
      [obj("transformer-001", "transformer", 50, 60)],
      [seg("a", 12, 14, "The insulator looks fine")],
    );
    expect(out[0]).toMatchObject({ matchedAssetId: null, matchedCategory: null, matchConfidence: 0 });
  });

  it("handles empty objects and empty segments", () => {
    expect(fallbackTag([], [seg("a", 0, 1, "hi")])[0].matchedAssetId).toBeNull();
    expect(fallbackTag([obj("a", "insulator", 0, 5)], [])).toEqual([]);
  });

  it("matches plural mentions via substring", () => {
    const out = fallbackTag(
      [obj("insulator-001", "insulator", 50, 60)],
      [seg("a", 1, 2, "Check the insulators")],
    );
    expect(out[0].matchedAssetId).toBe("insulator-001");
  });
});

describe("validateTaggedNotes", () => {
  const good = {
    segmentId: "s1-seg-000",
    text: "hi",
    speaker: "SPEAKER_0",
    startTime: 0,
    endTime: 1,
    matchedAssetId: "insulator-001",
    matchedCategory: "insulator",
    matchConfidence: 0.9,
    matchReason: "keyword + overlap",
  };

  it("accepts a bare array and {taggedNotes} wrapper", () => {
    expect(validateTaggedNotes([good])).toHaveLength(1);
    expect(validateTaggedNotes({ taggedNotes: [good] })).toHaveLength(1);
  });

  it("rejects out-of-range confidence", () => {
    expect(() => validateTaggedNotes([{ ...good, matchConfidence: 1.5 }])).toThrow();
  });

  it("rejects missing segmentId / wrong types", () => {
    expect(() => validateTaggedNotes([{ ...good, segmentId: undefined }])).toThrow();
    expect(() => validateTaggedNotes([{ ...good, matchedAssetId: 42 }])).toThrow();
  });

  it("rejects non-array payloads", () => {
    expect(() => validateTaggedNotes({ nope: true })).toThrow();
  });
});
