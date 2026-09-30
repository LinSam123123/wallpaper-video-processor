import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  AppError,
  assertEncoderResolutionSupported,
  frameFileName,
  parseJobSpec,
  previewVideo,
  processVideo,
  type CommandRunner,
  type JobSpec,
  type ProgressEvent,
} from "../src/index.js";
import { testPng } from "./test-png.js";

function rifeSpec(inputPath: string, outputPath: string): JobSpec {
  return {
    version: 2,
    inputPath,
    outputPath,
    target: { width: 32, height: 20 },
    aspectMode: "cover",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "pingpong",
    upscaleMode: "lanczos",
    model: "realesr-animevideov3",
    tile: 384,
    sourceFps: "auto",
    interpolation: {
      mode: "rife",
      factor: 2,
      model: "rife-v4.6",
      memoryMode: "standard",
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

test("NVENC resolution preflight rejects either side above 4096 before I/O", async () => {
  const supported = parseJobSpec({
    version: 2,
    inputPath: "missing.mp4",
    outputPath: "output.mp4",
    target: { width: 4096, height: 4096 },
    encoding: { encoder: "h264_nvenc" },
  });
  assert.doesNotThrow(() => assertEncoderResolutionSupported(supported));
  const unsupported = {
    ...supported,
    target: { width: 4098, height: 3200 },
  };
  assert.throws(
    () => assertEncoderResolutionSupported(unsupported),
    (error) => error instanceof AppError && error.code === "E_ENCODER_UNSUPPORTED_RESOLUTION" &&
      (error.details as { requested?: { width?: number } }).requested?.width === 4098,
  );
  await assert.rejects(
    processVideo(unsupported, { cacheDirectory: "missing-cache", binaries: {} }),
    (error) => error instanceof AppError && error.code === "E_ENCODER_UNSUPPORTED_RESOLUTION",
  );
  assert.throws(
    () => assertEncoderResolutionSupported({ ...supported, target: { width: 3200, height: 4098 } }),
    (error) => error instanceof AppError && error.code === "E_ENCODER_UNSUPPORTED_RESOLUTION",
  );
});

test("RIFE is required only when interpolation is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-rife-missing-"));
  try {
    const input = join(root, "source.mp4");
    await writeFile(input, "source");
    await assert.rejects(
      processVideo(rifeSpec(input, join(root, "output.mp4")), {
        cacheDirectory: join(root, "cache"),
        binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub", rife: "" },
      }),
      (error) => error instanceof AppError && error.code === "E_DEPENDENCY_MISSING" &&
        (error.details as { missing?: string[] }).missing?.includes("rife") === true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RIFE preview keeps 2N frames while exact duplicates and detected cuts publish held source frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-rife-pipeline-"));
  const input = join(root, "source.mp4");
  const output = join(root, "result.mp4");
  const previewOutput = join(root, "preview.mp4");
  const work = join(root, "work");
  const progress: ProgressEvent[] = [];
  const sources = [
    testPng(16, 10, Buffer.from("source-0")),
    testPng(16, 10, Buffer.from("source-1")),
    testPng(16, 10, Buffer.from("source-2")),
  ];
  let rifeCalls = 0;
  let sceneCalls = 0;
  await writeFile(input, "source");
  const rifePath = join(root, "rife", "rife-stub.exe");
  const rifeModelDirectory = join(dirname(rifePath), "rife-v4.6");
  await mkdir(rifeModelDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(rifeModelDirectory, "flownet.bin"), "model"),
    writeFile(join(rifeModelDirectory, "flownet.param"), "parameters"),
  ]);

  const runner: CommandRunner = async (command, options) => {
    if (command.executable === "ffprobe-stub") {
      const path = command.args.at(-1) ?? "";
      const encoded = path !== input;
      const preview = path.includes("preview");
      const frameCount = encoded ? (preview ? 4 : 8) : 3;
      const frameRate = encoded ? 48 : 24;
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
            avg_frame_rate: `${frameRate}/1`,
            nb_read_frames: String(frameCount),
            duration: String(frameCount / frameRate),
          }],
          format: { format_name: "mp4", duration: String(frameCount / frameRate), size: "10" },
        }),
        stderr: "",
      };
    }
    if (command.executable === rifePath) {
      rifeCalls += 1;
      assert.equal(command.args[command.args.indexOf("-m") + 1], "rife-v4.6");
      const outputDirectory = command.args[command.args.indexOf("-o") + 1] as string;
      const frameCount = Number(command.args[command.args.indexOf("-n") + 1]);
      await mkdir(outputDirectory, { recursive: true });
      for (let index = 0; index < frameCount; index += 1) {
        await writeFile(join(outputDirectory, `${String(index).padStart(8, "0")}.png`), testPng(16, 10, Buffer.from(`rife-${index}`)));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.args.some((arg) => arg.includes("scdet=threshold"))) {
      sceneCalls += 1;
      const count = Number(command.args[command.args.indexOf("-frames:v") + 1]);
      const hashes = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"];
      const rows = Array.from({ length: count }, (_, index) =>
        `0, ${index}, ${index}, 1, 100, ${hashes[index] ?? hashes.at(-1)}`);
      return {
        exitCode: 0,
        stdout: ["#tb 0: 1/24", ...rows].join("\n"),
        stderr: [
          "frame:0 pts:0 pts_time:0",
          "frame:1 pts:1 pts_time:0.041667",
          "frame:2 pts:2 pts_time:0.083333",
          "lavfi.scd.mafd=20 lavfi.scd.score=15 lavfi.scd.time=0.083333",
        ].join("\n"),
      };
    }
    if (command.args.some((arg) => arg.includes("blackdetect="))) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const encodedOutput = command.args.find((arg) => arg.includes(".partial.mp4"));
    if (encodedOutput) {
      const frameCount = encodedOutput.includes("preview") ? 4 : 8;
      await writeFile(encodedOutput, "encoded");
      options?.onStdout?.(`frame=${frameCount}\nprogress=end\n`);
      return { exitCode: 0, stdout: `frame=${frameCount}\nprogress=end\n`, stderr: "" };
    }
    const pngPattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pngPattern) {
      const start = Number(command.args[command.args.indexOf("-start_number") + 1]) - 1;
      const filter = command.args[command.args.indexOf("-vf") + 1] ?? "";
      const range = /between\(n\\,(\d+)\\,(\d+)\)/.exec(filter);
      const end = range ? Number(range[2]) : 2;
      await mkdir(dirname(pngPattern), { recursive: true });
      for (let index = start; index <= end; index += 1) {
        await writeFile(join(dirname(pngPattern), frameFileName(index)), sources[index] as Buffer);
      }
      options?.onStdout?.(`frame=${end - start + 1}\nprogress=end\n`);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
  };
  const spec = rifeSpec(input, output);
  const options = {
    cacheDirectory: join(root, "cache"),
    workDirectory: work,
    binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub", rife: rifePath },
    runner,
    cachePolicy: "keep-all" as const,
    onProgress: (event: ProgressEvent) => progress.push(event),
  };

  try {
    const preview = await previewVideo(spec, { centerSeconds: 0, frameCount: 2, outputPath: previewOutput }, options);
    assert.equal(preview.sourceFrameCount, 2);
    assert.equal(preview.frameCount, 4);
    assert.equal(preview.media.video.frameRate, 48);
    const result = await processVideo(spec, options);
    assert.equal(result.media.video.frameCount, 8);
    assert.equal(result.media.video.frameRate, 48);
    assert.equal(rifeCalls, 0);
    assert.equal(sceneCalls, 1);
    assert.equal(result.frameRiskAnalysis?.exactDuplicateIntervals.length, 1);
    assert.equal(result.frameRiskAnalysis?.cadenceRisks.length, 1);
    assert.equal(result.frameRiskAnalysis?.hardCuts.length, 1);
    assert.ok(progress.some((event) => event.phase === "interpolate" && event.percent === 100));

    const cache = join(work, "frame-cache", result.frameCacheKey);
    const held = join(cache, "interpolated-frames", frameFileName(3));
    const source = join(cache, "source-frames", frameFileName(1));
    assert.deepEqual(await readFile(held), await readFile(source));
    assert.deepEqual(
      await readFile(join(cache, "interpolated-frames", frameFileName(1))),
      await readFile(join(cache, "source-frames", frameFileName(0))),
    );
    const [heldStat, sourceStat] = await Promise.all([stat(held), stat(source)]);
    assert.equal(heldStat.dev, sourceStat.dev);
    assert.equal(heldStat.ino, sourceStat.ino);
    await assert.rejects(access(join(work, "jobs", result.jobId, "sequence")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("single-frame RIFE ping-pong holds the processed frame twice to preserve duration", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-rife-single-frame-"));
  const input = join(root, "source.mp4");
  const output = join(root, "result.mp4");
  const work = join(root, "work");
  const sourceFrame = testPng(16, 10, Buffer.from("single-source"));
  const rifePath = join(root, "rife", "rife-stub.exe");
  let rifeCalls = 0;
  let encodedSequence: Buffer[] = [];
  await writeFile(input, "source");
  const rifeModelDirectory = join(dirname(rifePath), "rife-v4.6");
  await mkdir(rifeModelDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(rifeModelDirectory, "flownet.bin"), "model"),
    writeFile(join(rifeModelDirectory, "flownet.param"), "parameters"),
  ]);

  const runner: CommandRunner = async (command, options) => {
    if (command.executable === "ffprobe-stub") {
      const encoded = command.args.at(-1) !== input;
      const frameCount = encoded ? 2 : 1;
      const frameRate = encoded ? 48 : 24;
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
            avg_frame_rate: `${frameRate}/1`,
            nb_read_frames: String(frameCount),
            duration: String(frameCount / frameRate),
          }],
          format: { format_name: "mp4", duration: String(frameCount / frameRate), size: "10" },
        }),
        stderr: "",
      };
    }
    if (command.executable === rifePath) {
      rifeCalls += 1;
      throw new Error("RIFE must not run without a source-frame interval");
    }
    if (command.args.some((arg) => arg.includes("scdet=threshold"))) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.args.includes("-xerror")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const encodedOutput = command.args.find((arg) => arg.includes(".partial.mp4"));
    if (encodedOutput) {
      const inputPattern = command.args[command.args.indexOf("-i") + 1] as string;
      encodedSequence = await Promise.all([
        readFile(join(dirname(inputPattern), frameFileName(0))),
        readFile(join(dirname(inputPattern), frameFileName(1))),
      ]);
      await writeFile(encodedOutput, "encoded");
      options?.onStdout?.("frame=2\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=2\nprogress=end\n", stderr: "" };
    }
    const pngPattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pngPattern) {
      await mkdir(dirname(pngPattern), { recursive: true });
      await writeFile(join(dirname(pngPattern), frameFileName(0)), sourceFrame);
      options?.onStdout?.("frame=1\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=1\nprogress=end\n", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
  };

  try {
    const result = await processVideo(rifeSpec(input, output), {
      cacheDirectory: join(root, "cache"),
      workDirectory: work,
      binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub", rife: rifePath },
      runner,
    });
    assert.equal(result.media.video.frameCount, 2);
    assert.equal(result.media.video.frameRate, 48);
    assert.equal(result.media.video.durationSeconds, 1 / 24);
    assert.equal(rifeCalls, 0);
    assert.equal(encodedSequence.length, 2);
    assert.deepEqual(encodedSequence[0], encodedSequence[1]);
    assert.deepEqual(encodedSequence[0], sourceFrame);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
