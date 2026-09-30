import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AppError,
  CACHE_TTL_MS,
  acquireFrameCacheWriteLock,
  acquireJobLock,
  inspectCache,
  registerFrameCacheUse,
  releaseFrameCacheUse,
  runCacheMaintenance,
} from "../src/index.js";

const fingerprint = { path: "D:\\source.mp4", size: 123, modifiedMs: 456 };

async function register(
  workDirectory: string,
  frameCacheKey: string,
  jobId: string,
  now: number,
): Promise<void> {
  await registerFrameCacheUse({ workDirectory, frameCacheKey, jobId, inputFingerprint: fingerprint, now });
}

async function release(
  workDirectory: string,
  frameCacheKey: string,
  jobId: string,
  now: number,
  outcome: "complete" | "recoverable" = "recoverable",
): Promise<void> {
  await releaseFrameCacheUse({ workDirectory, frameCacheKey, jobId, inputFingerprint: fingerprint, now, outcome });
}

test("shared frame cache writes are serialized across jobs", async () => {
  const work = await mkdtemp(join(tmpdir(), "wallpaper-cache-write-lock-"));
  const key = "1".repeat(64);
  const firstJob = "b".repeat(20);
  const secondJob = "c".repeat(20);
  let first: Awaited<ReturnType<typeof acquireFrameCacheWriteLock>> | null = null;
  let second: Awaited<ReturnType<typeof acquireFrameCacheWriteLock>> | null = null;
  let pending: Promise<Awaited<ReturnType<typeof acquireFrameCacheWriteLock>>> | null = null;
  try {
    await register(work, key, firstJob, Date.now());
    await register(work, key, secondJob, Date.now());
    first = await acquireFrameCacheWriteLock({ workDirectory: work, frameCacheKey: key, jobId: firstJob });
    let acquiredSecond = false;
    pending = acquireFrameCacheWriteLock({ workDirectory: work, frameCacheKey: key, jobId: secondJob })
      .then((lock) => {
        acquiredSecond = true;
        return lock;
      });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(acquiredSecond, false);
    await first.release();
    first = null;
    second = await pending;
    assert.equal(acquiredSecond, true);
  } finally {
    await first?.release();
    if (!second && pending) second = await pending.catch(() => null);
    await second?.release();
    await release(work, key, firstJob, Date.now());
    await release(work, key, secondJob, Date.now());
    await rm(work, { recursive: true, force: true });
  }
});

test("a queued frame cache writer honors persistent cancellation", async () => {
  const work = await mkdtemp(join(tmpdir(), "wallpaper-cache-write-cancel-"));
  const key = "2".repeat(64);
  const firstJob = "d".repeat(20);
  const secondJob = "e".repeat(20);
  let first: Awaited<ReturnType<typeof acquireFrameCacheWriteLock>> | null = null;
  let cancelled = false;
  try {
    await register(work, key, firstJob, Date.now());
    await register(work, key, secondJob, Date.now());
    first = await acquireFrameCacheWriteLock({ workDirectory: work, frameCacheKey: key, jobId: firstJob });
    const pending = acquireFrameCacheWriteLock({
      workDirectory: work,
      frameCacheKey: key,
      jobId: secondJob,
      assertNotCancelled: async () => {
        if (cancelled) throw new AppError("E_CANCELLED", "Operation cancelled");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    cancelled = true;
    await assert.rejects(pending, (error: unknown) => error instanceof AppError && error.code === "E_CANCELLED");
  } finally {
    await first?.release();
    await release(work, key, firstJob, Date.now());
    await release(work, key, secondJob, Date.now());
    await rm(work, { recursive: true, force: true });
  }
});

test("recoverable cache is retained before 24 hours and cleaned at the TTL", async () => {
  const work = await mkdtemp(join(tmpdir(), "wallpaper-cache-ttl-"));
  const key = "a".repeat(64);
  const jobId = "1".repeat(20);
  const started = Date.UTC(2026, 6, 12, 0, 0, 0);
  try {
    await register(work, key, jobId, started);
    await writeFile(join(work, "frame-cache", key, "frame.png"), "recoverable");
    await release(work, key, jobId, started);

    const early = await runCacheMaintenance(work, {
      policy: "cleanup-on-success",
      limitBytes: Number.MAX_SAFE_INTEGER,
      now: started + CACHE_TTL_MS - 1,
    });
    assert.equal(early.releasedBytes, 0);
    assert.equal(early.entries[0]?.status, "recoverable");
    assert.deepEqual(early.entries[0]?.activeJobIds, []);
    assert.equal((early.entries[0]?.sizeBytes ?? 0) > 0, true);

    const expired = await runCacheMaintenance(work, {
      policy: "cleanup-on-success",
      limitBytes: Number.MAX_SAFE_INTEGER,
      now: started + CACHE_TTL_MS,
    });
    assert.deepEqual(expired.removedKeys, [key]);
    assert.equal(expired.remainingBytes, 0);
    await assert.rejects(access(join(work, "frame-cache", key)));
    assert.equal((await readdir(join(work, "frame-cache"))).some((entry) => entry.startsWith(".trash-")), false);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("active and shared frame caches are never removed", async () => {
  const work = await mkdtemp(join(tmpdir(), "wallpaper-cache-active-"));
  const key = "b".repeat(64);
  const firstJob = "2".repeat(20);
  const secondJob = "3".repeat(20);
  const now = Date.UTC(2026, 6, 12, 1, 0, 0);
  let firstLock: Awaited<ReturnType<typeof acquireJobLock>> | null = null;
  let secondLock: Awaited<ReturnType<typeof acquireJobLock>> | null = null;
  try {
    const firstDirectory = join(work, "jobs", firstJob);
    const secondDirectory = join(work, "jobs", secondJob);
    firstLock = await acquireJobLock(firstDirectory, firstJob);
    secondLock = await acquireJobLock(secondDirectory, secondJob);
    await Promise.all([
      writeFile(join(firstDirectory, "job-state.json"), JSON.stringify({ frameCacheKey: key, phase: "encode" })),
      writeFile(join(secondDirectory, "job-state.json"), JSON.stringify({ frameCacheKey: key, phase: "encode" })),
    ]);
    await register(work, key, firstJob, now);
    await register(work, key, secondJob, now + 1);
    await writeFile(join(work, "frame-cache", key, "frame.png"), "shared");

    const active = await runCacheMaintenance(work, { force: true, now: now + CACHE_TTL_MS });
    assert.equal(active.releasedBytes, 0);
    assert.deepEqual(active.entries[0]?.activeJobIds, [firstJob, secondJob]);

    await writeFile(join(firstDirectory, "job-state.json"), JSON.stringify({ frameCacheKey: key, phase: "complete" }));
    await release(work, key, firstJob, now + 2, "complete");
    await firstLock.release();
    firstLock = null;
    const shared = await runCacheMaintenance(work, { force: true, now: now + CACHE_TTL_MS });
    assert.equal(shared.releasedBytes, 0);
    assert.deepEqual(shared.entries[0]?.activeJobIds, [secondJob]);

    await writeFile(join(secondDirectory, "job-state.json"), JSON.stringify({ frameCacheKey: key, phase: "complete" }));
    await release(work, key, secondJob, now + 3, "complete");
    await secondLock.release();
    secondLock = null;
    const inactive = await runCacheMaintenance(work, { force: true, now: now + CACHE_TTL_MS });
    assert.deepEqual(inactive.removedKeys, [key]);
  } finally {
    await firstLock?.release();
    await secondLock?.release();
    await rm(work, { recursive: true, force: true });
  }
});

test("maintenance converts a dead active claim to recoverable and force can remove it", async () => {
  const work = await mkdtemp(join(tmpdir(), "wallpaper-cache-dead-active-"));
  const key = "0".repeat(64);
  const jobId = "9".repeat(20);
  const now = Date.UTC(2026, 6, 12, 1, 15, 0);
  const jobDirectory = join(work, "jobs", jobId);
  try {
    await register(work, key, jobId, now);
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(join(work, "frame-cache", key, "frame.png"), "crash-recovery");
    await writeFile(join(jobDirectory, "job-state.json"), JSON.stringify({ frameCacheKey: key, phase: "encode" }));
    await writeFile(join(jobDirectory, ".job.lock"), JSON.stringify({ jobId, pid: 2_147_483_647 }));

    const reconciled = await inspectCache(work, { now: now + 1 });
    assert.equal(reconciled.entries[0]?.status, "recoverable");
    assert.deepEqual(reconciled.entries[0]?.activeJobIds, []);
    assert.deepEqual(reconciled.entries[0]?.recoverableJobIds, [jobId]);

    const cleaned = await runCacheMaintenance(work, { force: true, now: now + 2 });
    assert.deepEqual(cleaned.removedKeys, [key]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("a successful peer cannot clean cache claimed by a recoverable job", async () => {
  const work = await mkdtemp(join(tmpdir(), "wallpaper-cache-shared-recovery-"));
  const key = "f".repeat(64);
  const failedJob = "7".repeat(20);
  const successfulJob = "8".repeat(20);
  const now = Date.UTC(2026, 6, 12, 1, 30, 0);
  try {
    await register(work, key, failedJob, now);
    await writeFile(join(work, "frame-cache", key, "frame.png"), "recoverable");
    await release(work, key, failedJob, now + 1, "recoverable");

    await register(work, key, successfulJob, now + 2);
    await release(work, key, successfulJob, now + 3, "complete");
    const retained = await runCacheMaintenance(work, {
      policy: "cleanup-on-success",
      limitBytes: Number.MAX_SAFE_INTEGER,
      now: now + 4,
    });
    assert.equal(retained.releasedBytes, 0);
    assert.equal(retained.entries[0]?.status, "recoverable");
    assert.deepEqual(retained.entries[0]?.recoverableJobIds, [failedJob]);
    await access(join(work, "frame-cache", key, "frame.png"));

    await register(work, key, failedJob, now + 5);
    await release(work, key, failedJob, now + 6, "complete");
    const cleaned = await runCacheMaintenance(work, {
      policy: "cleanup-on-success",
      limitBytes: Number.MAX_SAFE_INTEGER,
      now: now + 7,
    });
    assert.deepEqual(cleaned.removedKeys, [key]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("old metadata recovers job claims before cleanup-on-success", async () => {
  const work = await mkdtemp(join(tmpdir(), "wallpaper-cache-metadata-upgrade-"));
  const key = "9".repeat(64);
  const failedJob = "a".repeat(20);
  const now = Date.UTC(2026, 6, 12, 1, 45, 0);
  const directory = join(work, "frame-cache", key);
  try {
    await mkdir(directory, { recursive: true });
    await mkdir(join(work, "jobs", failedJob), { recursive: true });
    await writeFile(join(directory, "frame.png"), "recoverable");
    await writeFile(join(directory, "cache-metadata.json"), JSON.stringify({
      schemaVersion: 1,
      createdAt: new Date(now).toISOString(),
      lastAccessAt: new Date(now).toISOString(),
      sizeBytes: 0,
      status: "complete",
      activeJobIds: [],
      frameCacheKey: key,
      inputFingerprint: fingerprint,
    }));
    await writeFile(join(work, "jobs", failedJob, "job-state.json"), JSON.stringify({
      frameCacheKey: key,
      phase: "encode",
    }));

    const retained = await runCacheMaintenance(work, {
      policy: "cleanup-on-success",
      limitBytes: Number.MAX_SAFE_INTEGER,
      now: now + 1,
    });
    assert.equal(retained.releasedBytes, 0);
    assert.equal(retained.entries[0]?.status, "recoverable");
    assert.deepEqual(retained.entries[0]?.recoverableJobIds, [failedJob]);
    await access(join(directory, "frame.png"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("LRU enforces the cache limit without deleting the newest entry", async () => {
  const work = await mkdtemp(join(tmpdir(), "wallpaper-cache-lru-"));
  const older = "c".repeat(64);
  const newer = "d".repeat(64);
  const started = Date.UTC(2026, 6, 12, 2, 0, 0);
  try {
    await register(work, older, "4".repeat(20), started);
    await writeFile(join(work, "frame-cache", older, "payload.bin"), Buffer.alloc(2048));
    await release(work, older, "4".repeat(20), started, "complete");
    await register(work, newer, "5".repeat(20), started + 1000);
    await writeFile(join(work, "frame-cache", newer, "payload.bin"), Buffer.alloc(2048));
    await release(work, newer, "5".repeat(20), started + 1000, "complete");

    const result = await runCacheMaintenance(work, {
      policy: "keep-all",
      limitBytes: 3000,
      now: started + 2000,
    });
    assert.deepEqual(result.removedKeys, [older]);
    assert.equal(result.entries.some((entry) => entry.frameCacheKey === newer), true);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("unrecognized old cache is marked legacy and never silently reused", async () => {
  const work = await mkdtemp(join(tmpdir(), "wallpaper-cache-legacy-"));
  const key = "e".repeat(64);
  const directory = join(work, "frame-cache", key);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "old-frame.png"), "legacy");
    const overview = await inspectCache(work);
    assert.equal(overview.legacyCount, 1);
    assert.equal(overview.entries[0]?.status, "legacy");
    const metadata = JSON.parse(await readFile(join(directory, "cache-metadata.json"), "utf8")) as Record<string, unknown>;
    assert.equal(metadata.status, "legacy");
    assert.equal(metadata.inputFingerprint, null);

    await assert.rejects(
      register(work, key, "6".repeat(20), Date.now()),
      (error) => error instanceof AppError && error.code === "E_JOB_STATE" &&
        (error.details as { status?: string }).status === "legacy",
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("cache cleaner refuses a junction frame-cache root and leaves the target untouched", async (context) => {
  const work = await mkdtemp(join(tmpdir(), "wallpaper-cache-junction-work-"));
  const outside = await mkdtemp(join(tmpdir(), "wallpaper-cache-junction-outside-"));
  const sentinel = join(outside, "sentinel.txt");
  try {
    await writeFile(sentinel, "keep");
    try {
      await symlink(outside, join(work, "frame-cache"), "junction");
    } catch (error) {
      context.skip(`junction creation is unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(
      runCacheMaintenance(work, { force: true }),
      (error) => error instanceof AppError && error.code === "E_INVALID_ARGUMENT",
    );
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
