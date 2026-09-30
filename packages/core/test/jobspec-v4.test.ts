import assert from "node:assert/strict";
import test from "node:test";
import {
  JOB_SPEC_VERSION,
  SOURCE_RANGE_JOB_SPEC_VERSION,
  SUPPORTED_JOB_SPEC_VERSIONS,
  parseJobSpec,
} from "../src/index.js";

function baseV4(): Record<string, unknown> {
  return {
    version: 4,
    inputPath: "input.mp4",
    outputPath: "output.mp4",
    target: { width: 2560, height: 1600 },
    aspectMode: "cover",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "pingpong",
    sourceFps: "auto",
    sourceRange: { startFrame: 12, endFrameExclusive: 48 },
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
    encoding: {
      codec: "h264",
      encoder: "libx264",
      profile: "high",
      crf: 17,
      preset: "slow",
      pixelFormat: "yuv420p",
      removeAudio: true,
    },
  };
}

test("JobSpec version constants expose every parser-compatible version", () => {
  assert.equal(SOURCE_RANGE_JOB_SPEC_VERSION, 3);
  assert.equal(JOB_SPEC_VERSION, 4);
  assert.deepEqual(SUPPORTED_JOB_SPEC_VERSIONS, [1, 2, 3, 4]);
});

test("JobSpec v4 flattens Real-ESRGAN and ncnn RIFE without losing concrete backends", () => {
  const spec = parseJobSpec(baseV4());
  assert.equal(spec.version, 4);
  assert.deepEqual(spec.sourceRange, { startFrame: 12, endFrameExclusive: 48 });
  assert.equal(spec.upscaleMode, "realesrgan");
  assert.equal(spec.upscaleBackend, "realesrgan-ncnn-vulkan");
  assert.equal(spec.model, "realesr-animevideov3");
  assert.equal(spec.tile, 384);
  assert.equal(spec.gpuId, "auto");
  assert.equal(spec.aiScale, 2);
  assert.equal(spec.batchSize, 64);
  assert.deepEqual(spec.interpolation, {
    backend: "rife-ncnn-vulkan",
    mode: "none",
    factor: 1,
    model: "rife-v4.6",
    memoryMode: "auto",
    sceneCutMode: "hold",
  });
  assert.equal("upscale" in spec, false);
});

test("JobSpec v4 preserves the standard x4plus model and its fixed scale", () => {
  const spec = parseJobSpec({
    ...baseV4(),
    upscale: {
      backend: "realesrgan-ncnn-vulkan",
      model: "realesrgan-x4plus",
      aiScale: 4,
    },
  });
  assert.equal(spec.model, "realesrgan-x4plus");
  assert.equal(spec.aiScale, 4);
  assert.throws(() => parseJobSpec({
    ...baseV4(),
    upscale: {
      backend: "realesrgan-ncnn-vulkan",
      model: "realesrgan-x4plus",
      aiScale: 2,
    },
  }), /only supported at x4/);
});

test("JobSpec v4 normalizes Lanczos to the legacy pipeline fields", () => {
  const lanczos = parseJobSpec({
    ...baseV4(),
    upscale: { backend: "lanczos", model: "lanczos" },
  });
  assert.equal(lanczos.upscaleMode, "lanczos");
  assert.equal(lanczos.upscaleBackend, "lanczos");
  assert.equal(lanczos.model, "lanczos");
  assert.equal(lanczos.tile, 0);
});
test("JobSpec v4 requires a source range and explicit nested engines", () => {
  const base = baseV4();
  assert.throws(() => parseJobSpec({ ...base, sourceRange: undefined }), /sourceRange must be an object/);
  assert.throws(() => parseJobSpec({ ...base, upscale: undefined }), /upscale must be an object/);
  assert.throws(() => parseJobSpec({ ...base, interpolation: undefined }), /interpolation must be an object/);
  assert.throws(
    () => parseJobSpec({ ...base, upscaleMode: "realesrgan" }),
    /JobSpec v4 does not support upscaleMode/,
  );
});

test("JobSpec v4 rejects mismatched upscale backend and model combinations", () => {
  const invalid = [
    { backend: "lanczos", model: "realesr-animevideov3" },
    { backend: "realesrgan-ncnn-vulkan", model: "unsupported-model" },
    { backend: "unsupported-backend", model: "realesr-animevideov3" },
  ];
  for (const upscale of invalid) {
    assert.throws(() => parseJobSpec({ ...baseV4(), upscale }), /upscale/);
  }
  assert.throws(
    () => parseJobSpec({
      ...baseV4(),
      upscale: { backend: "lanczos", model: "lanczos", aiScale: 2 },
    }),
    /unsupported fields: aiScale/,
  );
});

test("JobSpec v4 rejects mismatched interpolation backend, model, and factor combinations", () => {
  const invalidEngines = [
    { backend: "rife-ncnn-vulkan", model: "unsupported-model" },
    { backend: "unsupported-backend", model: "rife-v4.6" },
  ];
  for (const engine of invalidEngines) {
    assert.throws(() => parseJobSpec({
      ...baseV4(),
      interpolation: {
        mode: "rife",
        factor: 2,
        ...engine,
        memoryMode: "auto",
        sceneCutMode: "hold",
      },
    }), /interpolation/);
  }
  assert.throws(() => parseJobSpec({
    ...baseV4(),
    interpolation: {
      mode: "rife",
      factor: 1,
      backend: "rife-ncnn-vulkan",
      model: "rife-v4.6",
      memoryMode: "auto",
      sceneCutMode: "hold",
    },
  }), /requires factor 2/);
  assert.throws(() => parseJobSpec({
    ...baseV4(),
    interpolation: {
      mode: "none",
      factor: 2,
      backend: "rife-ncnn-vulkan",
      model: "rife-v4.6",
      memoryMode: "auto",
      sceneCutMode: "hold",
    },
  }), /requires factor 1/);
});

test("JobSpec v1-v3 retain legacy input behavior and normalize to ncnn backends", () => {
  const common = {
    inputPath: "input.mp4",
    outputPath: "output.mp4",
    target: { width: 2560, height: 1600 },
    upscaleMode: "realesrgan",
    model: "realesr-animevideov3",
    tile: 384,
  };
  const v1 = parseJobSpec({ ...common, gpuId: null });
  const v2 = parseJobSpec({ ...common, version: 2, interpolation: { mode: "rife" } });
  const v3 = parseJobSpec({
    ...common,
    version: 3,
    sourceRange: { startFrame: 0, endFrameExclusive: 10 },
    interpolation: {
      mode: "rife",
      model: "rife-v4.6",
    },
  });
  for (const spec of [v1, v2, v3]) {
    assert.equal(spec.upscaleBackend, "realesrgan-ncnn-vulkan");
    assert.equal(spec.interpolation.backend, "rife-ncnn-vulkan");
    assert.equal(spec.interpolation.model, "rife-v4.6");
  }
  assert.equal(v1.version, 1);
  assert.equal(v1.gpuId, "auto");
  assert.equal(v2.version, 2);
  assert.equal(v3.version, 3);
});
