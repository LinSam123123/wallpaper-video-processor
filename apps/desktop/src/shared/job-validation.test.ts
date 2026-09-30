import { describe, expect, it } from "vitest";
import type { JobSpec, JobSpecV2, JobSpecV3, JobSpecV4, UpscaleSpecV4 } from "./contracts";
import { encoderResolutionDetails, fitWithinDimension, validateJobRequest } from "./job-validation";

function job(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    version: 2,
    inputPath: "D:/source.mp4",
    outputPath: "D:/source.wallpaper.mp4",
    target: { width: 2560, height: 1600 },
    aspectMode: "cover",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "pingpong",
    upscaleMode: "realesrgan",
    model: "realesr-animevideov3",
    tile: 384,
    gpuId: "auto",
    aiScale: "auto",
    batchSize: 64,
    sourceFps: "auto",
    interpolation: {
      mode: "none",
      factor: 1,
      model: "rife-v4.6",
      memoryMode: "auto",
      sceneCutMode: "hold",
    },
    encoding: {
      codec: "h264",
      encoder: "libx264",
      profile: "high",
      crf: 17,
      preset: "slow",
      pixelFormat: "yuv420p",
      removeAudio: true,
    },
    ...overrides,
  } as JobSpec;
}

function jobV3(overrides: Partial<JobSpecV3> = {}): JobSpecV3 {
  return {
    ...job(),
    version: 3,
    sourceRange: { startFrame: 0, endFrameExclusive: 48 },
    ...overrides,
  } as JobSpecV3;
}

function jobV4(overrides: Partial<JobSpecV4> = {}): JobSpecV4 {
  const legacy = job();
  return {
    version: 4,
    inputPath: legacy.inputPath,
    outputPath: legacy.outputPath,
    target: legacy.target,
    aspectMode: legacy.aspectMode,
    focus: legacy.focus,
    loopMode: legacy.loopMode,
    sourceFps: legacy.sourceFps,
    sourceRange: { startFrame: 0, endFrameExclusive: 48 },
    upscale: {
      backend: "realesrgan-ncnn-vulkan",
      model: "realesr-animevideov3",
      tile: 384,
      gpuId: "auto",
      aiScale: 2,
      batchSize: 64,
    },
    interpolation: {
      mode: "none",
      factor: 1,
      backend: "rife-ncnn-vulkan",
      model: "rife-v4.6",
      memoryMode: "auto",
      sceneCutMode: "hold",
    },
    encoding: legacy.encoding,
    ...overrides,
  };
}

describe("desktop JobSpec validation", () => {
  it("accepts v2 RIFE 2x and legacy v1 jobs", () => {
    const rife = job({
      interpolation: {
        mode: "rife",
        factor: 2,
        model: "rife-v4.6",
        memoryMode: "uhd",
        sceneCutMode: "hold",
      },
    });
    expect(validateJobRequest({ spec: rife }).spec.version).toBe(2);
    const { interpolation: _interpolation, ...legacy } = job() as JobSpecV2;
    expect(validateJobRequest({ spec: { ...legacy, version: 1 } }).spec.version).toBe(1);
  });

  it("accepts a non-empty v3 source range and rejects malformed ranges", () => {
    expect(validateJobRequest({ spec: jobV3({
      sourceRange: { startFrame: 12, endFrameExclusive: 36 },
    }) }).spec).toMatchObject({
      version: 3,
      sourceRange: { startFrame: 12, endFrameExclusive: 36 },
    });

    for (const sourceRange of [
      { startFrame: -1, endFrameExclusive: 12 },
      { startFrame: 12, endFrameExclusive: 12 },
      { startFrame: 20, endFrameExclusive: 12 },
      { startFrame: 0.5, endFrameExclusive: 12 },
    ]) {
      expect(() => validateJobRequest({ spec: jobV3({ sourceRange }) })).toThrow();
    }
    expect(() => validateJobRequest({
      spec: { ...jobV3(), sourceRange: undefined },
    })).toThrow();
  });

  it("requires a non-empty source range for v4", () => {
    expect(validateJobRequest({ spec: jobV4({
      sourceRange: { startFrame: 12, endFrameExclusive: 36 },
    }) }).spec).toMatchObject({
      version: 4,
      sourceRange: { startFrame: 12, endFrameExclusive: 36 },
    });
    expect(() => validateJobRequest({ spec: { ...jobV4(), sourceRange: undefined } })).toThrow();
  });

  it("rejects source ranges carried by v1 and v2 jobs", () => {
    for (const version of [1, 2] as const) {
      expect(() => validateJobRequest({
        spec: {
          ...job(),
          version,
          sourceRange: { startFrame: 0, endFrameExclusive: 48 },
        },
      })).toThrow();
    }
  });

  it("validates loop-boundary preview controls", () => {
    expect(validateJobRequest({
      spec: jobV3(),
      previewMode: "loop-boundary",
      turn: "start",
    })).toMatchObject({ previewMode: "loop-boundary", turn: "start" });
    expect(() => validateJobRequest({
      spec: jobV3(),
      previewMode: "loop-boundary",
      centerSeconds: 1,
    })).toThrow("中心位置");
    expect(() => validateJobRequest({ spec: jobV3(), turn: "end" })).toThrow("乒乓循环");
    expect(() => validateJobRequest({
      spec: jobV3({ loopMode: "none" }),
      previewMode: "loop-boundary",
      turn: "end",
    })).toThrow("乒乓循环");
    expect(() => validateJobRequest({ spec: jobV3(), previewMode: "unknown" })).toThrow("预览模式");
  });

  it("rejects inconsistent interpolation modes and factors", () => {
    const invalid = job({
      interpolation: {
        mode: "rife",
        factor: 1,
        model: "rife-v4.6",
        memoryMode: "auto",
        sceneCutMode: "hold",
      },
    });
    expect(() => validateJobRequest({ spec: invalid })).toThrow("插帧");
  });

  it("accepts every supported v4 upscale backend/model pair", () => {
    const upscalers = [
      { backend: "lanczos", model: "lanczos" },
      {
        backend: "realesrgan-ncnn-vulkan",
        model: "realesr-animevideov3",
        tile: 384,
        gpuId: "auto",
        aiScale: "auto",
        batchSize: 64,
      },
      { backend: "realesrgan-ncnn-vulkan", model: "realesrgan-x4plus", aiScale: 4 },
    ] satisfies UpscaleSpecV4[];
    for (const upscale of upscalers) {
      expect(() => validateJobRequest({ spec: jobV4({ upscale }) })).not.toThrow();
    }
  });

  it("rejects mismatched v4 upscale engines and backend-specific fields", () => {
    const invalidUpscalers = [
      { backend: "lanczos", model: "realesr-animevideov3" },
      { backend: "realesrgan-ncnn-vulkan", model: "unsupported-model" },
      { backend: "unsupported-backend", model: "realesr-animevideov3" },
      { backend: "lanczos", model: "lanczos", aiScale: 2 },
      { backend: "realesrgan-ncnn-vulkan", model: "realesrgan-x4plus", aiScale: 2 },
    ];
    for (const upscale of invalidUpscalers) {
      expect(() => validateJobRequest({ spec: { ...jobV4(), upscale } })).toThrow();
    }
    expect(() => validateJobRequest({
      spec: { ...jobV4(), upscaleMode: "realesrgan" },
    })).toThrow();
  });

  it("rejects mismatched v4 interpolation engines", () => {
    const invalidInterpolations = [
      { mode: "rife", factor: 2, backend: "rife-ncnn-vulkan", model: "unsupported-model" },
      { mode: "rife", factor: 2, backend: "unsupported-backend", model: "rife-v4.6" },
      { mode: "rife", factor: 1, backend: "rife-ncnn-vulkan", model: "rife-v4.6" },
      { mode: "none", factor: 2, backend: "rife-ncnn-vulkan", model: "rife-v4.6" },
    ];
    for (const interpolation of invalidInterpolations) {
      expect(() => validateJobRequest({
        spec: {
          ...jobV4(),
          interpolation: { ...interpolation, memoryMode: "auto", sceneCutMode: "hold" },
        },
      })).toThrow();
    }
  });

  it("blocks NVENC above 4096 with an aspect-preserving remedy", () => {
    const spec = job({
      target: { width: 5120, height: 3200 },
      encoding: { ...job().encoding, encoder: "h264_nvenc" },
    });
    expect(encoderResolutionDetails(spec)).toEqual({
      encoder: "h264_nvenc",
      requested: { width: 5120, height: 3200 },
      maxDimension: 4096,
      suggestedTarget: { width: 4096, height: 2560 },
      supportedEncoder: "libx264",
    });
    try {
      validateJobRequest({ spec });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "E_ENCODER_UNSUPPORTED_RESOLUTION" });
    }
  });

  it("allows 4096 NVENC and 5K CPU targets", () => {
    expect(() => validateJobRequest({ spec: job({
      target: { width: 4096, height: 3200 },
      encoding: { ...job().encoding, encoder: "h264_nvenc" },
    }) })).not.toThrow();
    expect(() => validateJobRequest({ spec: job({ target: { width: 5120, height: 3200 } }) })).not.toThrow();
    expect(fitWithinDimension({ width: 3200, height: 5120 })).toEqual({ width: 2560, height: 4096 });
  });

  it("accepts reviewed cache settings and rejects malformed limits", () => {
    expect(validateJobRequest({
      spec: job(),
      cachePolicy: "cleanup-on-success",
      cacheLimitBytes: 50 * 1024 ** 3,
    })).toMatchObject({ cachePolicy: "cleanup-on-success" });
    expect(() => validateJobRequest({ spec: job(), cachePolicy: "forever" })).toThrow("缓存策略");
    expect(() => validateJobRequest({ spec: job(), cacheLimitBytes: -1 })).toThrow("缓存上限");
  });
});
