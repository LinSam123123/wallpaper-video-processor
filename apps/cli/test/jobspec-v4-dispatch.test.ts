import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadJobSpec, runCli, type CliDependencies } from "../src/index.js";

function capturedIo(): {
  output: { stdout: string; stderr: string };
  dependencies: Pick<CliDependencies, "writeStdout" | "writeStderr">;
} {
  const output = { stdout: "", stderr: "" };
  return {
    output,
    dependencies: {
      writeStdout: (text) => { output.stdout += text; },
      writeStderr: (text) => { output.stderr += text; },
    },
  };
}

async function writeV4Job(root: string): Promise<{ configPath: string; inputPath: string; outputPath: string }> {
  const inputPath = join(root, "input.mp4");
  const outputPath = join(root, "output.mp4");
  const configPath = join(root, "job.json");
  await writeFile(inputPath, "video placeholder");
  await writeFile(configPath, JSON.stringify({
    version: 4,
    inputPath: "input.mp4",
    outputPath: "output.mp4",
    target: { width: 2560, height: 1600 },
    aspectMode: "cover",
    focus: { x: 0.5, y: 0.5 },
    loopMode: "pingpong",
    sourceRange: { startFrame: 0, endFrameExclusive: 24 },
    sourceFps: "auto",
    upscale: {
      backend: "realesrgan-ncnn-vulkan",
      model: "realesrgan-x4plus",
      aiScale: 4,
    },
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
  }));
  return { configPath, inputPath, outputPath };
}

test("runCli forwards the original nested JobSpec v4 exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-cli-v4-dispatch-"));
  try {
    const { configPath, inputPath, outputPath } = await writeV4Job(root);
    const loaded = await loadJobSpec(configPath);
    assert.equal(loaded.normalizedSpec.upscaleBackend, "realesrgan-ncnn-vulkan");
    assert.equal(loaded.normalizedSpec.model, "realesrgan-x4plus");

    let dispatchedSpec: unknown;
    let calls = 0;
    const processVideo: CliDependencies["processVideo"] = async (rawSpec) => {
      calls += 1;
      dispatchedSpec = rawSpec;
      return { dispatched: true } as never;
    };
    const capture = capturedIo();
    const exitCode = await runCli(["process", "--config", configPath, "--json"], {
      ...capture.dependencies,
      processVideo,
    });

    assert.equal(exitCode, 0);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(capture.output.stdout), { dispatched: true });
    assert.equal(capture.output.stderr, "");
    const dispatched = dispatchedSpec as Record<string, unknown>;
    assert.equal(dispatched.inputPath, inputPath);
    assert.equal(dispatched.outputPath, outputPath);
    assert.deepEqual(dispatched.upscale, {
      backend: "realesrgan-ncnn-vulkan",
      model: "realesrgan-x4plus",
      aiScale: 4,
    });
    assert.equal("upscaleMode" in dispatched, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process rejects every preview-only flag with exit code 2", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-cli-process-flags-"));
  try {
    const { configPath } = await writeV4Job(root);
    const cases = [
      { flag: "--preview-mode", value: "segment" },
      { flag: "--turn", value: "end" },
      { flag: "--center", value: "1.5" },
      { flag: "--frames", value: "24" },
      { flag: "--output", value: join(root, "preview.mp4") },
      { flag: "--output-dir", value: join(root, "diagnostic") },
    ];
    let processCalls = 0;
    const processVideo: CliDependencies["processVideo"] = async () => {
      processCalls += 1;
      return {} as never;
    };

    for (const entry of cases) {
      const capture = capturedIo();
      const exitCode = await runCli([
        "process", "--config", configPath, entry.flag, entry.value, "--json",
      ], {
        ...capture.dependencies,
        processVideo,
      });
      assert.equal(exitCode, 2, entry.flag);
      assert.equal(capture.output.stdout, "", entry.flag);
      const error = JSON.parse(capture.output.stderr) as { code: string; message: string };
      assert.equal(error.code, "E_INVALID_ARGUMENT", entry.flag);
      assert.ok(error.message.includes(entry.flag), entry.flag);
    }
    assert.equal(processCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli verify always requests a full FFmpeg decode", async () => {
  let receivedOptions: Parameters<CliDependencies["verifyMedia"]>[2];
  const resolveBinaryPaths: CliDependencies["resolveBinaryPaths"] = async () => ({
    ffmpeg: "ffmpeg-test",
    ffprobe: "ffprobe-test",
  });
  const verifyMedia: CliDependencies["verifyMedia"] = async (_input, _expectation, options) => {
    receivedOptions = options;
    return { passed: true, media: {}, checks: [] } as never;
  };
  const capture = capturedIo();
  const exitCode = await runCli([
    "verify", "--input", "output.mp4", "--expected", "{\"width\":2560}", "--json",
  ], {
    ...capture.dependencies,
    resolveBinaryPaths,
    verifyMedia,
  });

  assert.equal(exitCode, 0);
  assert.equal(receivedOptions?.ffmpegPath, "ffmpeg-test");
  assert.equal(receivedOptions?.ffprobePath, "ffprobe-test");
  assert.equal(receivedOptions?.fullDecode, true);
});

test("runCli leaves diagnostic center unset for automatic risk location", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-cli-diagnostic-dispatch-"));
  try {
    const { configPath } = await writeV4Job(root);
    let receivedOptions: Parameters<CliDependencies["diagnosticPreviewVideo"]>[1];
    const diagnosticPreviewVideo: CliDependencies["diagnosticPreviewVideo"] = async (_spec, options) => {
      receivedOptions = options;
      return { dispatched: true } as never;
    };
    const capture = capturedIo();
    const exitCode = await runCli([
      "diagnostic-preview",
      "--config", configPath,
      "--output-dir", join(root, "diagnostic"),
      "--json",
    ], {
      ...capture.dependencies,
      diagnosticPreviewVideo,
    });

    assert.equal(exitCode, 0);
    assert.equal("centerSeconds" in (receivedOptions ?? {}), false);
    assert.equal(receivedOptions?.outputDirectory, join(root, "diagnostic"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
