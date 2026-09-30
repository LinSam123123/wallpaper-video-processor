import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  AppError,
  frameFileName,
  inspectCache,
  processVideo,
  type CommandRunner,
  type JobSpec,
} from "../src/index.js";
import { testPng } from "./test-png.js";

function spec(inputPath: string, outputPath: string): JobSpec {
  return {
    version: 2,
    inputPath,
    outputPath,
    target: { width: 16, height: 10 },
    aspectMode: "cover",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "none",
    upscaleMode: "lanczos",
    model: "realesr-animevideov3",
    tile: 384,
    gpuId: "auto",
    aiScale: "auto",
    batchSize: 64,
    sourceFps: "auto",
    interpolation: { mode: "none", factor: 1, model: "rife-v4.6", memoryMode: "auto", sceneCutMode: "hold" },
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

function lifecycleRunner(
  inputPath: string,
  options: { failEncode?: boolean; cancelEncode?: boolean; onVerify?: (partial: string) => Promise<void> } = {},
): CommandRunner {
  return async (command, progress) => {
    if (command.executable === "ffprobe-stub") {
      const path = command.args.at(-1) as string;
      if (path !== inputPath) await options.onVerify?.(path);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [{
            index: 0,
            codec_type: "video",
            codec_name: "h264",
            width: 16,
            height: 10,
            sample_aspect_ratio: path === inputPath ? undefined : "1:1",
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
    if (command.args.includes("-xerror")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const encodedOutput = command.args.find((arg) => arg.includes(".partial.mp4"));
    if (encodedOutput) {
      if (options.cancelEncode) throw new AppError("E_CANCELLED", "cancelled by test");
      if (options.failEncode) throw new AppError("E_PROCESS_FAILED", "encode failed by test");
      await writeFile(encodedOutput, "verified output");
      progress?.onStdout?.("frame=2\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=2\nprogress=end\n", stderr: "" };
    }
    const pngPattern = command.args.find((arg) => arg.endsWith("frame_%08d.png"));
    if (pngPattern) {
      await mkdir(dirname(pngPattern), { recursive: true });
      await Promise.all([0, 1].map((index) => writeFile(join(dirname(pngPattern), frameFileName(index)), testPng(16, 10))));
      progress?.onStdout?.("frame=2\nprogress=end\n");
      return { exitCode: 0, stdout: "frame=2\nprogress=end\n", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
  };
}

test("successful process keeps cache through verification and removes it only after publish and lock release", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-cache-success-"));
  const input = join(root, "input.mp4");
  const output = join(root, "output.mp4");
  const work = join(root, "work");
  let verifiedWhileCacheActive = false;
  await writeFile(input, "input");
  try {
    const result = await processVideo(spec(input, output), {
      workDirectory: work,
      cacheDirectory: join(root, "tools"),
      binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
      runner: lifecycleRunner(input, {
        onVerify: async (partial) => {
          assert.equal(partial.includes(".partial.mp4"), true);
          await access(join(work, "frame-cache"));
          const jobId = (await readdir(join(work, "jobs"))).find((entry) => /^[a-f0-9]{20}$/.test(entry));
          assert.ok(jobId);
          await access(join(work, "jobs", jobId, ".job.lock"));
          await assert.rejects(access(output));
          verifiedWhileCacheActive = true;
        },
      }),
    });
    assert.equal(verifiedWhileCacheActive, true);
    assert.equal(await readFile(output, "utf8"), "verified output");
    await assert.rejects(access(join(work, "frame-cache", result.frameCacheKey)));
    await assert.rejects(access(join(work, "jobs", result.jobId, ".job.lock")));
    assert.equal((result.cacheMaintenance?.releasedBytes ?? 0) > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a verified published output resumes after stale-lock interruption but rejects a replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-publish-recovery-"));
  const input = join(root, "input.mp4");
  const output = join(root, "output.mp4");
  const work = join(root, "work");
  await writeFile(input, "input");
  const options = {
    workDirectory: work,
    cacheDirectory: join(root, "tools"),
    cachePolicy: "keep-all" as const,
    binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
    runner: lifecycleRunner(input),
  };
  try {
    const first = await processVideo(spec(input, output), options);
    const jobDirectory = join(work, "jobs", first.jobId);
    const statePath = join(jobDirectory, "job-state.json");
    const interrupted = JSON.parse(await readFile(statePath, "utf8")) as {
      phase: string;
      verifiedOutput?: { outputPath?: string; size?: number; modifiedMs?: number; frameCount?: number; sha256?: string };
    };
    assert.equal(interrupted.verifiedOutput?.outputPath, output);
    assert.equal(interrupted.verifiedOutput?.frameCount, 2);
    assert.match(interrupted.verifiedOutput?.sha256 ?? "", /^[a-f0-9]{64}$/);
    interrupted.phase = "verify";
    await writeFile(statePath, `${JSON.stringify(interrupted, null, 2)}\n`);
    await writeFile(join(jobDirectory, ".job.lock"), `${JSON.stringify({
      jobId: first.jobId,
      pid: 2_147_483_647,
      createdAt: new Date(0).toISOString(),
    })}\n`);

    const resumed = await processVideo(spec(input, output), options);
    assert.equal(resumed.resumed, true);
    const completed = JSON.parse(await readFile(statePath, "utf8")) as { phase: string };
    assert.equal(completed.phase, "complete");
    await assert.rejects(access(join(jobDirectory, ".job.lock")));

    const replaced = JSON.parse(await readFile(statePath, "utf8")) as typeof interrupted;
    replaced.phase = "verify";
    await writeFile(statePath, `${JSON.stringify(replaced, null, 2)}\n`);
    const original = await readFile(output);
    const replacement = Buffer.from(original);
    replacement[0] = (replacement[0] ?? 0) ^ 0xff;
    await writeFile(output, replacement);
    const markerMtime = replaced.verifiedOutput?.modifiedMs;
    assert.equal(typeof markerMtime, "number");
    await utimes(output, new Date(markerMtime as number), new Date(markerMtime as number));
    const replacementInfo = await stat(output);
    assert.equal(replacementInfo.size, replaced.verifiedOutput?.size);
    assert.equal(Math.round(replacementInfo.mtimeMs), markerMtime);
    await assert.rejects(
      processVideo(spec(input, output), options),
      (error) => error instanceof AppError && error.code === "E_OUTPUT_EXISTS",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["failed", "cancelled"] as const) {
  test(`${failure} process keeps a recoverable cache with no active job`, async () => {
    const root = await mkdtemp(join(tmpdir(), `wallpaper-cache-${failure}-`));
    const input = join(root, "input.mp4");
    const output = join(root, "output.mp4");
    const work = join(root, "work");
    await writeFile(input, "input");
    try {
      await assert.rejects(
        processVideo(spec(input, output), {
          workDirectory: work,
          cacheDirectory: join(root, "tools"),
          binaries: { ffmpeg: "ffmpeg-stub", ffprobe: "ffprobe-stub" },
          runner: lifecycleRunner(input, {
            failEncode: failure === "failed",
            cancelEncode: failure === "cancelled",
          }),
        }),
        (error) => error instanceof AppError && error.code === (failure === "failed" ? "E_PROCESS_FAILED" : "E_CANCELLED"),
      );
      await assert.rejects(access(output));
      const overview = await inspectCache(work);
      assert.equal(overview.entries.length, 1);
      assert.equal(overview.entries[0]?.status, "recoverable");
      assert.deepEqual(overview.entries[0]?.activeJobIds, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a cache-cleanup failure cannot alter an already completed MP4", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-cache-clean-failure-"));
  const output = join(root, "completed.mp4");
  await writeFile(output, "finished video");
  try {
    const invalidWork = join(root, "not-a-directory");
    await writeFile(invalidWork, "invalid cache root");
    await assert.rejects(inspectCache(invalidWork));
    assert.equal(await readFile(output, "utf8"), "finished video");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
