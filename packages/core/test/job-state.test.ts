import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AppError,
  acquireJobLock,
  assertNotCancelled,
  buildFrameSequence,
  clearCancellation,
  frameFileName,
  loadJobState,
  requestCancellation,
  saveJobState,
  type JobState,
} from "../src/index.js";

test("job locks reject live owners and recover a dead process lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-job-lock-"));
  const jobId = "b".repeat(20);
  const lockPath = join(root, ".job.lock");
  try {
    const active = await acquireJobLock(root, jobId);
    await assert.rejects(
      acquireJobLock(root, jobId),
      (error) => error instanceof AppError && error.code === "E_JOB_STATE",
    );
    await active.release();

    await writeFile(lockPath, `${JSON.stringify({ jobId, pid: 2_147_483_647, createdAt: new Date(0).toISOString() })}\n`);
    await writeFile(`${lockPath}.recovery`, `${JSON.stringify({ jobId, pid: 2_147_483_647, createdAt: new Date(0).toISOString() })}\n`);
    const recovered = await acquireJobLock(root, jobId);
    await recovered.release();
    await assert.rejects(readFile(lockPath));
    await assert.rejects(readFile(`${lockPath}.recovery`));

    await writeFile(lockPath, "{");
    await assert.rejects(
      acquireJobLock(root, jobId),
      (error) => error instanceof AppError && error.code === "E_JOB_STATE",
    );
    const staleTime = new Date(Date.now() - 10_000);
    await utimes(lockPath, staleTime, staleTime);
    await writeFile(`${lockPath}.recovery`, "{");
    await utimes(`${lockPath}.recovery`, staleTime, staleTime);
    const malformedRecovered = await acquireJobLock(root, jobId);
    await malformedRecovered.release();
    await assert.rejects(readFile(lockPath));
    await assert.rejects(readFile(`${lockPath}.recovery`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task state is atomic, cancellation is persistent, and sequence files are reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-state-"));
  const source = join(root, "source");
  const sequence = join(root, "sequence");
  await mkdir(source);
  for (let index = 0; index < 3; index += 1) await writeFile(join(source, frameFileName(index)), `frame ${index}`);
  const state: JobState = {
    schemaVersion: 1,
    jobId: "a".repeat(20),
    specHash: "hash",
    input: { path: "source.mp4", size: 1, modifiedMs: 1 },
    phase: "upscale",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    sourceFrameCount: 3,
    completedUpscaleFrames: [0],
    selectedTile: 256,
    outputFrameCount: 4,
    outputPath: "result.mp4",
  };
  try {
    await saveJobState(root, state);
    assert.deepEqual((await loadJobState(root))?.completedUpscaleFrames, [0]);
    const first = await buildFrameSequence(source, sequence, [0, 1, 2, 1]);
    assert.equal(first.linked + first.copied, 4);
    assert.equal(await readFile(join(sequence, frameFileName(3)), "utf8"), "frame 1");
    const second = await buildFrameSequence(source, sequence, [0, 1, 2, 1]);
    assert.equal(second.existing, 4);
    await requestCancellation(root);
    await assert.rejects(assertNotCancelled(root), (error) => error instanceof AppError && error.code === "E_CANCELLED");
    await clearCancellation(root);
    await assertNotCancelled(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
