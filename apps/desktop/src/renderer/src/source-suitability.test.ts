import { describe, expect, it } from "vitest";
import type { MediaInfo } from "../../shared/contracts";
import { sourceSuitability } from "./source-suitability";

function media(width: number, height: number): MediaInfo {
  return {
    path: "D:/source.mp4",
    format: "mp4",
    durationSeconds: 2,
    sizeBytes: 1,
    video: { codec: "h264", width, height, frameRate: 16, frameCount: 32, durationSeconds: 2 },
    audio: [],
  };
}

describe("sourceSuitability", () => {
  it("reports the severe portrait-to-landscape crop and remaining enlargement", () => {
    const result = sourceSuitability(media(384, 512), { width: 2560, height: 1600 }, "cover", "realesrgan", "realesr-animevideov3", "auto");
    expect(result?.requiredScale).toBeCloseTo(6.6667, 3);
    expect(result?.retainedFraction).toBeCloseTo(0.46875, 4);
    expect(result?.actualAiScale).toBe(4);
    expect(result?.remainingLanczosScale).toBeCloseTo(1.6667, 3);
    expect(result?.recommendedMinimum).toEqual({ width: 1280, height: 800 });
  });

  it("reports contain padding without claiming a source crop", () => {
    const result = sourceSuitability(media(384, 512), { width: 2560, height: 1600 }, "contain", "lanczos", "realesr-animevideov3", "auto");
    expect(result?.retainedFraction).toBe(1);
    expect(result?.cropFraction).toBe(0);
    expect(result?.paddingFraction).toBeCloseTo(0.53125, 4);
    expect(result?.requiredScale).toBeCloseTo(3.125, 3);
  });

  it("uses foreground-fit scaling for a blurred background", () => {
    const result = sourceSuitability(media(1280, 720), { width: 2560, height: 1600 }, "blur-background", "realesrgan", "realesr-animevideov3", "auto");
    expect(result?.requiredScale).toBe(2);
    expect(result?.retainedFraction).toBe(1);
    expect(result?.paddingFraction).toBe(0);
    expect(result?.actualAiScale).toBe(2);
  });
});
