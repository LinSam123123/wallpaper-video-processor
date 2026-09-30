import assert from "node:assert/strict";
import { AppError } from "../src/errors.js";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  frameFileName,
  previewVideo,
  processVideo,
  validatePng,
  type CommandRunner,
} from "../src/index.js";
import { testPng } from "./test-png.js";

const SOURCE_PNG = testPng(16, 10);
const ENHANCED_PNG = testPng(48, 30);

test("AI frames are processed in resumable directory batches and shared across output jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-ai-pipeline-"));
  const cache = join(root, "tools-cache");
  const work = join(root, "work");
  const input = join(root, "source.mp4");
  const output = join(root, "result.mp4");
  const previewOutput = join(root, "preview.mp4");
  await writeFile(input, "source");
  const aiCalls: Array<{ args: string[]; inputCount: number; probe: boolean }> = [];
  const extractionRanges: Array<[number, number]> = [];
  let simulatedOom = false;

  const runner: CommandRunner = async (command, options) => {
    if (command.executable === "ffprobe-stub") {
      const path = command.args.at(-1) ?? "";
      const encoded = path !== input;
      const preview = path.includes("preview");
      const frames = encoded ? (preview ? 8 : 80) : 80;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [{
            index: 0,
            codec_type: "video",
            codec_name: "h264",
            width: encoded ? 48 : 16,
            height: encoded ? 24 : 10,
            sample_aspect_ratio: encoded ? "1:1" : undefined,
            pix_fmt: "yuv420p",
            color_space: "bt709",
            color_primaries: "bt709",
            color_transfer: "bt709",
            color_range: "tv",
            avg_frame_rate: "24/1",
            nb_read_frames: String(frames),
            duration: String(frames / 24),
          }],
          format: { format_name: "mp4", duration: String(frames / 24), size: "10" },
        }),
        stderr: "",
      };
    }

    if (command.executable === "realesrgan-stub") {
      const inputDirectory = command.args[command.args.indexOf("-i") + 1];
      const outputDirectory = command.args[command.args.indexOf("-o") + 1];
      assert.ok(inputDirectory && outputDirectory);
      const inputs = (await readdir(inputDirectory)).filter((name) => name.endsWith(".png"));
      const probe = inputDirectory.includes("tile-probe");
      aiCalls.push({ args: command.args, inputCount: inputs.length, probe });
      const tile = command.args[command.args.indexOf("-t") + 1];
      if (!probe && !simulatedOom && inputs.length === 64 && tile === "384") {
        simulatedOom = true;
        await writeFile(join(outputDirectory, inputs[0] ?? "partial.png"), Buffer.from("partial"));
        throw new AppError("E_PROCESS_FAILED", "Vulkan failure", { stderr: "VK_ERROR_OUT_OF_DEVICE_MEMORY" });
      }
      await mkdir(outputDirectory, { recursive: true });
      for (const name of inputs) await writeFile(join(outputDirectory, name), ENHANCED_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (command.args.some((arg) => arg.includes("blackdetect="))) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    const encodedOutput = command.args.find((arg) => arg.includes(".partial.mp4"));
    if (encodedOutput) {
      await writeFile(encodedOutput, "encoded");
      const frameCount = encodedOutput.includes("preview") ? 8 : 80;
      options?.onStdout?.(`frame=${frameCount}\nprogress=end\n`);
      return { exitCode: 0, stdout: `frame=${frameCount}\nprogress=end\n`, stderr: "" };
    }

    const pngPattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pngPattern) {
      const start = Number(command.args[command.args.indexOf("-start_number") + 1]);
      const filter = command.args[command.args.indexOf("-vf") + 1] ?? "";
      const selectedRange = /between\(n\\,(\d+)\\,(\d+)\)/.exec(filter);
      const end = selectedRange ? Number(selectedRange[2]) : start - 1 + 80;
      const count = end - (start - 1) + 1;
      extractionRanges.push([start - 1, end]);
      await mkdir(dirname(pngPattern), { recursive: true });
      for (let offset = 0; offset < count; offset += 1) {
        await writeFile(join(dirname(pngPattern), frameFileName(start - 1 + offset)), SOURCE_PNG);
      }
      options?.onStdout?.(`frame=${count}\nprogress=end\n`);
      return { exitCode: 0, stdout: `frame=${count}\nprogress=end\n`, stderr: "" };
    }
    throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
  };

  const baseSpec = {
    version: 1,
    inputPath: input,
    outputPath: output,
    target: { width: 48, height: 24 },
    focus: { x: 0.5, y: 0.5 },
    loopMode: "none",
    upscaleMode: "realesrgan",
    model: "realesr-animevideov3",
    tile: 384,
    sourceFps: "auto",
    gpuId: 2,
    aiScale: 3,
    batchSize: 64,
    encoding: {
      codec: "h264",
      encoder: "libx264",
      profile: "high",
      crf: 17,
      preset: "slow",
      pixelFormat: "yuv420p",
      removeAudio: true,
    },
  } as const;
  const options = {
    cacheDirectory: cache,
    workDirectory: work,
    binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub", realesrgan: "realesrgan-stub" },
    runner,
    cachePolicy: "keep-all" as const,
  };

  try {
    const preview = await previewVideo({ ...baseSpec, aspectMode: "cover" }, {
      centerSeconds: 1,
      frameCount: 8,
      outputPath: previewOutput,
    }, options);
    const sharedSource = join(work, "frame-cache", preview.frameCacheKey, "source-frames");
    const sharedEnhanced384 = join(work, "frame-cache", preview.frameCacheKey, "enhanced-frames", "tile-384");
    const sharedEnhanced256 = join(work, "frame-cache", preview.frameCacheKey, "enhanced-frames", "tile-256");
    const previewSentinel = testPng(16, 10, Buffer.from("preview-sentinel"));
    const prefixSentinel = testPng(16, 10, Buffer.from("prefix-sentinel"));
    await writeFile(join(sharedSource, frameFileName(preview.startFrame)), Buffer.from("corrupt-source"));
    await writeFile(join(sharedSource, frameFileName(preview.startFrame + 1)), previewSentinel);
    await writeFile(join(sharedEnhanced384, frameFileName(preview.startFrame + 2)), Buffer.from("corrupt-enhanced"));
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(sharedSource, frameFileName(index)), index === 0 ? prefixSentinel : SOURCE_PNG);
    }
    const processed = await processVideo({ ...baseSpec, aspectMode: "blur-background" }, options);

    assert.equal(preview.actualAiScale, 3);
    assert.equal(processed.actualAiScale, 3);
    assert.equal(preview.frameCacheKey, processed.frameCacheKey);
    assert.notEqual(preview.jobId, processed.jobId);
    assert.equal(processed.media.video.frameCount, 80);
    assert.deepEqual(extractionRanges, [[20, 27], [5, 20], [28, 79]]);
    assert.deepEqual(await readFile(join(sharedSource, frameFileName(preview.startFrame))), SOURCE_PNG);
    assert.deepEqual(await readFile(join(sharedSource, frameFileName(preview.startFrame + 1))), previewSentinel);
    assert.deepEqual(await readFile(join(sharedSource, frameFileName(0))), prefixSentinel);
    assert.equal(await validatePng(
      join(sharedEnhanced256, frameFileName(preview.startFrame + 2)),
      { width: 48, height: 30 },
    ), true);
    const sourceIndices = (await readdir(sharedSource))
      .filter((name) => /^frame_\d{8}\.png$/.test(name))
      .map((name) => Number(name.slice(6, 14)) - 1)
      .sort((left, right) => left - right);
    assert.deepEqual(sourceIndices, Array.from({ length: 80 }, (_, index) => index));
    assert.deepEqual(aiCalls.map((call) => call.inputCount), [1, 8, 1, 64, 64, 16]);
    assert.deepEqual(aiCalls.map((call) => call.probe), [true, false, true, false, false, false]);
    assert.equal(aiCalls[0]?.args[aiCalls[0].args.indexOf("-t") + 1], "384");
    assert.equal(aiCalls[1]?.args[aiCalls[1].args.indexOf("-t") + 1], "384");
    assert.equal(aiCalls[2]?.args[aiCalls[2].args.indexOf("-t") + 1], "384");
    assert.equal(aiCalls[3]?.args[aiCalls[3].args.indexOf("-t") + 1], "384");
    assert.equal(aiCalls[4]?.args[aiCalls[4].args.indexOf("-t") + 1], "256");
    assert.equal(aiCalls[5]?.args[aiCalls[5].args.indexOf("-t") + 1], "256");
    for (const call of aiCalls) {
      assert.ok(call.args.includes("-v"));
      assert.equal(call.args[call.args.indexOf("-j") + 1], "1:2:2");
      assert.equal(call.args[call.args.indexOf("-g") + 1], "2");
      assert.equal(call.args[call.args.indexOf("-s") + 1], "3");
    }
    const caches = await readdir(join(work, "frame-cache"));
    assert.deepEqual(caches, [processed.frameCacheKey]);
    assert.equal(basename(processed.workDirectory), "work");
    const state = JSON.parse(await readFile(join(work, "jobs", processed.jobId, "job-state.json"), "utf8")) as {
      spec: { batchSize: number; gpuId: number; encoding: { encoder: string } };
      spaceBudget: { sameVolume: boolean; workRequiredBytes: number; outputRequiredBytes: number; combinedRequiredBytes: number };
      selectedTile: number;
      completedUpscaleFrames: number[];
      lastError: unknown;
    };
    assert.deepEqual(state.spec, {
      ...baseSpec,
      aspectMode: "blur-background",
      upscaleBackend: "realesrgan-ncnn-vulkan",
      interpolation: {
        backend: "rife-ncnn-vulkan",
        mode: "none",
        factor: 1,
        model: "rife-v4.6",
        memoryMode: "auto",
        sceneCutMode: "hold",
      },
    });
    assert.equal(state.spaceBudget.sameVolume, true);
    assert.equal(state.spaceBudget.combinedRequiredBytes, state.spaceBudget.workRequiredBytes + state.spaceBudget.outputRequiredBytes);
    assert.equal(state.lastError, null);
    assert.equal(state.selectedTile, 256);
    assert.deepEqual(state.completedUpscaleFrames, Array.from({ length: 80 }, (_, index) => index));
    assert.equal((await readdir(sharedEnhanced256)).filter((name) => name.endsWith(".png")).length, 80);
    await assert.rejects(access(sharedEnhanced384));
    await assert.rejects(access(join(work, "jobs", processed.jobId, "tile-probe")));
    assert.deepEqual(await readdir(join(work, "jobs", processed.jobId, "batches")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic Real-ESRGAN mode bypasses AI when the source already covers the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-ai-bypass-"));
  const input = join(root, "source.mp4");
  const output = join(root, "result.mp4");
  const work = join(root, "work");
  await writeFile(input, "source");
  let aiCalls = 0;
  const runner: CommandRunner = async (command, options) => {
    if (command.executable === "ffprobe-stub") {
      const encoded = command.args.at(-1) !== input;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [{
            index: 0,
            codec_type: "video",
            codec_name: "h264",
            width: encoded ? 32 : 64,
            height: encoded ? 20 : 40,
            sample_aspect_ratio: encoded ? "1:1" : undefined,
            pix_fmt: "yuv420p",
            color_space: "bt709",
            color_primaries: "bt709",
            color_transfer: "bt709",
            color_range: "tv",
            avg_frame_rate: "24/1",
            nb_read_frames: "2",
            duration: String(2 / 24),
          }],
          format: { format_name: "mp4", duration: String(2 / 24), size: "10" },
        }),
        stderr: "",
      };
    }
    if (command.executable.includes("realesrgan")) {
      aiCalls += 1;
      throw new Error("Real-ESRGAN must not run for an automatic x1 job");
    }
    if (command.args.some((arg) => arg.includes("blackdetect="))) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const encodedOutput = command.args.find((arg) => arg.includes(".partial.mp4"));
    if (encodedOutput) {
      await writeFile(encodedOutput, "encoded");
      options?.onStdout?.("frame=2\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=2\nprogress=end\n", stderr: "" };
    }
    const pngPattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pngPattern) {
      await mkdir(dirname(pngPattern), { recursive: true });
      for (let index = 0; index < 2; index += 1) {
        await writeFile(join(dirname(pngPattern), frameFileName(index)), testPng(64, 40));
      }
      options?.onStdout?.("frame=2\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=2\nprogress=end\n", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
  };
  try {
    const result = await processVideo({
      version: 1,
      inputPath: input,
      outputPath: output,
      target: { width: 32, height: 20 },
      aspectMode: "cover",
      focus: { x: 0.5, y: 0.5 },
      loopMode: "none",
      upscaleMode: "realesrgan",
      model: "realesr-animevideov3",
      tile: 384,
      sourceFps: "auto",
      aiScale: "auto",
      encoding: {
        codec: "h264",
        encoder: "libx264",
        profile: "high",
        crf: 17,
        preset: "slow",
        pixelFormat: "yuv420p",
        removeAudio: true,
      },
    }, {
      cacheDirectory: join(root, "cache"),
      workDirectory: work,
      binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub", realesrgan: "" },
      runner,
      cachePolicy: "keep-all",
    });
    assert.equal(result.actualAiScale, 1);
    assert.equal(aiCalls, 0);
    await assert.rejects(access(join(work, "frame-cache", result.frameCacheKey, "enhanced-frames")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tile fallback and runtime identity changes discard retained sequences before resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-sequence-runtime-invalidation-"));
  const input = join(root, "source.mp4");
  const output = join(root, "result.mp4");
  const work = join(root, "work");
  const executable = join(root, "realesrgan", "realesrgan.exe");
  const modelDirectory = join(dirname(executable), "models");
  const modelBin = join(modelDirectory, "realesr-animevideov3-x2.bin");
  const oldEnhanced = testPng(32, 20, Buffer.from("old-runtime"));
  const fallbackEnhanced = testPng(32, 20, Buffer.from("fallback-tile"));
  const newEnhanced = testPng(32, 20, Buffer.from("new-runtime"));
  let enhancedGeneration: "old" | "fallback" | "new" = "old";
  let oomAtTile384 = false;
  let failEncode = true;
  let encodedSequence: Buffer[] = [];
  await Promise.all([
    writeFile(input, "source"),
    mkdir(modelDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(executable, "realesrgan executable"),
    writeFile(modelBin, "old model"),
    writeFile(join(modelDirectory, "realesr-animevideov3-x2.param"), "model parameters"),
  ]);

  const runner: CommandRunner = async (command, options) => {
    if (command.executable === "ffprobe-stub") {
      const encoded = command.args.at(-1) !== input;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [{
            index: 0,
            codec_type: "video",
            codec_name: "h264",
            width: encoded ? 32 : 16,
            height: encoded ? 20 : 10,
            sample_aspect_ratio: encoded ? "1:1" : undefined,
            pix_fmt: "yuv420p",
            color_space: "bt709",
            color_primaries: "bt709",
            color_transfer: "bt709",
            color_range: "tv",
            avg_frame_rate: "24/1",
            nb_read_frames: "3",
            duration: String(3 / 24),
          }],
          format: { format_name: "mp4", duration: String(3 / 24), size: "10" },
        }),
        stderr: "",
      };
    }
    if (command.args.some((arg) => arg.includes("blackdetect=d=0.04:pic_th=0.98:pix_th=0.10"))) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.executable === executable) {
      const inputDirectory = command.args[command.args.indexOf("-i") + 1] as string;
      const outputDirectory = command.args[command.args.indexOf("-o") + 1] as string;
      const frames = (await readdir(inputDirectory)).filter((name) => name.endsWith(".png"));
      const tile = command.args[command.args.indexOf("-t") + 1];
      if (oomAtTile384 && tile === "384" && !inputDirectory.includes("tile-probe")) {
        throw new AppError("E_PROCESS_FAILED", "simulated OOM", { stderr: "VK_ERROR_OUT_OF_DEVICE_MEMORY" });
      }
      await mkdir(outputDirectory, { recursive: true });
      for (const name of frames) {
        const contents = enhancedGeneration === "old"
          ? oldEnhanced
          : enhancedGeneration === "fallback" ? fallbackEnhanced : newEnhanced;
        await writeFile(join(outputDirectory, name), contents);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const encodedOutput = command.args.find((arg) => arg.includes(".partial.mp4"));
    if (encodedOutput) {
      const sequencePattern = command.args[command.args.indexOf("-i") + 1] as string;
      encodedSequence = await Promise.all(Array.from({ length: 3 }, (_, index) =>
        readFile(join(dirname(sequencePattern), frameFileName(index)))));
      await writeFile(encodedOutput, "encoded");
      if (failEncode) throw new AppError("E_PROCESS_FAILED", "simulated encoder failure");
      options?.onStdout?.("frame=3\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=3\nprogress=end\n", stderr: "" };
    }
    const pngPattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pngPattern) {
      await mkdir(dirname(pngPattern), { recursive: true });
      for (let index = 0; index < 3; index += 1) {
        await writeFile(join(dirname(pngPattern), frameFileName(index)), SOURCE_PNG);
      }
      options?.onStdout?.("frame=3\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=3\nprogress=end\n", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
  };
  const spec = {
    version: 1,
    inputPath: input,
    outputPath: output,
    target: { width: 32, height: 20 },
    aspectMode: "cover",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "none",
    upscaleMode: "realesrgan",
    model: "realesr-animevideov3",
    tile: 384,
    sourceFps: "auto",
    aiScale: 2,
    batchSize: 32,
    encoding: {
      codec: "h264",
      encoder: "libx264",
      profile: "high",
      crf: 17,
      preset: "slow",
      pixelFormat: "yuv420p",
      removeAudio: true,
    },
  } as const;
  const options = {
    cacheDirectory: join(root, "cache"),
    workDirectory: work,
    binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub", realesrgan: executable },
    runner,
    cachePolicy: "keep-all" as const,
  };

  try {
    await assert.rejects(processVideo(spec, options), (error) =>
      error instanceof AppError && error.code === "E_PROCESS_FAILED");
    assert.equal(encodedSequence.every((frame) => frame.equals(oldEnhanced)), true);
    const [jobId] = await readdir(join(work, "jobs"));
    assert.ok(jobId);
    const firstState = JSON.parse(await readFile(join(work, "jobs", jobId, "job-state.json"), "utf8")) as {
      frameCacheKey: string;
      selectedTile: number;
    };

    await rm(join(
      work,
      "frame-cache",
      firstState.frameCacheKey,
      "enhanced-frames",
      "tile-384",
      frameFileName(0),
    ));
    enhancedGeneration = "fallback";
    oomAtTile384 = true;
    await assert.rejects(processVideo(spec, options), (error) =>
      error instanceof AppError && error.code === "E_PROCESS_FAILED");
    assert.equal(encodedSequence.every((frame) => frame.equals(fallbackEnhanced)), true);
    const fallbackState = JSON.parse(await readFile(join(work, "jobs", jobId, "job-state.json"), "utf8")) as {
      frameCacheKey: string;
      selectedTile: number;
    };
    assert.equal(fallbackState.frameCacheKey, firstState.frameCacheKey);
    assert.equal(fallbackState.selectedTile, 256);

    enhancedGeneration = "new";
    oomAtTile384 = false;
    failEncode = false;
    await writeFile(modelBin, "new model with a different identity");
    const result = await processVideo(spec, options);
    assert.notEqual(result.frameCacheKey, firstState.frameCacheKey);
    assert.equal(encodedSequence.every((frame) => frame.equals(newEnhanced)), true);

    await writeFile(modelBin, "third model identity must invalidate the completed output marker");
    await assert.rejects(processVideo(spec, options), (error) =>
      error instanceof AppError && error.code === "E_OUTPUT_EXISTS");
    const invalidatedState = JSON.parse(await readFile(join(work, "jobs", jobId, "job-state.json"), "utf8")) as {
      phase: string;
      verifiedOutput?: unknown;
    };
    assert.equal(invalidatedState.phase, "prepare");
    assert.equal(invalidatedState.verifiedOutput, undefined);

    // A same-size replacement with the original mtime must still invalidate
    // the frame cache; metadata-only identities are insufficient for weights.
    const modelStat = await stat(modelBin);
    const sameSizeModel = "x".repeat(modelStat.size);
    await writeFile(modelBin, sameSizeModel);
    await utimes(modelBin, modelStat.atime, modelStat.mtime);
    const restoredModelStat = await stat(modelBin);
    assert.equal(Math.round(restoredModelStat.mtimeMs), Math.round(modelStat.mtimeMs));
    const sameSizeResult = await processVideo({ ...spec, outputPath: join(root, "same-size-result.mp4") }, options);
    assert.notEqual(sameSizeResult.frameCacheKey, firstState.frameCacheKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
