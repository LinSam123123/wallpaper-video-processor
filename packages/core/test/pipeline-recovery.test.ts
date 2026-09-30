import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  AppError,
  frameFileName,
  processVideo,
  type CommandRunner,
  type JobSpec,
  type ProgressEvent,
} from "../src/index.js";
import { testPng } from "./test-png.js";

const interruptionModes = ["failed", "cancelled"] as const;

for (const mode of interruptionModes) {
  test(`${mode} encode retains resumable sequence and removes partial output`, async () => {
    const root = await mkdtemp(join(tmpdir(), `wallpaper-${mode}-encode-`));
    const cache = join(root, "cache");
    const work = join(root, "work");
    const input = join(root, "source.mp4");
    const output = join(root, "result.mp4");
    const controller = new AbortController();
    let partialOutput = "";
    await writeFile(input, "source");

    const runner: CommandRunner = async (command, options) => {
      if (command.executable === "ffprobe-stub") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{
              index: 0,
              codec_type: "video",
              codec_name: "h264",
              width: 16,
              height: 10,
              avg_frame_rate: "24/1",
              nb_read_frames: "3",
              duration: String(3 / 24),
            }],
            format: { format_name: "mp4", duration: String(3 / 24), size: "10" },
          }),
          stderr: "",
        };
      }
      const encodedOutput = command.args.find((arg) => arg.includes(".partial.mp4"));
      if (encodedOutput) {
        partialOutput = encodedOutput;
        await writeFile(encodedOutput, "incomplete encode");
        if (mode === "failed") throw new AppError("E_PROCESS_FAILED", "encoder failed");
        options?.onStdout?.("frame=4\nprogress=end\n");
        controller.abort();
        return { exitCode: 0, stdout: "frame=4\nprogress=end\n", stderr: "" };
      }
      const pngPattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
      if (pngPattern) {
        await mkdir(dirname(pngPattern), { recursive: true });
        for (let index = 0; index < 3; index += 1) {
          await writeFile(join(dirname(pngPattern), frameFileName(index)), testPng(16, 10));
        }
        options?.onStdout?.("frame=3\nprogress=end\n");
        return { exitCode: 0, stdout: "frame=3\nprogress=end\n", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
    };

    const spec: JobSpec = {
      version: 1,
      inputPath: input,
      outputPath: output,
      target: { width: 32, height: 20 },
      aspectMode: "contain",
      focus: { x: 0.5, y: 0.5 },
      loopMode: "pingpong",
      upscaleMode: "lanczos",
      model: "realesr-animevideov3",
      tile: 384,
      sourceFps: "auto",
      encoding: {
        codec: "h264",
        profile: "high",
        crf: 17,
        preset: "slow",
        pixelFormat: "yuv420p",
        removeAudio: true,
      },
    };

    try {
      await assert.rejects(
        processVideo(spec, {
          cacheDirectory: cache,
          workDirectory: work,
          binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
          runner,
          signal: controller.signal,
        }),
        (error) => error instanceof AppError
          && error.code === (mode === "failed" ? "E_PROCESS_FAILED" : "E_CANCELLED"),
      );
      assert.notEqual(partialOutput, "");
      await assert.rejects(access(partialOutput));
      await assert.rejects(access(output));
      const jobs = await readdir(join(work, "jobs"));
      assert.equal(jobs.length, 1);
      const sequence = await readdir(join(work, "jobs", jobs[0] as string, "sequence"));
      assert.equal(sequence.filter((name) => name.endsWith(".png")).length, 4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("cancelled encode resumes with cached extraction, upscale, and sequence before full verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-cancel-resume-"));
  const cache = join(root, "cache");
  const work = join(root, "work");
  const input = join(root, "source.mp4");
  const output = join(root, "result.mp4");
  const firstController = new AbortController();
  const sourcePng = testPng(16, 10);
  const enhancedPng = testPng(32, 20);
  const sourceSentinel = testPng(16, 10, Buffer.from("source-resume-sentinel"));
  const enhancedSentinel = testPng(32, 20, Buffer.from("upscale-resume-sentinel"));
  const sequenceSentinel = testPng(32, 20, Buffer.from("sequence-resume-sentinel"));
  let extractionCalls = 0;
  let upscaleCalls = 0;
  let encodeCalls = 0;
  let fullDecodeCalls = 0;
  let sequenceSentinelPath = "";
  await writeFile(input, "source");

  const runner: CommandRunner = async (command, options) => {
    if (command.executable === "ffprobe-stub") {
      const path = command.args.at(-1) ?? "";
      const encoded = path !== input;
      const frameCount = encoded ? 4 : 3;
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
            r_frame_rate: "24/1",
            nb_read_frames: String(frameCount),
            duration: String(frameCount / 24),
          }],
          format: { format_name: "mp4", duration: String(frameCount / 24), size: "10" },
        }),
        stderr: "",
      };
    }
    if (command.executable === "realesrgan-stub") {
      upscaleCalls += 1;
      const inputDirectory = command.args[command.args.indexOf("-i") + 1];
      const outputDirectory = command.args[command.args.indexOf("-o") + 1];
      assert.ok(inputDirectory && outputDirectory);
      await mkdir(outputDirectory, { recursive: true });
      for (const name of (await readdir(inputDirectory)).filter((entry) => entry.endsWith(".png"))) {
        await writeFile(join(outputDirectory, name), enhancedPng);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.args.some((arg) => arg.includes("blackdetect="))) {
      fullDecodeCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const encodedOutput = command.args.at(-1);
    if (encodedOutput?.includes(".partial.mp4")) {
      encodeCalls += 1;
      if (encodeCalls === 1) {
        await writeFile(encodedOutput, "incomplete encode");
        options?.onStdout?.("frame=4\nprogress=end\n");
        firstController.abort();
        return { exitCode: 0, stdout: "frame=4\nprogress=end\n", stderr: "" };
      }
      assert.notEqual(sequenceSentinelPath, "");
      assert.deepEqual(await readFile(sequenceSentinelPath), sequenceSentinel);
      await writeFile(encodedOutput, "encoded");
      options?.onStdout?.("frame=4\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=4\nprogress=end\n", stderr: "" };
    }
    const pngPattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pngPattern) {
      extractionCalls += 1;
      await mkdir(dirname(pngPattern), { recursive: true });
      for (let index = 0; index < 3; index += 1) {
        await writeFile(join(dirname(pngPattern), frameFileName(index)), sourcePng);
      }
      options?.onStdout?.("frame=3\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=3\nprogress=end\n", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
  };

  const spec: JobSpec = {
    version: 4,
    inputPath: input,
    outputPath: output,
    sourceRange: { startFrame: 0, endFrameExclusive: 3 },
    target: { width: 32, height: 20 },
    aspectMode: "contain",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "pingpong",
    upscale: {
      backend: "realesrgan-ncnn-vulkan",
      model: "realesr-animevideov3",
      tile: 384,
      aiScale: 2,
      batchSize: 32,
    },
    sourceFps: "auto",
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
  const options = {
    cacheDirectory: cache,
    workDirectory: work,
    binaries: {
      ffmpeg: "ffmpeg-stub",
      ffprobe: "ffprobe-stub",
      realesrgan: "realesrgan-stub",
    },
    runner,
    cachePolicy: "keep-all" as const,
  };

  try {
    await assert.rejects(
      processVideo(spec, { ...options, signal: firstController.signal }),
      (error) => error instanceof AppError && error.code === "E_CANCELLED",
    );
    assert.equal(extractionCalls, 1);
    assert.equal(upscaleCalls, 2);
    assert.equal(encodeCalls, 1);
    assert.equal(fullDecodeCalls, 0);
    await assert.rejects(access(output));

    const jobs = await readdir(join(work, "jobs"));
    assert.equal(jobs.length, 1);
    const jobDirectory = join(work, "jobs", jobs[0] as string);
    const state = JSON.parse(await readFile(join(jobDirectory, "job-state.json"), "utf8")) as {
      phase: string;
      frameCacheKey: string;
      selectedTile: number;
    };
    assert.equal(state.phase, "encode");
    assert.equal(state.selectedTile, 384);
    const sourceSentinelPath = join(work, "frame-cache", state.frameCacheKey, "source-frames", frameFileName(0));
    const enhancedSentinelPath = join(
      work,
      "frame-cache",
      state.frameCacheKey,
      "enhanced-frames",
      "tile-384",
      frameFileName(0),
    );
    sequenceSentinelPath = join(jobDirectory, "sequence", frameFileName(0));
    await rm(sequenceSentinelPath);
    await Promise.all([
      writeFile(sourceSentinelPath, sourceSentinel),
      writeFile(enhancedSentinelPath, enhancedSentinel),
      writeFile(sequenceSentinelPath, sequenceSentinel),
    ]);

    const resumed = await processVideo(spec, options);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.verification.passed, true);
    assert.equal(resumed.verification.health?.fullDecodeCompleted, true);
    assert.equal(resumed.verification.referenceHealth?.fullDecodeCompleted, true);
    assert.equal(extractionCalls, 1);
    assert.equal(upscaleCalls, 2);
    assert.equal(encodeCalls, 2);
    assert.equal(fullDecodeCalls, 2);
    assert.deepEqual(await readFile(sourceSentinelPath), sourceSentinel);
    assert.deepEqual(await readFile(enhancedSentinelPath), enhancedSentinel);
    await assert.rejects(access(join(jobDirectory, "sequence")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification failure reports the verify phase, preserves failed checks, and removes partial output", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-verify-failure-"));
  const cache = join(root, "cache");
  const work = join(root, "work");
  const input = join(root, "source.mp4");
  const output = join(root, "result.mp4");
  const progress: ProgressEvent[] = [];
  let partialOutput = "";
  await writeFile(input, "source");

  const runner: CommandRunner = async (command, options) => {
    if (command.executable === "ffprobe-stub") {
      const path = command.args.at(-1) ?? "";
      const encoded = path !== input;
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
            color_transfer: encoded ? "iec61966-2-1" : "bt709",
            color_range: "tv",
            avg_frame_rate: "24/1",
            nb_read_frames: "1",
            duration: String(1 / 24),
          }],
          format: { format_name: "mp4", duration: String(1 / 24), size: "10" },
        }),
        stderr: "",
      };
    }
    if (command.args.some((arg) => arg.includes("blackdetect="))) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const encodedOutput = command.args.find((arg) => arg.includes(".partial.mp4"));
    if (encodedOutput) {
      partialOutput = encodedOutput;
      await writeFile(encodedOutput, "encoded");
      options?.onStdout?.("frame=1\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=1\nprogress=end\n", stderr: "" };
    }
    const pngPattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pngPattern) {
      await mkdir(dirname(pngPattern), { recursive: true });
      await writeFile(join(dirname(pngPattern), frameFileName(0)), testPng(16, 10));
      options?.onStdout?.("frame=1\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=1\nprogress=end\n", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
  };

  const spec: JobSpec = {
    version: 1,
    inputPath: input,
    outputPath: output,
    target: { width: 32, height: 20 },
    aspectMode: "cover",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "none",
    upscaleMode: "lanczos",
    model: "realesr-animevideov3",
    tile: 384,
    sourceFps: "auto",
    encoding: {
      codec: "h264",
      encoder: "h264_nvenc",
      profile: "high",
      crf: 17,
      preset: "slow",
      pixelFormat: "yuv420p",
      removeAudio: true,
    },
  };

  try {
    await assert.rejects(
      processVideo(spec, {
        cacheDirectory: cache,
        workDirectory: work,
        binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
        runner,
        onProgress: (event) => progress.push(event),
      }),
      (error) => error instanceof AppError && error.code === "E_VERIFICATION_FAILED",
    );
    assert.notEqual(partialOutput, "");
    await assert.rejects(access(partialOutput));
    await assert.rejects(access(output));
    assert.deepEqual(progress.at(-1), {
      jobId: progress.at(-1)?.jobId,
      phase: "verify",
      current: 0,
      total: 1,
      percent: 0,
      etaMs: null,
      message: "Verifying encoded wallpaper",
    });
    const jobs = await readdir(join(work, "jobs"));
    const state = JSON.parse(await readFile(join(work, "jobs", jobs[0] as string, "job-state.json"), "utf8")) as {
      phase: string;
      lastError?: { details?: { failedChecks?: Array<{ name?: string; expected?: string; actual?: string }> } };
    };
    assert.equal(state.phase, "verify");
    assert.deepEqual(state.lastError?.details?.failedChecks, [{
      name: "colorTransfer",
      expected: "bt709",
      actual: "iec61966-2-1",
      passed: false,
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
