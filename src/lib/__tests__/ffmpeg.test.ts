import { describe, expect, it } from "vitest";
import { buildKeyFrameFilter, KEY_FRAME_MAX_EDGE } from "../ffmpeg";

// Regression guard: key frames are model input, not gallery images. Without the
// downscale, 8 frames of 4K JPEG (~2MB each) exceed the vision request budget.
describe("buildKeyFrameFilter", () => {
  it("caps the long edge and never upscales", () => {
    expect(buildKeyFrameFilter()).toBe(`scale='min(${KEY_FRAME_MAX_EDGE},iw)':-2`);
    expect(KEY_FRAME_MAX_EDGE).toBeLessThanOrEqual(1280);
  });

  it("honours a custom cap", () => {
    expect(buildKeyFrameFilter(640)).toContain("min(640,iw)");
  });
});
