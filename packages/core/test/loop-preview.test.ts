import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { frameFileName, loopPreviewTarget, loopPreviewVideo, type CommandRunner, type JobSpec } from "../src/index.js";
import { testPng } from "./test-png.js";

test("v4 standard input creates three lightweight loop seams without AI tools", async () => {
  assert.deepEqual(loopPreviewTarget({ width: 2560, height: 1600 }), { width: 960, height: 600 });
  assert.deepEqual(loopPreviewTarget({ width: 3840, height: 2160 }), { width: 960, height: 540 });
  const root = await mkdtemp(join(tmpdir(), "wallpaper-loop-preview-"));
  const input = join(root, "source.mp4");
  await writeFile(input, "source");
  const toolCalls: string[] = [];
  const runner: CommandRunner = async (command, progress) => {
    toolCalls.push(command.executable);
    if (command.executable === "ffprobe-stub") {
      const path = command.args.at(-1) as string;
      const encoded = path !== input;
      const frameCount = encoded ? Number(await readFile(path, "utf8")) : 4;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [{
            index: 0, codec_type: "video", codec_name: "h264",
            width: encoded ? 32 : 16, height: encoded ? 20 : 10,
            sample_aspect_ratio: encoded ? "1:1" : undefined,
            pix_fmt: "yuv420p", color_space: "bt709", color_primaries: "bt709",
            color_transfer: "bt709", color_range: "tv", avg_frame_rate: "24/1",
            r_frame_rate: "24/1", nb_read_frames: String(frameCount), duration: String(frameCount / 24),
          }],
          format: { format_name: "mp4", duration: String(frameCount / 24), size: "10" },
        }),
        stderr: "",
      };
    }
    if (command.args.some((arg) => arg.includes("blackdetect="))) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const partial = command.args.find((arg) => arg.includes(".partial.mp4"));
    if (partial) {
      const frameCount = Number(command.args[command.args.indexOf("-frames:v") + 1]);
      await writeFile(partial, String(frameCount));
      progress?.onStdout?.(`frame=${frameCount}\nprogress=end\n`);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const pattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pattern) {
      const filter = command.args[command.args.indexOf("-vf") + 1] ?? "";
      const match = /between\(n\\,(\d+)\\,(\d+)\)/.exec(filter);
      assert.ok(match);
      await mkdir(dirname(pattern), { recursive: true });
      for (let index = Number(match[1]); index <= Number(match[2]); index += 1) {
        await writeFile(join(dirname(pattern), frameFileName(index)), testPng(16, 10));
      }
      progress?.onStdout?.("frame=4\nprogress=end\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
  };
  const spec: JobSpec = {
    version: 4,
    inputPath: input,
    outputPath: join(root, "wallpaper.mp4"),
    sourceRange: { startFrame: 0, endFrameExclusive: 4 },
    target: { width: 32, height: 20 },
    aspectMode: "cover",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "pingpong",
    upscale: { backend: "realesrgan-ncnn-vulkan", model: "realesr-animevideov3", aiScale: 2 },
    sourceFps: "auto",
    interpolation: {
      mode: "rife",
      factor: 2,
      backend: "rife-ncnn-vulkan",
      model: "rife-v4.6",
      memoryMode: "auto",
      sceneCutMode: "hold",
    },
    encoding: { codec: "h264", encoder: "libx264", profile: "high", crf: 17, preset: "slow", pixelFormat: "yuv420p", removeAudio: true },
  };
  try {
    const result = await loopPreviewVideo(spec, { outputDirectory: join(root, "previews"), frameCount: 4 }, {
      workDirectory: join(root, "work"),
      cacheDirectory: join(root, "tools"),
      binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub", realesrgan: "realesrgan-stub", rife: "rife-stub" },
      runner,
      cachePolicy: "keep-all",
    });
    assert.deepEqual(result.variants.map((variant) => variant.id), ["pingpong-end", "pingpong-start", "direct-seam"]);
    assert.deepEqual(result.variants.map((variant) => variant.boundary), [
      { type: "pingpong-end", outputFrame: 2 },
      { type: "pingpong-start", outputFrame: 2 },
      { type: "direct-seam", outputFrame: 2 },
    ]);
    assert.equal(result.variants.every((variant) => variant.media.video.width === 32 && variant.verification.passed), true);
    assert.equal(toolCalls.includes("realesrgan-stub"), false);
    assert.equal(toolCalls.includes("rife-stub"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
