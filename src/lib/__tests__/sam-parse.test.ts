import { describe, expect, it } from "vitest";
import {
  buildTrackedObjects,
  iou,
  mergeAndDedupe,
  parseSamLine,
} from "../sam";

// Real wire samples (Meta docs: /docs/sam/reading-segmentation).
const LINE_TWO =
  "<12f>0<|box;x1=128;y1=153;x2=230;y2=281;w=1280;h=720|><|mask;x=0;y=0;data=180,320,~AAAA|>,1<|box;x1=640;y1=360;x2=896;y2=576;w=1280;h=720|><|mask;x=0;y=0;data=180,320,~BBBB|>";
const LINE_SPARSE = "<2f>0<|box;x1=0;y1=0;x2=64;y2=64;w=1280;h=720|><|mask;x=0;y=0;data=8,8,~Q|>,2<|box;x1=64;y1=64;x2=128;y2=128;w=1280;h=720|><|mask;x=0;y=0;data=8,8,~R|>";

describe("parseSamLine (real grammar)", () => {
  it("parses a normal multi-detection line with pixel boxes", () => {
    const out = parseSamLine(LINE_TWO);
    expect(out?.frameIndex).toBe(12);
    expect(out?.detections).toHaveLength(2);
    expect(out?.detections[0].objectId).toBe("0");
    expect(out?.detections[0].bbox).toEqual({
      x: 128 / 1280,
      y: 153 / 720,
      w: (230 - 128) / 1280,
      h: (281 - 153) / 720,
    });
    expect(out?.detections[1].objectId).toBe("1");
  });

  it("handles sparse non-dense object ids", () => {
    const out = parseSamLine(LINE_SPARSE);
    expect(out?.frameIndex).toBe(2);
    expect(out?.detections.map((d) => d.objectId)).toEqual(["0", "2"]);
  });

  it("nulls zero-area boxes instead of crashing", () => {
    const out = parseSamLine(
      "<5f>3<|box;x1=10;y1=10;x2=10;y2=20;w=100;h=100|><|mask;x=0;y=0;data=1,1,~Z|>",
    );
    expect(out?.detections).toHaveLength(1);
    expect(out?.detections[0].bbox).toBeNull();
  });

  it("returns null for empty / whitespace lines", () => {
    expect(parseSamLine("")).toBeNull();
    expect(parseSamLine("   ")).toBeNull();
  });

  it("returns null for lines without a frame head (incl. old bracket format)", () => {
    expect(parseSamLine("[obj-1] [0,0,1,1] [m]")).toBeNull();
    expect(parseSamLine("frame twelve [obj-1]")).toBeNull();
    expect(parseSamLine("12 [obj-3] [0.1,0.2,0.3,0.4] [m]")).toBeNull();
  });
});

describe("iou", () => {
  it("is 1 for identical boxes and 0 for disjoint", () => {
    const box = { x: 0.1, y: 0.1, w: 0.4, h: 0.4 };
    expect(iou(box, box)).toBeCloseTo(1);
    expect(iou(box, { x: 0.6, y: 0.6, w: 0.2, h: 0.2 })).toBe(0);
  });
});

describe("buildTrackedObjects", () => {
  it("groups by bare-int id and timestamps by frame/fps", () => {
    const objs = buildTrackedObjects({
      sessionId: "s1",
      category: "insulator",
      fps: 10,
      frames: [
        { frameIndex: 0, detections: [{ objectId: "0", bbox: { x: 0, y: 0, w: 0.5, h: 0.5 }, maskRaw: "" }] },
        {
          frameIndex: 10,
          detections: [
            { objectId: "0", bbox: { x: 0, y: 0, w: 0.5, h: 0.5 }, maskRaw: "" },
            { objectId: "2", bbox: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, maskRaw: "" },
          ],
        },
      ],
    });
    expect(objs).toHaveLength(2);
    expect(objs[0].id).toBe("insulator-001");
    expect(objs[0].totalFrameCount).toBe(2);
    expect(objs[0].frames[1].timestamp).toBeCloseTo(1.0);
    expect(objs[1].firstSeenFrame).toBe(10);
  });

  it("keeps null-bbox detections with confidence 0 (never drops silently)", () => {
    const objs = buildTrackedObjects({
      sessionId: "s1",
      category: "insulator",
      fps: 10,
      frames: [{ frameIndex: 3, detections: [{ objectId: "7", bbox: null, maskRaw: "" }] }],
    });
    expect(objs[0].frames[0].confidence).toBe(0);
    expect(objs[0].frames[0].bbox).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("mergeAndDedupe", () => {
  it("dedupes near-identical boxes across prompts, keeps distinct ones", () => {
    const mk = (id: string, box: { x: number; y: number; w: number; h: number }, n = 5) => ({
      id,
      sessionId: "s",
      category: "insulator",
      color: "#fff",
      firstSeenFrame: 0,
      lastSeenFrame: n,
      totalFrameCount: n,
      frames: Array.from({ length: n }, (_, i) => ({
        frameIndex: i,
        timestamp: i,
        bbox: box,
        confidence: 1,
      })),
    });
    const box = { x: 0.1, y: 0.1, w: 0.4, h: 0.4 };
    const same = { x: 0.11, y: 0.11, w: 0.39, h: 0.39 }; // IoU > 0.7
    const far = { x: 0.7, y: 0.7, w: 0.2, h: 0.2 };
    const merged = mergeAndDedupe([
      [mk("a", box, 6) as never],
      [mk("b", same, 3) as never, mk("c", far, 2) as never],
    ]);
    const ids = merged.map((o) => o.id).sort();
    expect(ids).toEqual(["a", "c"]);
  });
});
