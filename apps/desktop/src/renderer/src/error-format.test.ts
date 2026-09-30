import { describe, expect, it } from "vitest";
import { formatSerializedError } from "./error-format";

describe("formatSerializedError", () => {
  it("shows the path and disk amounts for insufficient space errors", () => {
    expect(formatSerializedError({
      code: "E_INSUFFICIENT_SPACE",
      message: "空间不足",
      details: {
        path: "D:\\wallpaper-work",
        requiredBytes: 12 * 1024 ** 3,
        availableBytes: 3.5 * 1024 ** 3,
      },
    })).toBe("空间不足 · 位置：D:\\wallpaper-work · 需要：12.00 GiB · 可用：3.50 GiB");
  });

  it("keeps ordinary errors concise", () => {
    expect(formatSerializedError({ code: "E_IO", message: "读取失败" })).toBe("读取失败");
  });

  it("shows expected and actual values for verification failures", () => {
    expect(formatSerializedError({
      code: "E_VERIFICATION_FAILED",
      message: "成片属性验证失败",
      details: {
        failedChecks: [{
          name: "colorTransfer",
          expected: "bt709",
          actual: "iec61966-2-1",
          passed: false,
        }],
      },
    })).toBe("成片属性验证失败 · 色彩传递特性：期望 bt709，实际 iec61966-2-1");
  });

  it("shows multiple checks and labels missing metadata as undeclared", () => {
    expect(formatSerializedError({
      code: "E_VERIFICATION_FAILED",
      message: "成片属性验证失败",
      details: {
        failedChecks: [
          { name: "sampleAspectRatio", expected: "1:1", passed: false },
          { name: "frameCount", expected: 48, actual: 47, passed: false },
        ],
      },
    })).toBe("成片属性验证失败 · 像素宽高比：期望 1:1，实际 未声明 · 帧数：期望 48，实际 47");
  });

  it("shows both explicit remedies for an unsupported NVENC resolution", () => {
    expect(formatSerializedError({
      code: "E_ENCODER_UNSUPPORTED_RESOLUTION",
      message: "H.264 NVIDIA 编码器不支持 5120 × 3200 输出",
      details: {
        encoder: "h264_nvenc",
        requested: { width: 5120, height: 3200 },
        maxDimension: 4096,
        suggestedTarget: { width: 4096, height: 2560 },
        supportedEncoder: "libx264",
      },
    })).toBe("H.264 NVIDIA 编码器不支持 5120 × 3200 输出 · 单边上限 4096 · 可改用高质量 CPU 保留 5120 × 3200，或调整为 4096 × 2560");
  });
});
