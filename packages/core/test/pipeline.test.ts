import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  cleanupJob,
  frameFileName,
  previewVideo,
  processVideo,
  selectPreviewFrameRange,
  type CommandRunner,
  type JobSpec,
  type MediaInfo,
  type ProgressEvent,
} from "../src/index.js";
import { testPng } from "./test-png.js";

test("JobSpec v4 processes, previews, and resumes without reparsing its normalized form", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-pipeline-"));
  const cache = join(root, "cache");
  const input = join(root, "source.mp4");
  const output = join(root, "result.mp4");
  const previewOutput = join(root, "result-preview.mp4");
  await writeFile(input, "source");
  let extractionCalls = 0;
  let encodeCalls = 0;
  const healthCommands: string[][] = [];
  const legitimateStaticBlackHealth = [
    "[blackdetect] black_start:0 black_end:30 black_duration:30",
    "[freezedetect] lavfi.freezedetect.freeze_start: 0",
    "[freezedetect] lavfi.freezedetect.freeze_duration: 30",
    "[freezedetect] lavfi.freezedetect.freeze_end: 30",
  ].join("\n");
  const firstProgress: ProgressEvent[] = [];
  const runner: CommandRunner = async (command, options) => {
    if (command.executable === "ffprobe-stub") {
      const path = command.args.at(-1) ?? "";
      const encoded = path !== input;
      const preview = path.includes("preview");
      const frameCount = encoded ? (preview ? 2 : 4) : 8;
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
          format: {
            format_name: "mp4",
            duration: String(frameCount / 24),
            size: "10",
          },
        }),
        stderr: "",
      };
    }
    if (command.args.includes("-xerror")) {
      healthCommands.push(command.args);
      return { exitCode: 0, stdout: "", stderr: legitimateStaticBlackHealth };
    }
    const encodedOutput = command.args.find((arg) => arg.includes(".partial.mp4"));
    if (encodedOutput) {
      encodeCalls += 1;
      await writeFile(encodedOutput, "encoded");
      const frameCount = encodedOutput.includes("preview") ? 2 : 4;
      options?.onStdout?.(`frame=${frameCount}\nprogress=end\n`);
      return { exitCode: 0, stdout: `frame=${frameCount}\nprogress=end\n`, stderr: "" };
    }
    const pngPattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pngPattern) {
      extractionCalls += 1;
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
    version: 4,
    inputPath: input,
    outputPath: output,
    sourceRange: { startFrame: 0, endFrameExclusive: 3 },
    target: { width: 32, height: 20 },
    aspectMode: "contain",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "pingpong",
    upscale: { backend: "lanczos", model: "lanczos" },
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
      profile: "high",
      crf: 17,
      preset: "slow",
      pixelFormat: "yuv420p",
      removeAudio: true,
    },
  };
  try {
    const first = await processVideo(spec, {
      cacheDirectory: cache,
      binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
      runner,
      cachePolicy: "keep-all",
      onProgress: (event) => firstProgress.push(event),
    });
    assert.equal(first.media.video.frameCount, 4);
    assert.equal(first.verification.passed, true);
    assert.equal(first.verification.referenceHealth?.fullDecodeCompleted, true);
    assert.equal(first.verification.health?.catastrophicBlack, true);
    assert.equal(first.verification.referenceHealth?.catastrophicBlack, true);
    assert.equal(first.verification.health?.catastrophicFreeze, true);
    assert.equal(first.verification.referenceHealth?.catastrophicFreeze, true);
    assert.equal(first.resumed, false);
    assert.equal(first.workDirectory, join(root, ".ai-video-wallpaper-work"));
    assert.equal(extractionCalls, 1);
    assert.equal(encodeCalls, 1);
    assert.equal(healthCommands.length, 2);
    assert.equal(healthCommands[1]?.[healthCommands[1].indexOf("-i") + 1], input);
    assert.equal(
      healthCommands[1]?.[healthCommands[1].indexOf("-vf") + 1],
      "trim=start_frame=0:end_frame=3,setpts=PTS-STARTPTS,blackdetect=d=0.04:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=2",
    );
    assert.deepEqual(firstProgress.filter((event) => event.phase === "verify").map((event) => event.current), [0, 1]);
    await assert.rejects(access(join(first.workDirectory, "jobs", first.jobId, "sequence")));
    const previewProgress: ProgressEvent[] = [];
    const preview = await previewVideo(spec, {
      centerSeconds: 0.05,
      frameCount: 2,
      outputPath: previewOutput,
    }, {
      cacheDirectory: cache,
      binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
      runner,
      cachePolicy: "keep-all",
      onProgress: (event) => previewProgress.push(event),
    });
    assert.equal(preview.frameCount, 2);
    assert.equal(preview.verification.passed, true);
    assert.equal(preview.verification.health?.catastrophicBlack, true);
    assert.equal(preview.verification.referenceHealth?.catastrophicBlack, true);
    assert.equal(preview.verification.health?.catastrophicFreeze, true);
    assert.equal(preview.verification.referenceHealth?.catastrophicFreeze, true);
    assert.equal(extractionCalls, 1);
    assert.equal(encodeCalls, 2);
    assert.equal(healthCommands.length, 4);
    assert.equal(
      healthCommands[3]?.[healthCommands[3].indexOf("-vf") + 1],
      "trim=start_frame=0:end_frame=2,setpts=PTS-STARTPTS,blackdetect=d=0.04:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=2",
    );
    assert.deepEqual(previewProgress.filter((event) => event.phase === "verify").map((event) => event.current), [0, 1]);
    await assert.rejects(access(join(
      first.workDirectory,
      "jobs",
      first.jobId,
      `preview-sequence-${preview.startFrame}-${preview.frameCount}`,
    )));
    const state = JSON.parse(await readFile(join(
      first.workDirectory,
      "jobs",
      first.jobId,
      "job-state.json",
    ), "utf8")) as { phase: string };
    assert.equal(state.phase, "complete");
    const second = await processVideo(spec, {
      cacheDirectory: cache,
      binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
      runner,
      cachePolicy: "keep-all",
    });
    assert.equal(second.resumed, true);
    assert.equal(extractionCalls, 1);
    assert.equal(encodeCalls, 2);
    await cleanupJob(first.jobId, first.workDirectory);
    await assert.rejects(access(join(first.workDirectory, "jobs", first.jobId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview selection uses video-stream duration and FPS, not container or output timing", () => {
  const media: MediaInfo = {
    path: "source.mp4",
    format: "mp4",
    durationSeconds: 30,
    sizeBytes: 1,
    video: {
      index: 0,
      codec: "h264",
      width: 1136,
      height: 800,
      frameRate: 24,
      frameCount: 240,
      durationSeconds: 10,
    },
    audio: [],
  };
  const outputFpsOverride: JobSpec["sourceFps"] = 60;
  assert.notEqual(outputFpsOverride, media.video.frameRate);
  assert.deepEqual(selectPreviewFrameRange(media), { startFrame: 96, frameCount: 48 });
});
