import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFfmpegVideoFilter,
  cacheKey,
  computeAspectLayout,
  durationForFrames,
  estimateDiskUsage,
  frameCacheKey,
  createJobId,
  jobSpecIdentity,
  interpolatedForwardFrameCount,
  interpolatedOutputFrameCount,
  interpolationFrameMap,
  makeProgressEvent,
  missingFrameRanges,
  outputFrameCount,
  parseJobSpec,
  parseSceneCutBoundaries,
  parseVerificationExpectation,
  pingPongIndices,
  projectFrameStorage,
  rifeDirectoryArguments,
  selectAiScale,
  tileFallbackOrder,
  videoEncoderArguments,
} from "../src/index.js";

test("ping-pong indices omit duplicated turn and loop endpoints", () => {
  assert.deepEqual(pingPongIndices(1), [0]);
  assert.deepEqual(pingPongIndices(2), [0, 1]);
  assert.deepEqual(pingPongIndices(5), [0, 1, 2, 3, 4, 3, 2, 1]);
  const indices = pingPongIndices(720);
  assert.equal(indices.length, 1438);
  assert.deepEqual(indices.slice(716, 723), [716, 717, 718, 719, 718, 717, 716]);
  assert.equal(indices.at(-1), 1);
  assert.equal(outputFrameCount(720, "pingpong"), 1438);
  assert.equal(durationForFrames(1438, 24), 59.916666666666664);
});

test("missing source frames are grouped into contiguous 720-frame ranges", () => {
  const prefixAndPreview = [
    ...Array.from({ length: 100 }, (_, index) => index),
    ...Array.from({ length: 48 }, (_, index) => 336 + index),
  ];
  assert.deepEqual(missingFrameRanges(720, prefixAndPreview), [
    { startFrame: 100, endFrame: 335, frameCount: 236 },
    { startFrame: 384, endFrame: 719, frameCount: 336 },
  ]);
  assert.deepEqual(missingFrameRanges(720, Array.from({ length: 48 }, (_, index) => 336 + index)), [
    { startFrame: 0, endFrame: 335, frameCount: 336 },
    { startFrame: 384, endFrame: 719, frameCount: 336 },
  ]);
  assert.deepEqual(missingFrameRanges(3, [0, 1, 2]), []);
});

test("JobSpec parser supplies fixed v1 defaults and rejects unsafe dimensions", () => {
  const spec = parseJobSpec({
    inputPath: "input.mp4",
    outputPath: "output.mp4",
    target: { width: 2560, height: 1600 },
  });
  assert.equal(spec.version, 1);
  assert.equal(spec.aspectMode, "cover");
  assert.equal(spec.loopMode, "pingpong");
  assert.equal(spec.upscaleMode, "realesrgan");
  assert.deepEqual(spec.focus, { x: 0.5, y: 0.5 });
  assert.equal(spec.encoding.crf, 17);
  assert.equal(spec.encoding.encoder, "libx264");
  assert.equal(spec.gpuId, "auto");
  assert.equal(spec.aiScale, "auto");
  assert.equal(spec.batchSize, 64);
  assert.equal(spec.upscaleBackend, "realesrgan-ncnn-vulkan");
  assert.deepEqual(spec.interpolation, {
    backend: "rife-ncnn-vulkan",
    mode: "none",
    factor: 1,
    model: "rife-v4.6",
    memoryMode: "auto",
    sceneCutMode: "hold",
  });
  assert.throws(() => parseJobSpec({
    inputPath: "input.mp4",
    outputPath: "output.mp4",
    target: { width: 2559, height: 1600 },
  }), /must be even/);
  assert.throws(() => parseJobSpec({
    inputPath: "input.mp4",
    outputPath: "output.mp4",
    target: { width: 2560, height: 1600 },
    focus: { x: 1.1, y: 0.5 },
  }), /normalized/);
});

test("JobSpec v2 normalizes RIFE x2 and rejects inconsistent interpolation modes", () => {
  const spec = parseJobSpec({
    version: 2,
    inputPath: "input.mp4",
    outputPath: "output.mp4",
    target: { width: 2560, height: 1600 },
    interpolation: { mode: "rife" },
  });
  assert.deepEqual(spec.interpolation, {
    backend: "rife-ncnn-vulkan",
    mode: "rife",
    factor: 2,
    model: "rife-v4.6",
    memoryMode: "auto",
    sceneCutMode: "hold",
  });
  assert.throws(() => parseJobSpec({
    version: 2,
    inputPath: "input.mp4",
    outputPath: "output.mp4",
    target: { width: 2560, height: 1600 },
    interpolation: { mode: "rife", factor: 1 },
  }), /requires factor 2/);
});

test("RIFE frame math preserves duration for one, two, and 720 source frames", () => {
  assert.equal(interpolatedForwardFrameCount(1, 2), 1);
  assert.equal(interpolatedOutputFrameCount(1, "pingpong", 2), 2);
  assert.equal(interpolatedOutputFrameCount(1, "none", 2), 2);
  assert.equal(durationForFrames(2, 48), durationForFrames(1, 24));
  assert.equal(interpolatedOutputFrameCount(1, "pingpong", 1), 1);
  assert.equal(interpolatedForwardFrameCount(2, 2), 3);
  assert.equal(interpolatedOutputFrameCount(2, "pingpong", 2), 4);
  assert.equal(interpolatedForwardFrameCount(720, 2), 1439);
  assert.equal(interpolatedOutputFrameCount(720, "pingpong", 2), 2876);
  assert.equal(durationForFrames(2876, 48), durationForFrames(1438, 24));
  assert.equal(interpolatedOutputFrameCount(720, "none", 2), 1440);
  assert.equal(durationForFrames(1440, 48), durationForFrames(720, 24));
});

test("interpolation mapping holds detected cuts and RIFE arguments are deterministic", () => {
  assert.deepEqual(interpolationFrameMap([0, 1, 2], { includeTail: true, sceneCutsAfter: [1] }), [
    { outputIndex: 0, kind: "source", sourceIndex: 0 },
    { outputIndex: 1, kind: "interpolated", sourceIndex: 0, nextSourceIndex: 1 },
    { outputIndex: 2, kind: "source", sourceIndex: 1 },
    { outputIndex: 3, kind: "hold", sourceIndex: 1, nextSourceIndex: 2 },
    { outputIndex: 4, kind: "source", sourceIndex: 2 },
    { outputIndex: 5, kind: "hold", sourceIndex: 2 },
  ]);
  assert.equal(
    interpolationFrameMap([0, 1], { holdBoundariesAfter: [0] })[1]?.kind,
    "hold",
  );
  assert.deepEqual(parseSceneCutBoundaries("lavfi.scd.time=0.083333\nlavfi.scd.time=0.083333", 24, 10), [1]);
  const args = rifeDirectoryArguments({
    inputDirectory: "input",
    outputDirectory: "output",
    inputFrameCount: 3,
    interpolation: { mode: "rife", factor: 2, model: "rife-v4.6", memoryMode: "uhd", sceneCutMode: "hold" },
    source: { width: 1920, height: 1080 },
    gpuId: 2,
  });
  assert.equal(args[args.indexOf("-n") + 1], "6");
  assert.equal(args[args.indexOf("-m") + 1], "rife-v4.6");
  assert.equal(args[args.indexOf("-f") + 1], "%08d.png");
  assert.equal(args[args.indexOf("-g") + 1], "2");
  assert.ok(args.includes("-u"));
});

test("normalized v1 identities stay compatible while v0.3.1 frame caches use a new schema key", () => {
  const spec = parseJobSpec({
    version: 1,
    inputPath: "input.mp4",
    outputPath: "output.mp4",
    target: { width: 2560, height: 1600 },
  });
  const { interpolation: _interpolation, ...legacySpec } = spec;
  const input = { path: "D:\\input.mp4", size: 123, modifiedMs: 456 };
  assert.deepEqual(jobSpecIdentity(spec), legacySpec);
  assert.equal(createJobId(spec, input), cacheKey({ spec: legacySpec, input }).slice(0, 20));
  const legacyFrameKeyInput = {
    input,
    sourceFps: 24,
    upscaleMode: "realesrgan" as const,
    model: "realesr-animevideov3",
    actualScale: 3,
  };
  assert.notEqual(frameCacheKey({ ...legacyFrameKeyInput, interpolation: spec.interpolation }), cacheKey(legacyFrameKeyInput));
});

test("verification expectations accept only square-pixel SAR", () => {
  assert.deepEqual(parseVerificationExpectation({
    width: 2560,
    height: 1600,
    sampleAspectRatio: "1:1",
  }), {
    width: 2560,
    height: 1600,
    sampleAspectRatio: "1:1",
  });
  assert.throws(
    () => parseVerificationExpectation({ sampleAspectRatio: "64:45" }),
    /sampleAspectRatio must be 1:1/,
  );
});

test("AI scale selection uses framing requirements and model capabilities", () => {
  const source = { width: 1136, height: 800 };
  const target = { width: 2560, height: 1600 };
  assert.equal(selectAiScale(source, target, "cover", "realesr-animevideov3"), 2);
  assert.equal(selectAiScale(source, target, "blur-background", "realesr-animevideov3"), 2);
  assert.equal(selectAiScale(source, target, "contain", "realesr-animevideov3"), 2);
  assert.equal(selectAiScale(source, { width: 3000, height: 2000 }, "cover", "realesr-animevideov3"), 3);
  assert.equal(selectAiScale(source, target, "contain", "realesrgan-x4plus"), 4);
  assert.equal(selectAiScale({ width: 3840, height: 2160 }, target, "cover", "realesr-animevideov3"), 1);
  assert.equal(selectAiScale({ width: 3840, height: 2160 }, target, "cover", "realesr-animevideov3", 2), 2);
  assert.throws(() => selectAiScale(source, target, "cover", "realesrgan-x4plus", 3), /does not support/);
});

test("shared frame cache keys exclude output and framing concerns", () => {
  const base = {
    input: { path: "D:\\source.mp4", size: 123, modifiedMs: 456 },
    sourceFps: 24,
    upscaleMode: "realesrgan" as const,
    model: "realesr-animevideov3",
    actualScale: 3,
  };
  assert.equal(frameCacheKey(base), frameCacheKey({ ...base }));
  assert.notEqual(frameCacheKey(base), frameCacheKey({ ...base, actualScale: 2 }));
  assert.notEqual(frameCacheKey(base), frameCacheKey({ ...base, model: "realesrgan-x4plus" }));
  assert.notEqual(frameCacheKey(base), frameCacheKey({ ...base, requestedTile: 256 }));
  assert.notEqual(frameCacheKey(base), frameCacheKey({ ...base, runtimeIdentity: { realesrgan: "new-build" } }));
  assert.notEqual(frameCacheKey(base), frameCacheKey({ ...base, sceneDetectorRevision: "next-detector" }));
});

test("storage projections subtract existing bytes and encoder args are mode-specific", () => {
  const projected = projectFrameStorage(Array(8).fill(10), 100, 10_000);
  assert.deepEqual(projected, {
    existingBytes: 80,
    estimatedTotalBytes: 1_500,
    remainingBytes: 1_420,
    frameCount: 8,
    measured: true,
  });
  const complete = projectFrameStorage([10, 20], 2, 10_000);
  assert.equal(complete.remainingBytes, 0);
  const x264 = videoEncoderArguments({
    codec: "h264", encoder: "libx264", profile: "high", crf: 17, preset: "slow", pixelFormat: "yuv420p", removeAudio: true,
  });
  const nvenc = videoEncoderArguments({
    codec: "h264", encoder: "h264_nvenc", profile: "high", crf: 19, preset: "slower", pixelFormat: "yuv420p", removeAudio: true,
  });
  assert.deepEqual(x264.slice(0, 2), ["-c:v", "libx264"]);
  assert.ok(x264.includes("-crf"));
  assert.deepEqual(nvenc.slice(0, 2), ["-c:v", "h264_nvenc"]);
  assert.ok(nvenc.includes("p7"));
  assert.ok(nvenc.includes("-cq"));
});

test("aspect layout preserves aspect ratio and applies normalized focus", () => {
  const cover = computeAspectLayout(
    { width: 1136, height: 800 },
    { width: 2560, height: 1600 },
    "cover",
    { x: 1, y: 0.5 },
  );
  assert.equal(cover.scaledWidth, 2560);
  assert.equal(cover.scaledHeight, 1803);
  assert.equal(cover.cropY, 102);
  const contain = computeAspectLayout(
    { width: 1136, height: 800 },
    { width: 2560, height: 1600 },
    "contain",
  );
  assert.equal(contain.scaledWidth, 2272);
  assert.equal(contain.scaledHeight, 1600);
  assert.equal(contain.padX, 144);
});

test("FFmpeg filters provide each supported framing mode", () => {
  const target = { width: 2560, height: 1600 };
  const cover = buildFfmpegVideoFilter("cover", target);
  const contain = buildFfmpegVideoFilter("contain", target);
  assert.match(cover, /crop=2560:1600/);
  assert.match(contain, /pad=2560:1600/);
  assert.match(cover, /setsar=1,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709$/);
  assert.match(contain, /setsar=1,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709$/);
  const blur = buildFfmpegVideoFilter("blur-background", target);
  assert.match(blur, /split=2/);
  assert.match(blur, /boxblur=/);
  assert.match(blur, /overlay=/);
  assert.match(blur, /setsar=1,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709$/);
});

test("disk estimates, cache keys, tile fallback, and ETA are deterministic", () => {
  const estimate = estimateDiskUsage({
    sourceWidth: 1136,
    sourceHeight: 800,
    targetWidth: 2560,
    targetHeight: 1600,
    sourceFrameCount: 720,
    loopMode: "pingpong",
    upscaleMode: "realesrgan",
  });
  assert.ok(estimate.totalBytes > 40_000_000_000);
  assert.equal(cacheKey({ b: 2, a: 1 }), cacheKey({ a: 1, b: 2 }));
  assert.deepEqual(tileFallbackOrder(0), [0, 384, 256, 128, 64, 32]);
  assert.deepEqual(tileFallbackOrder(384), [384, 256, 128, 64, 32]);
  assert.deepEqual(tileFallbackOrder(256), [256, 128, 64, 32]);
  assert.deepEqual(tileFallbackOrder(64), [64, 32]);
  assert.deepEqual(makeProgressEvent({
    jobId: "job",
    phase: "encode",
    current: 25,
    total: 100,
    startedAtMs: 0,
    nowMs: 1_000,
    message: "encoding",
  }), {
    jobId: "job",
    phase: "encode",
    current: 25,
    total: 100,
    percent: 25,
    etaMs: 3_000,
    message: "encoding",
  });
});
