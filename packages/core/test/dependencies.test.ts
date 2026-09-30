import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AppError,
  assertSafeArchiveEntry,
  downloadAndVerify,
  safeExtractArchive,
  validateDependencyManifest,
  type CommandRunner,
  type DependencyArtifact,
} from "../src/index.js";

function artifact(sha256: string): DependencyArtifact {
  return {
    id: "ffmpeg",
    displayName: "FFmpeg test artifact",
    version: "1.0.0",
    sourcePage: "https://example.test/source",
    downloadUrl: "https://example.test/ffmpeg.zip",
    license: "GPL-3.0-or-later",
    licenseUrl: "https://example.test/license",
    approximateSizeBytes: 4,
    sha256,
    archive: "zip",
    executablePaths: ["bin/ffmpeg.exe", "bin/ffprobe.exe"],
  };
}

test("archive entry validation rejects traversal and absolute paths", () => {
  const destination = join(tmpdir(), "extract-target");
  assert.equal(assertSafeArchiveEntry("bin/ffmpeg.exe", destination), join(destination, "bin", "ffmpeg.exe"));
  for (const entry of ["../outside", "bin/../../outside", "C:\\outside.exe", "/outside", "file:stream", "NUL.txt"]) {
    assert.throws(() => assertSafeArchiveEntry(entry, destination), (error) => error instanceof AppError && error.code === "E_UNSAFE_ARCHIVE");
  }
});

test("manifest requires HTTPS and a real-shaped fixed SHA-256", () => {
  const valid = validateDependencyManifest({ schemaVersion: 1, platform: "win32-x64", artifacts: [artifact("a".repeat(64))] });
  assert.equal(valid.artifacts[0]?.id, "ffmpeg");
  assert.throws(() => validateDependencyManifest({
    schemaVersion: 1,
    platform: "win32-x64",
    artifacts: [artifact("not-configured")],
  }), /fixed SHA-256/);
});

test("production manifest pins the reviewed RIFE Windows artifact", async () => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const manifest = validateDependencyManifest(JSON.parse(
    await readFile(join(repositoryRoot, "resources", "dependencies.json"), "utf8"),
  ));
  assert.deepEqual(manifest.artifacts.find((entry) => entry.id === "rife"), {
    id: "rife",
    displayName: "RIFE ncnn Vulkan",
    version: "20221029",
    sourcePage: "https://github.com/nihui/rife-ncnn-vulkan/releases/tag/20221029",
    downloadUrl: "https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip",
    license: "MIT",
    licenseUrl: "https://github.com/nihui/rife-ncnn-vulkan/blob/master/LICENSE",
    approximateSizeBytes: 431_540_241,
    sha256: "d8e4d772d26cd8006ef0ad0bc82eb191b53c68677d1ae2f42506d74cbbbea606",
    archive: "zip",
    executablePaths: ["rife-ncnn-vulkan.exe"],
  });
});

test("download requires consent and verifies bytes before publishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallpaper-dependency-"));
  try {
    const bytes = Buffer.from("trusted artifact");
    const sha = createHash("sha256").update(bytes).digest("hex");
    await assert.rejects(downloadAndVerify(artifact(sha), directory, { consent: false }), /explicit consent/);
    const path = await downloadAndVerify(artifact(sha), directory, {
      consent: true,
      fetchImpl: (async () => new Response(bytes)) as typeof fetch,
    });
    assert.deepEqual(await readFile(path), bytes);
    await assert.rejects(downloadAndVerify(artifact("0".repeat(64)), directory, {
      consent: true,
      fetchImpl: (async () => new Response(bytes)) as typeof fetch,
    }), (error) => error instanceof AppError && error.code === "E_CHECKSUM_MISMATCH");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe extraction rejects malicious listings before extraction", async () => {
  let calls = 0;
  const runner: CommandRunner = async () => {
    calls += 1;
    return { exitCode: 0, stdout: "../outside.exe\n", stderr: "" };
  };
  await assert.rejects(safeExtractArchive("archive.zip", join(tmpdir(), "unused-target"), { runner }),
    (error) => error instanceof AppError && error.code === "E_UNSAFE_ARCHIVE");
  assert.equal(calls, 1);
});

test("safe extraction flattens one archive root directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallpaper-extract-"));
  const destination = join(directory, "installed");
  const runner: CommandRunner = async (spec) => {
    if (spec.args.includes("-tf")) return { exitCode: 0, stdout: "bundle/bin/tool.exe\n", stderr: "" };
    if (spec.args.includes("-tvf")) return { exitCode: 0, stdout: "-rw-r--r-- bundle/bin/tool.exe\n", stderr: "" };
    const outputIndex = spec.args.indexOf("-C");
    const staging = spec.args[outputIndex + 1];
    assert.ok(staging);
    await mkdir(join(staging, "bundle", "bin"), { recursive: true });
    await writeFile(join(staging, "bundle", "bin", "tool.exe"), "fixture");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  try {
    await safeExtractArchive("archive.zip", destination, { runner });
    await access(join(destination, "bin", "tool.exe"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
