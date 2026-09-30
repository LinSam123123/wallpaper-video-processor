import assert from "node:assert/strict";
import { access, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError, cleanupFrameCache } from "../src/index.js";

test("frame cache cleanup removes only the validated cache and is idempotent", async () => {
  const workDirectory = await mkdtemp(join(tmpdir(), "wallpaper-frame-cache-"));
  const key = "a".repeat(64);
  const neighborKey = "b".repeat(64);
  const target = join(workDirectory, "frame-cache", key);
  const neighbor = join(workDirectory, "frame-cache", neighborKey);
  const outside = join(workDirectory, "outside.txt");
  try {
    await mkdir(join(target, "enhanced-frames"), { recursive: true });
    await mkdir(neighbor, { recursive: true });
    await writeFile(join(target, "enhanced-frames", "frame_00000001.png"), "target");
    await writeFile(join(neighbor, "keep.txt"), "neighbor");
    await writeFile(outside, "outside");

    await cleanupFrameCache(key, workDirectory);
    await assert.rejects(access(target));
    assert.equal(await readFile(join(neighbor, "keep.txt"), "utf8"), "neighbor");
    assert.equal(await readFile(outside, "utf8"), "outside");

    await cleanupFrameCache(key, workDirectory);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

test("frame cache cleanup rejects traversal and malformed keys", async () => {
  const workDirectory = await mkdtemp(join(tmpdir(), "wallpaper-frame-cache-invalid-"));
  const sentinel = join(workDirectory, "sentinel.txt");
  await writeFile(sentinel, "keep");
  try {
    for (const key of ["../sentinel.txt", "a".repeat(63), "A".repeat(64), "a".repeat(64) + "/outside"]) {
      await assert.rejects(
        cleanupFrameCache(key, workDirectory),
        (error) => error instanceof AppError && error.code === "E_INVALID_ARGUMENT",
      );
    }
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

test("frame cache cleanup removes referencing jobs and releases their hard links", async () => {
  const workDirectory = await mkdtemp(join(tmpdir(), "wallpaper-frame-cache-links-"));
  const key = "c".repeat(64);
  const jobId = "1".repeat(20);
  const cachedFrame = join(workDirectory, "frame-cache", key, "enhanced-frames", "frame_00000001.png");
  const sequenceFrame = join(workDirectory, "jobs", jobId, "sequence", "frame_00000001.png");
  const survivor = join(workDirectory, "survivor.png");
  try {
    await mkdir(join(workDirectory, "frame-cache", key, "enhanced-frames"), { recursive: true });
    await mkdir(join(workDirectory, "jobs", jobId, "sequence"), { recursive: true });
    await writeFile(cachedFrame, "shared frame");
    await link(cachedFrame, sequenceFrame);
    await link(cachedFrame, survivor);
    await writeFile(join(workDirectory, "jobs", jobId, "job-state.json"), JSON.stringify({
      jobId,
      frameCacheKey: key,
    }));
    assert.equal((await stat(survivor)).nlink, 3);

    await cleanupFrameCache(key, workDirectory);

    await assert.rejects(access(join(workDirectory, "jobs", jobId)));
    await assert.rejects(access(join(workDirectory, "frame-cache", key)));
    assert.equal(await readFile(survivor, "utf8"), "shared frame");
    for (let attempt = 0; attempt < 100 && (await stat(survivor)).nlink !== 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await stat(survivor)).nlink, 1);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});
