import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { doctor, probeH264Nvenc, type CommandRunner } from "../src/index.js";

const availableRunner: CommandRunner = async () => ({
  exitCode: 0,
  stdout: "tool available\n",
  stderr: "",
});

test("doctor accepts the official RIFE model layout beside the executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-rife-doctor-"));
  const rifePath = join(root, "rife", "rife-ncnn-vulkan.exe");
  const modelDirectory = join(dirname(rifePath), "rife-v4.6");
  try {
    await mkdir(modelDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(modelDirectory, "flownet.bin"), "model"),
      writeFile(join(modelDirectory, "flownet.param"), "parameters"),
    ]);
    const report = await doctor({
      cacheDirectory: join(root, "cache"),
      binaries: {
        ffmpeg: "ffmpeg-stub",
        ffprobe: "ffprobe-stub",
        realesrgan: "realesrgan-stub",
        rife: rifePath,
      },
      runner: availableRunner,
    });
    const rife = report.tools.find((tool) => tool.name === "rife");
    assert.equal(rife?.available, true);
    assert.equal(rife?.error, undefined);
    assert.deepEqual(report.capabilities, {
      jobSpecVersions: [1, 2, 3, 4],
      previewModes: ["segment", "loop-boundary"],
      h264Nvenc: { available: true, maxDimension: 4096 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("NVENC probe uses a valid 256px frame and production quality arguments", async () => {
  let args: string[] = [];
  const result = await probeH264Nvenc("ffmpeg-stub", async (command) => {
    args = command.args;
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  assert.deepEqual(result, { available: true, maxDimension: 4096 });
  assert.ok(args.includes("color=c=black:s=256x256:r=1"));
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-pix_fmt")), [
    "-c:v", "h264_nvenc", "-profile:v", "high", "-preset", "p6",
    "-tune", "hq", "-rc", "vbr", "-cq", "17", "-b:v", "0",
  ]);
});

test("NVENC probe reports missing FFmpeg and driver initialization failures", async () => {
  assert.deepEqual(await probeH264Nvenc(undefined), {
    available: false,
    maxDimension: 4096,
    error: "FFmpeg is unavailable",
  });
  const failed = await probeH264Nvenc("ffmpeg-stub", async () => {
    throw new Error("Cannot load nvEncodeAPI64.dll");
  });
  assert.equal(failed.available, false);
  assert.equal(failed.maxDimension, 4096);
  assert.match(failed.error ?? "", /nvEncodeAPI64/);
});

test("doctor rejects the obsolete nested RIFE models layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-rife-doctor-nested-"));
  const rifePath = join(root, "rife", "rife-ncnn-vulkan.exe");
  const nestedModelDirectory = join(dirname(rifePath), "models", "rife-v4.6");
  try {
    await mkdir(nestedModelDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(nestedModelDirectory, "flownet.bin"), "model"),
      writeFile(join(nestedModelDirectory, "flownet.param"), "parameters"),
    ]);
    const report = await doctor({
      cacheDirectory: join(root, "cache"),
      binaries: {
        ffmpeg: "ffmpeg-stub",
        ffprobe: "ffprobe-stub",
        realesrgan: "realesrgan-stub",
        rife: rifePath,
      },
      runner: availableRunner,
    });
    const rife = report.tools.find((tool) => tool.name === "rife");
    assert.equal(rife?.available, false);
    assert.match(rife?.error ?? "", /rife-v4\.6.*flownet\.bin/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
