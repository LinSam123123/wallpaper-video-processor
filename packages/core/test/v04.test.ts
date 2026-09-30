import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  AppError,
  createJobId,
  frameCacheKey,
  frameFileName,
  parseJobSpec,
  previewVideo,
  processVideo,
  type CommandRunner,
  type JobSpec,
} from "../src/index.js";
import { testPng } from "./test-png.js";

const SOURCE_FRAME_COUNT = 8;
const SOURCE_FPS = 24;
const SOURCE_FRAMES = Array.from(
  { length: SOURCE_FRAME_COUNT },
  (_, index) => testPng(16, 10, Buffer.from(`source-${index}`)),
);

function v3Spec(inputPath: string, outputPath: string, startFrame = 2, endFrameExclusive = 5): JobSpec {
  return {
    version: 3,
    inputPath,
    outputPath,
    target: { width: 32, height: 20 },
    aspectMode: "contain",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "pingpong",
    upscaleMode: "lanczos",
    model: "realesr-animevideov3",
    tile: 384,
    sourceFps: "auto",
    sourceRange: { startFrame, endFrameExclusive },
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
  };
}

interface StubState {
  extractionRanges: Array<[number, number]>;
  encodedSequences: Buffer[][];
  rifeInputs: Buffer[][];
  healthCommands?: string[][];
}

function pipelineStub(inputPath: string, state: StubState, rifePath?: string): CommandRunner {
  return async (command, options) => {
    if (command.executable === "ffprobe-stub") {
      const path = command.args.at(-1) as string;
      const encoded = path !== inputPath;
      const frameCount = encoded ? Number(await readFile(path, "utf8")) : SOURCE_FRAME_COUNT;
      const frameRate = encoded && path.includes("rife") ? SOURCE_FPS * 2 : SOURCE_FPS;
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
            r_frame_rate: `${frameRate}/1`,
            nb_read_frames: String(frameCount),
            duration: String(frameCount / frameRate),
          }],
          format: { format_name: "mp4", duration: String(frameCount / frameRate), size: "10" },
        }),
        stderr: "",
      };
    }
    if (command.args.some((arg) => arg.includes("scdet=threshold"))) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.args.includes("-xerror")) {
      state.healthCommands?.push(command.args);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (rifePath && command.executable === rifePath) {
      const inputDirectory = command.args[command.args.indexOf("-i") + 1] as string;
      const outputDirectory = command.args[command.args.indexOf("-o") + 1] as string;
      const outputFrameCount = Number(command.args[command.args.indexOf("-n") + 1]);
      const inputFrameCount = outputFrameCount / 2;
      const inputs = await Promise.all(Array.from(
        { length: inputFrameCount },
        (_, index) => readFile(join(inputDirectory, frameFileName(index))),
      ));
      state.rifeInputs.push(inputs);
      await mkdir(outputDirectory, { recursive: true });
      for (let index = 0; index < outputFrameCount; index += 1) {
        const source = inputs[Math.min(inputs.length - 1, Math.floor(index / 2))] as Buffer;
        const frame = index % 2 === 0
          ? source
          : testPng(16, 10, Buffer.from(`interpolated-${index}`));
        await writeFile(join(outputDirectory, `${String(index).padStart(8, "0")}.png`), frame);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const partialOutput = command.args.find((arg) => arg.includes(".partial.mp4"));
    if (partialOutput) {
      const frameCount = Number(command.args[command.args.indexOf("-frames:v") + 1]);
      const pattern = command.args[command.args.indexOf("-i") + 1] as string;
      const sequenceDirectory = dirname(pattern);
      state.encodedSequences.push(await Promise.all(Array.from(
        { length: frameCount },
        (_, index) => readFile(join(sequenceDirectory, frameFileName(index))),
      )));
      await writeFile(partialOutput, String(frameCount));
      options?.onStdout?.(`frame=${frameCount}\nprogress=end\n`);
      return { exitCode: 0, stdout: `frame=${frameCount}\nprogress=end\n`, stderr: "" };
    }
    const pngPattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pngPattern) {
      const filter = command.args[command.args.indexOf("-vf") + 1] ?? "";
      const match = /between\(n\\,(\d+)\\,(\d+)\)/.exec(filter);
      assert.ok(match);
      const startFrame = Number(match[1]);
      const endFrame = Number(match[2]);
      state.extractionRanges.push([startFrame, endFrame]);
      await mkdir(dirname(pngPattern), { recursive: true });
      for (let index = startFrame; index <= endFrame; index += 1) {
        await writeFile(join(dirname(pngPattern), frameFileName(index)), SOURCE_FRAMES[index]);
      }
      const frameCount = endFrame - startFrame + 1;
      options?.onStdout?.(`frame=${frameCount}\nprogress=end\n`);
      return { exitCode: 0, stdout: `frame=${frameCount}\nprogress=end\n`, stderr: "" };
    }
    throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
  };
}

test("JobSpec v3 requires a non-empty half-open source range while v1/v2 remain full-range compatible", () => {
  const base = v3Spec("source.mp4", "output.mp4");
  assert.deepEqual(parseJobSpec(base).sourceRange, { startFrame: 2, endFrameExclusive: 5 });
  assert.throws(
    () => parseJobSpec({ ...base, sourceRange: undefined }),
    (error) => error instanceof AppError && error.code === "E_INVALID_CONFIG",
  );
  assert.throws(
    () => parseJobSpec({ ...base, sourceRange: { startFrame: 3, endFrameExclusive: 3 } }),
    (error) => error instanceof AppError && error.code === "E_INVALID_CONFIG",
  );
  const { sourceRange: _sourceRange, ...withoutRange } = base;
  assert.equal(parseJobSpec({ ...withoutRange, version: 2 }).sourceRange, undefined);
  assert.equal(parseJobSpec({ ...withoutRange, version: 1 }).sourceRange, undefined);
  for (const version of [1, 2] as const) {
    assert.throws(
      () => parseJobSpec({ ...base, version }),
      (error) => error instanceof AppError && error.code === "E_INVALID_CONFIG",
    );
  }

  const fingerprint = { path: "C:/source.mp4", size: 10, modifiedMs: 20 };
  const first = parseJobSpec(base);
  const second = parseJobSpec({ ...base, sourceRange: { startFrame: 3, endFrameExclusive: 6 } });
  assert.notEqual(createJobId(first, fingerprint), createJobId(second, fingerprint));
  const cacheInput = {
    input: fingerprint,
    sourceFps: 24,
    upscaleMode: "lanczos" as const,
    model: first.model,
    actualScale: 1,
    interpolation: first.interpolation,
  };
  assert.equal(frameCacheKey(cacheInput), frameCacheKey({ ...cacheInput }));
});

test("v3 rejects variable-frame-rate input before extracting frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-v04-vfr-"));
  const input = join(root, "source.mp4");
  await writeFile(input, "source");
  const runner: CommandRunner = async (command) => {
    if (command.executable !== "ffprobe-stub") {
      throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
    }
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
          r_frame_rate: "24/1",
          nb_read_frames: "8",
          duration: String(8 / 24),
        }],
        frames: [
          { best_effort_timestamp_time: "0.000000" },
          { best_effort_timestamp_time: "0.041667" },
          { best_effort_timestamp_time: "0.125000" },
        ],
        format: { format_name: "mp4", duration: String(8 / 24), size: "10" },
      }),
      stderr: "",
    };
  };
  try {
    await assert.rejects(
      processVideo(v3Spec(input, join(root, "output.mp4")), {
        workDirectory: join(root, "work"),
        cacheDirectory: join(root, "cache"),
        binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
        runner,
      }),
      (error) => error instanceof AppError && error.code === "E_UNSUPPORTED_MEDIA" &&
        (error.details as { frameRateMode?: string }).frameRateMode === "variable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v3 rejects input when constant frame cadence cannot be confirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-v04-unknown-rate-"));
  const input = join(root, "source.mp4");
  await writeFile(input, "source");
  const runner: CommandRunner = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      streams: [{
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        width: 16,
        height: 10,
        avg_frame_rate: "24/1",
        nb_read_frames: "8",
        duration: String(8 / 24),
      }],
      format: { format_name: "mp4", duration: String(8 / 24), size: "10" },
    }),
    stderr: "",
  });
  try {
    await assert.rejects(
      processVideo(v3Spec(input, join(root, "output.mp4")), {
        workDirectory: join(root, "work"),
        cacheDirectory: join(root, "cache"),
        binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
        runner,
      }),
      (error) => error instanceof AppError && error.code === "E_UNSUPPORTED_MEDIA" &&
        (error.details as { frameRateMode?: string }).frameRateMode === "unknown",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v3 processing uses global frame indices, shares overlapping cache frames, and refuses another range's output", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-v04-range-"));
  const input = join(root, "source.mp4");
  const state: StubState = { extractionRanges: [], encodedSequences: [], rifeInputs: [] };
  await writeFile(input, "source");
  const runner = pipelineStub(input, state);
  const options = {
    workDirectory: join(root, "work"),
    cacheDirectory: join(root, "cache"),
    cachePolicy: "keep-all" as const,
    binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
    runner,
  };
  try {
    const firstSpec = v3Spec(input, join(root, "first.mp4"), 2, 5);
    await assert.rejects(
      processVideo(v3Spec(input, join(root, "outside.mp4"), 7, 9), options),
      (error) => error instanceof AppError && error.code === "E_INVALID_CONFIG" &&
        (error.details as { sourceFrameCount?: number }).sourceFrameCount === SOURCE_FRAME_COUNT,
    );
    const first = await processVideo(firstSpec, options);
    assert.deepEqual(first.sourceRange, { startFrame: 2, endFrameExclusive: 5 });
    assert.equal(first.sourceFrameCount, 3);
    assert.deepEqual(state.extractionRanges, [[2, 4]]);
    assert.deepEqual(state.encodedSequences[0], [
      SOURCE_FRAMES[2], SOURCE_FRAMES[3], SOURCE_FRAMES[4], SOURCE_FRAMES[3],
    ]);

    const overlapping = await processVideo(v3Spec(input, join(root, "second.mp4"), 4, 7), options);
    assert.equal(overlapping.frameCacheKey, first.frameCacheKey);
    assert.notEqual(overlapping.jobId, first.jobId);
    assert.deepEqual(state.extractionRanges, [[2, 4], [5, 6]]);

    await assert.rejects(
      processVideo(v3Spec(input, first.outputPath, 3, 6), options),
      (error) => error instanceof AppError && error.code === "E_OUTPUT_EXISTS",
    );
    assert.deepEqual(state.extractionRanges, [[2, 4], [5, 6]]);
    const resumed = await processVideo(firstSpec, options);
    assert.equal(resumed.resumed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loop-boundary previews center exact ping-pong turns and the direct seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-v04-boundary-"));
  const input = join(root, "source.mp4");
  const state: StubState = { extractionRanges: [], encodedSequences: [], rifeInputs: [], healthCommands: [] };
  await writeFile(input, "source");
  const runner = pipelineStub(input, state);
  const options = {
    workDirectory: join(root, "work"),
    cacheDirectory: join(root, "cache"),
    cachePolicy: "keep-all" as const,
    binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
    runner,
  };
  const spec = v3Spec(input, join(root, "wallpaper.mp4"), 2, 7);
  try {
    const end = await previewVideo(spec, {
      previewMode: "loop-boundary",
      turn: "end",
      frameCount: 3,
      outputPath: join(root, "ping-end.mp4"),
    }, options);
    const start = await previewVideo(spec, {
      previewMode: "loop-boundary",
      turn: "start",
      frameCount: 3,
      outputPath: join(root, "ping-start.mp4"),
    }, options);
    const direct = await previewVideo({ ...spec, loopMode: "none" }, {
      previewMode: "loop-boundary",
      frameCount: 4,
      outputPath: join(root, "direct.mp4"),
    }, options);

    assert.deepEqual(state.encodedSequences, [
      [SOURCE_FRAMES[5], SOURCE_FRAMES[6], SOURCE_FRAMES[5]],
      [SOURCE_FRAMES[3], SOURCE_FRAMES[2], SOURCE_FRAMES[3]],
      [SOURCE_FRAMES[5], SOURCE_FRAMES[6], SOURCE_FRAMES[2], SOURCE_FRAMES[3]],
    ]);
    assert.deepEqual(end.boundary, { type: "pingpong-end", outputFrame: 1 });
    assert.deepEqual(start.boundary, { type: "pingpong-start", outputFrame: 1 });
    assert.deepEqual(direct.boundary, { type: "direct-seam", outputFrame: 2 });
    assert.deepEqual(direct.sourceRanges, [
      { startFrame: 2, endFrameExclusive: 4 },
      { startFrame: 5, endFrameExclusive: 7 },
    ]);
    assert.equal(state.healthCommands?.length, 6);
    const directReferenceHealth = state.healthCommands?.[5] ?? [];
    assert.equal(directReferenceHealth[directReferenceHealth.indexOf("-i") + 1], input);
    assert.equal(
      directReferenceHealth[directReferenceHealth.indexOf("-vf") + 1],
      "select=between(n\\,2\\,3)+between(n\\,5\\,6),setpts=N/(24*TB),blackdetect=d=0.04:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=2",
    );
    await assert.rejects(
      previewVideo(spec, {
        previewMode: "loop-boundary",
        centerSeconds: 1,
        outputPath: join(root, "invalid.mp4"),
      }, options),
      (error) => error instanceof AppError && error.code === "E_INVALID_ARGUMENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RIFE direct-seam preview holds the tail and never interpolates last-to-first", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-v04-rife-seam-"));
  const input = join(root, "source.mp4");
  const output = join(root, "rife-wallpaper.mp4");
  const rifePath = join(root, "rife", "rife-stub.exe");
  const state: StubState = { extractionRanges: [], encodedSequences: [], rifeInputs: [] };
  await writeFile(input, "source");
  await mkdir(join(dirname(rifePath), "rife-v4.6"), { recursive: true });
  await Promise.all([
    writeFile(join(dirname(rifePath), "rife-v4.6", "flownet.bin"), "model"),
    writeFile(join(dirname(rifePath), "rife-v4.6", "flownet.param"), "parameters"),
  ]);
  const spec = {
    ...v3Spec(input, output, 2, 6),
    loopMode: "none" as const,
    interpolation: {
      mode: "rife" as const,
      factor: 2 as const,
      model: "rife-v4.6" as const,
      memoryMode: "standard" as const,
      sceneCutMode: "hold" as const,
    },
  };
  try {
    const result = await previewVideo(spec, {
      previewMode: "loop-boundary",
      frameCount: 4,
      outputPath: join(root, "rife-seam.mp4"),
    }, {
      workDirectory: join(root, "work"),
      cacheDirectory: join(root, "cache"),
      cachePolicy: "keep-all",
      binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub", rife: rifePath },
      runner: pipelineStub(input, state, rifePath),
    });
    assert.equal(result.frameCount, 8);
    assert.equal(state.rifeInputs.length, 1);
    assert.deepEqual(state.rifeInputs[0], [
      SOURCE_FRAMES[2], SOURCE_FRAMES[3], SOURCE_FRAMES[4], SOURCE_FRAMES[5],
    ]);
    const sequence = state.encodedSequences[0] as Buffer[];
    assert.deepEqual(sequence[3], SOURCE_FRAMES[5]);
    assert.deepEqual(sequence[4], SOURCE_FRAMES[2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RIFE ranges isolate a tail hold from a later real interpolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-v04-rife-range-cache-"));
  const input = join(root, "source.mp4");
  const rifePath = join(root, "rife", "rife-stub.exe");
  const state: StubState = { extractionRanges: [], encodedSequences: [], rifeInputs: [] };
  await writeFile(input, "source");
  await mkdir(join(dirname(rifePath), "rife-v4.6"), { recursive: true });
  await Promise.all([
    writeFile(join(dirname(rifePath), "rife-v4.6", "flownet.bin"), "model"),
    writeFile(join(dirname(rifePath), "rife-v4.6", "flownet.param"), "parameters"),
  ]);
  const rifeSpec = (outputPath: string, startFrame: number, endFrameExclusive: number) => ({
    ...v3Spec(input, outputPath, startFrame, endFrameExclusive),
    loopMode: "none" as const,
    interpolation: {
      mode: "rife" as const,
      factor: 2 as const,
      model: "rife-v4.6" as const,
      memoryMode: "standard" as const,
      sceneCutMode: "hold" as const,
    },
  });
  const options = {
    workDirectory: join(root, "work"),
    cacheDirectory: join(root, "cache"),
    cachePolicy: "keep-all" as const,
    binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub", rife: rifePath },
    runner: pipelineStub(input, state, rifePath),
  };
  try {
    const first = await processVideo(rifeSpec(join(root, "first-rife.mp4"), 2, 5), options);
    const second = await processVideo(rifeSpec(join(root, "second-rife.mp4"), 4, 7), options);

    assert.notEqual(first.frameCacheKey, second.frameCacheKey);
    assert.deepEqual(state.rifeInputs, [
      [SOURCE_FRAMES[2], SOURCE_FRAMES[3], SOURCE_FRAMES[4]],
      [SOURCE_FRAMES[4], SOURCE_FRAMES[5], SOURCE_FRAMES[6]],
    ]);
    assert.notDeepEqual(state.encodedSequences[1]?.[1], SOURCE_FRAMES[4]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
