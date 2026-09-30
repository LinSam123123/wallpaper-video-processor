import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  diagnosticPreviewVideo,
  frameFileName,
  type CommandRunner,
  type JobSpec,
} from "../src/index.js";
import { testPng } from "./test-png.js";

test("v4 standard input auto-locates a cadence risk for A/B/C/D diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-diagnostic-preview-"));
  const input = join(root, "source.mp4");
  const work = join(root, "work");
  const outputs = join(root, "previews");
  const rifePath = join(root, "rife", "rife-stub.exe");
  await writeFile(input, "source");
  await mkdir(join(dirname(rifePath), "rife-v4.6"), { recursive: true });
  await Promise.all([
    writeFile(join(dirname(rifePath), "rife-v4.6", "flownet.bin"), "model"),
    writeFile(join(dirname(rifePath), "rife-v4.6", "flownet.param"), "parameters"),
  ]);

  const runner: CommandRunner = async (command, progress) => {
    if (command.executable === "ffprobe-stub") {
      const path = command.args.at(-1) as string;
      const encoded = path !== input;
      const isRife = path.includes("d-rife");
      const frameCount = encoded ? (isRife ? 4 : 2) : 6;
      const frameRate = isRife ? 48 : 24;
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
    if (command.executable === "realesrgan-stub") {
      const inputDirectory = command.args[command.args.indexOf("-i") + 1] as string;
      const outputDirectory = command.args[command.args.indexOf("-o") + 1] as string;
      const scale = Number(command.args[command.args.indexOf("-s") + 1]);
      await mkdir(outputDirectory, { recursive: true });
      for (const name of (await readdir(inputDirectory)).filter((entry) => entry.endsWith(".png"))) {
        await writeFile(join(outputDirectory, name), testPng(16 * scale, 10 * scale));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.executable === rifePath) {
      const outputDirectory = command.args[command.args.indexOf("-o") + 1] as string;
      const frameCount = Number(command.args[command.args.indexOf("-n") + 1]);
      await mkdir(outputDirectory, { recursive: true });
      for (let index = 0; index < frameCount; index += 1) {
        await writeFile(join(outputDirectory, `${String(index).padStart(8, "0")}.png`), testPng(16, 10));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.args.some((arg) => arg.includes("scdet=threshold"))) {
      const hashes = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee", "eeeeeeee"];
      return {
        exitCode: 0,
        stdout: [
          "#tb 0: 1/24",
          ...hashes.map((hash, index) => `0, ${index}, ${index}, 1, 10, ${hash}`),
        ].join("\n"),
        stderr: "",
      };
    }
    if (command.args.some((arg) => arg.includes("blackdetect="))) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const partial = command.args.find((arg) => arg.includes(".partial.mp4"));
    if (partial) {
      const frameCount = Number(command.args[command.args.indexOf("-frames:v") + 1]);
      await writeFile(partial, "encoded");
      progress?.onStdout?.(`frame=${frameCount}\nprogress=end\n`);
      return { exitCode: 0, stdout: `frame=${frameCount}\nprogress=end\n`, stderr: "" };
    }
    const pattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pattern) {
      const filter = command.args[command.args.indexOf("-vf") + 1] ?? "";
      const selected = /between\(n\\,(\d+)\\,(\d+)\)/.exec(filter);
      const start = selected ? Number(selected[1]) : 0;
      const end = selected ? Number(selected[2]) : 5;
      await mkdir(dirname(pattern), { recursive: true });
      await Promise.all(Array.from({ length: end - start + 1 }, (_, offset) =>
        writeFile(join(dirname(pattern), frameFileName(start + offset)), testPng(16, 10))));
      progress?.onStdout?.(`frame=${end - start + 1}\nprogress=end\n`);
      return { exitCode: 0, stdout: `frame=${end - start + 1}\nprogress=end\n`, stderr: "" };
    }
    throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
  };

  const spec: JobSpec = {
    version: 4,
    inputPath: input,
    outputPath: join(root, "wallpaper.mp4"),
    sourceRange: { startFrame: 0, endFrameExclusive: 6 },
    target: { width: 32, height: 20 },
    aspectMode: "cover",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "pingpong",
    upscale: { backend: "realesrgan-ncnn-vulkan", model: "realesr-animevideov3", tile: 384, gpuId: "auto", aiScale: 2, batchSize: 64 },
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
    const result = await diagnosticPreviewVideo(spec, {
      outputDirectory: outputs,
      frameCount: 2,
      previewMode: "segment",
    }, {
      workDirectory: work,
      cacheDirectory: join(root, "tools"),
      cachePolicy: "keep-all",
      binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub", realesrgan: "realesrgan-stub", rife: rifePath },
      runner,
    });
    assert.deepEqual(result.variants.map((variant) => variant.id), ["A", "B", "C", "D"]);
    assert.deepEqual(result.variants.map((variant) => variant.actualAiScale), [1, 2, 3, 2]);
    assert.deepEqual(result.variants.map((variant) => variant.media.video.frameRate), [24, 24, 24, 48]);
    assert.equal(result.variants.every((variant) => variant.cacheSizeBytes > 0 && variant.verification.passed), true);
    assert.equal(result.cache.entries.length, 4);
    assert.equal(result.previewMode, "segment");
    assert.equal(result.turn, undefined);
    assert.deepEqual(result.sourceRanges, [{ startFrame: 4, endFrameExclusive: 6 }]);
    assert.equal(result.boundary, undefined);
    assert.equal(result.frameRiskAnalysis?.cadenceRisks.length, 1);
    assert.equal(result.selectedRiskPreview?.frame, 5);
    assert.ok(Math.abs((result.selectedRiskPreview?.ptsTime ?? 0) - 5 / 24) < 1e-9);
    assert.equal(result.selectedRiskPreview?.score, 1);
    assert.deepEqual(result.selectedRiskPreview?.kinds, ["cadence", "exact-duplicate"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
