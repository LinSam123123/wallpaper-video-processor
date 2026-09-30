import { describe, expect, it } from "vitest";
import { formatFrameRate, formatMediaDuration, formatMetadataBytes, normalizeCodec } from "./media-format";

describe("media metadata formatting", () => {
  it("normalizes units, frame rates, durations, and common codecs", () => {
    expect(formatFrameRate(23.976)).toBe("23.98 fps");
    expect(formatFrameRate(24)).toBe("24 fps");
    expect(formatMediaDuration(3.4)).toBe("3.4 秒");
    expect(formatMediaDuration(70)).toBe("1 分 10 秒");
    expect(formatMetadataBytes(5.8 * 1024 ** 2)).toBe("5.8 MB");
    expect(normalizeCodec("h264")).toBe("H.264");
    expect(normalizeCodec("avc1")).toBe("H.264");
  });

  it("omits invalid metadata instead of returning placeholders", () => {
    expect(formatFrameRate(0)).toBeNull();
    expect(formatMediaDuration(Number.NaN)).toBeNull();
    expect(formatMetadataBytes(0)).toBeNull();
    expect(normalizeCodec(" ")).toBeNull();
  });
});
