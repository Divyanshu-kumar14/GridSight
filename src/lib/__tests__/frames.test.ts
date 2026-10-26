import { describe, expect, it } from "vitest";
import { buildCropFilter, isSafeThumbName, slugObjectId } from "../frames";

describe("buildCropFilter", () => {
  it("converts normalized bbox to clamped pixel crop", () => {
    expect(buildCropFilter({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 1000, 500)).toBe(
      "crop=300:200:100:100,scale=256:-1",
    );
  });

  it("clamps negative origins and enforces minimum size", () => {
    expect(buildCropFilter({ x: -0.5, y: 0, w: 0, h: 0 }, 100, 100)).toBe(
      "crop=2:2:0:0,scale=256:-1",
    );
  });
});

describe("isSafeThumbName", () => {
  it("accepts session thumbnails only", () => {
    expect(isSafeThumbName("abc-thumb-x-001.jpg")).toBe(true);
    expect(isSafeThumbName("../../etc/passwd")).toBe(false);
    expect(isSafeThumbName("x.png")).toBe(false);
    expect(isSafeThumbName("")).toBe(false);
  });

  it("rejects names with spaces — slugObjectId must be applied first", () => {
    expect(isSafeThumbName("x-thumb-transmission tower-003.jpg")).toBe(false);
    expect(slugObjectId("transmission tower-003")).toBe("transmission_tower-003");
    expect(isSafeThumbName(`x-thumb-${slugObjectId("transmission tower-003")}.jpg`)).toBe(true);
    expect(slugObjectId("../../etc/passwd")).toBe("______etc_passwd");
  });
});
