import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "./errors.js";
import type { InputFingerprint } from "./job-state.js";
import type {
  CacheEntryStatus,
  CacheMaintenanceResult,
  CachePolicy,
  FrameCacheMetadata,
} from "./types.js";

export const FRAME_CACHE_SCHEMA_VERSION = 2;
export const DEFAULT_CACHE_POLICY: CachePolicy = "cleanup-on-success";
export const DEFAULT_CACHE_LIMIT_BYTES = 50 * 1024 * 1024 * 1024;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const METADATA_FILE = "cache-metadata.json";
const METADATA_LOCK_FILE = ".metadata.lock";
const DELETING_FILE = ".deleting";
const JOB_LOCK_FILE = ".job.lock";
const FRAME_CACHE_WRITE_LOCK_FILE = ".frame-cache.write.lock";
const MALFORMED_LOCK_GRACE_MS = 5_000;
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const JOB_PATTERN = /^[a-f0-9]{20}$/;

export interface JobLockHandle {
  path: string;
  release(): Promise<void>;
}

export interface CacheUseRegistration {
  workDirectory: string;
  frameCacheKey: string;
  jobId: string;
  inputFingerprint: InputFingerprint;
  now?: number;
}

export interface CacheUseRelease extends CacheUseRegistration {
  outcome: "complete" | "recoverable";
}

export interface CacheMaintenanceOptions {
  policy?: CachePolicy;
  limitBytes?: number;
  force?: boolean;
  now?: number;
}

function iso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function validLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CACHE_LIMIT_BYTES;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError("E_INVALID_ARGUMENT", "Cache limit must be a non-negative safe integer");
  }
  return value;
}

function cacheRoot(workDirectory: string): string {
  return resolve(workDirectory, "frame-cache");
}

function checkedCacheDirectory(workDirectory: string, key: string): string {
  if (!KEY_PATTERN.test(key)) throw new AppError("E_INVALID_ARGUMENT", "Invalid frame cache key");
  const root = cacheRoot(workDirectory);
  const target = resolve(root, key);
  if (dirname(target) !== root) {
    throw new AppError("E_INVALID_ARGUMENT", "Frame cache path escapes its work directory");
  }
  return target;
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AppError("E_INVALID_ARGUMENT", `${label} must be a real directory, not a link`, { path });
  }
}

async function prepareSafeRoots(workDirectory: string): Promise<{ work: string; frameRoot: string; jobsRoot: string }> {
  const work = resolve(workDirectory);
  const frameRoot = cacheRoot(work);
  const jobsRoot = resolve(work, "jobs");
  await mkdir(work, { recursive: true });
  await assertPlainDirectory(work, "Work root");
  await Promise.all([mkdir(frameRoot, { recursive: true }), mkdir(jobsRoot, { recursive: true })]);
  await Promise.all([
    assertPlainDirectory(frameRoot, "Frame cache root"),
    assertPlainDirectory(jobsRoot, "Jobs root"),
  ]);
  const [realWork, realFrame, realJobs] = await Promise.all([realpath(work), realpath(frameRoot), realpath(jobsRoot)]);
  if (dirname(realFrame) !== realWork || dirname(realJobs) !== realWork) {
    throw new AppError("E_INVALID_ARGUMENT", "Cache roots escape the selected work directory", {
      work: realWork,
      frameRoot: realFrame,
      jobsRoot: realJobs,
    });
  }
  return { work, frameRoot, jobsRoot };
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if ([
      METADATA_FILE,
      METADATA_LOCK_FILE,
      DELETING_FILE,
      FRAME_CACHE_WRITE_LOCK_FILE,
      `${FRAME_CACHE_WRITE_LOCK_FILE}.recovery`,
    ].includes(entry.name)) continue;
    const child = join(path, entry.name);
    const info = await lstat(child).catch(() => null);
    if (!info || info.isSymbolicLink()) continue;
    if (info.isDirectory()) total += await directorySize(child);
    else if (info.isFile()) total += info.size;
  }
  return total;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isMetadata(value: unknown, key: string): value is FrameCacheMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 &&
    record.frameCacheKey === key &&
    typeof record.createdAt === "string" &&
    typeof record.lastAccessAt === "string" &&
    typeof record.sizeBytes === "number" &&
    ["active", "recoverable", "complete", "legacy"].includes(String(record.status)) &&
    Array.isArray(record.activeJobIds) && record.activeJobIds.every((id) => typeof id === "string" && JOB_PATTERN.test(id)) &&
    (record.recoverableJobIds === undefined ||
      (Array.isArray(record.recoverableJobIds) &&
        record.recoverableJobIds.every((id) => typeof id === "string" && JOB_PATTERN.test(id))));
}

async function readMetadata(directory: string, key: string): Promise<FrameCacheMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, METADATA_FILE), "utf8")) as unknown;
    return isMetadata(parsed, key) ? parsed : null;
  } catch {
    return null;
  }
}

async function lockMetadata(directory: string): Promise<FileHandle> {
  const path = join(directory, METADATA_LOCK_FILE);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await open(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(path).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > 60 * 60 * 1000) await rm(path, { force: true }).catch(() => undefined);
      else await delay(25);
    }
  }
  throw new AppError("E_JOB_STATE", "Timed out waiting for the frame cache metadata lock", { directory });
}

async function withMetadataLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true });
  const handle = await lockMetadata(directory);
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(join(directory, METADATA_LOCK_FILE), { force: true }).catch(() => undefined);
  }
}

async function legacyMetadata(directory: string, key: string, now: number): Promise<FrameCacheMetadata> {
  const info = await stat(directory);
  const created = Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
  return {
    schemaVersion: 1,
    createdAt: iso(created),
    lastAccessAt: iso(info.mtimeMs || now),
    sizeBytes: await directorySize(directory),
    status: "legacy",
    activeJobIds: [],
    recoverableJobIds: [],
    frameCacheKey: key,
    inputFingerprint: null,
  };
}

async function referencingRecoverableJobIds(jobsRoot: string, key: string): Promise<string[]> {
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  const jobIds: string[] = [];
  for (const entry of entries) {
    if (!JOB_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const state = JSON.parse(await readFile(join(jobsRoot, entry.name, "job-state.json"), "utf8")) as Record<string, unknown>;
      if (state.frameCacheKey === key && state.phase !== "complete") jobIds.push(entry.name);
    } catch {
      // An unreadable state cannot be resumed reliably and does not claim shared cache data.
    }
  }
  return jobIds.sort();
}

async function jobLockOwnerIsAlive(path: string): Promise<boolean> {
  try {
    const contents = await readFile(path, "utf8");
    let parsed: { pid?: unknown };
    try {
      parsed = JSON.parse(contents) as { pid?: unknown };
    } catch {
      const info = await stat(path);
      return Date.now() - info.mtimeMs < MALFORMED_LOCK_GRACE_MS;
    }
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) {
      const info = await stat(path);
      return Date.now() - info.mtimeMs < MALFORMED_LOCK_GRACE_MS;
    }
    const pid = parsed.pid as number;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function createJobLockFile(path: string, jobId: string): Promise<FileHandle> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify({ jobId, pid: process.pid, createdAt: iso() })}\n`, "utf8");
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireRecoveryClaim(path: string, jobId: string): Promise<FileHandle> {
  try {
    return await createJobLockFile(path, jobId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await jobLockOwnerIsAlive(path)) throw error;
    await rm(path, { force: true });
    return await createJobLockFile(path, jobId);
  }
}

export async function acquireJobLock(jobDirectory: string, jobId: string): Promise<JobLockHandle> {
  if (!JOB_PATTERN.test(jobId)) throw new AppError("E_INVALID_ARGUMENT", "Invalid job id");
  await mkdir(jobDirectory, { recursive: true });
  const path = join(jobDirectory, JOB_LOCK_FILE);
  const recoveryPath = `${path}.recovery`;
  let handle: FileHandle;
  try {
    handle = await createJobLockFile(path, jobId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await jobLockOwnerIsAlive(path)) {
      throw new AppError("E_JOB_STATE", "This job is already active", { jobId, lockPath: path }, { cause: error });
    }
    let recovery: FileHandle;
    try {
      recovery = await acquireRecoveryClaim(recoveryPath, jobId);
    } catch (recoveryError) {
      throw new AppError("E_JOB_STATE", "This job is already being recovered", { jobId, lockPath: path }, { cause: recoveryError });
    }
    try {
      if (await jobLockOwnerIsAlive(path)) {
        throw new AppError("E_JOB_STATE", "This job became active while recovering its stale lock", { jobId, lockPath: path });
      }
      await rm(path, { force: true });
      handle = await createJobLockFile(path, jobId);
    } catch (recoveryError) {
      throw recoveryError instanceof AppError
        ? recoveryError
        : new AppError("E_JOB_STATE", "Could not replace a stale job lock", { jobId, lockPath: path }, { cause: recoveryError });
    } finally {
      await recovery.close().catch(() => undefined);
      await rm(recoveryPath, { force: true }).catch(() => undefined);
    }
  }
  let released = false;
  return {
    path,
    async release() {
      if (released) return;
      released = true;
      await handle.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
    },
  };
}

export async function acquireFrameCacheWriteLock(input: {
  workDirectory: string;
  frameCacheKey: string;
  jobId: string;
  signal?: AbortSignal;
  assertNotCancelled?: () => Promise<void>;
}): Promise<JobLockHandle> {
  if (!JOB_PATTERN.test(input.jobId)) throw new AppError("E_INVALID_ARGUMENT", "Invalid job id");
  const roots = await prepareSafeRoots(input.workDirectory);
  const directory = checkedCacheDirectory(roots.work, input.frameCacheKey);
  if (!await access(directory).then(() => true, () => false)) {
    throw new AppError("E_JOB_STATE", "Frame cache must be registered before acquiring its write lock", {
      frameCacheKey: input.frameCacheKey,
    });
  }
  await assertPlainDirectory(directory, "Frame cache directory");
  const path = join(directory, FRAME_CACHE_WRITE_LOCK_FILE);
  const recoveryPath = `${path}.recovery`;

  for (;;) {
    if (input.signal?.aborted) throw new AppError("E_CANCELLED", "Operation cancelled");
    await input.assertNotCancelled?.();
    try {
      const handle = await createJobLockFile(path, input.jobId);
      let released = false;
      return {
        path,
        release: async () => {
          if (released) return;
          released = true;
          await handle.close().catch(() => undefined);
          await rm(path, { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (!await jobLockOwnerIsAlive(path)) {
      let recovery: FileHandle | null = null;
      let recoveryBusy = false;
      try {
        recovery = await acquireRecoveryClaim(recoveryPath, input.jobId);
        if (!await jobLockOwnerIsAlive(path)) await rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        recoveryBusy = true;
      } finally {
        await recovery?.close().catch(() => undefined);
        if (recovery) await rm(recoveryPath, { force: true }).catch(() => undefined);
      }
      if (recoveryBusy) await delay(100);
      continue;
    }
    await delay(100);
  }
}

export async function registerFrameCacheUse(input: CacheUseRegistration): Promise<FrameCacheMetadata> {
  const roots = await prepareSafeRoots(input.workDirectory);
  const directory = checkedCacheDirectory(roots.work, input.frameCacheKey);
  const now = input.now ?? Date.now();
  const existed = await access(directory).then(() => true, () => false);
  await mkdir(directory, { recursive: true });
  await assertPlainDirectory(directory, "Frame cache directory");
  return await withMetadataLock(directory, async () => {
    if (await access(join(directory, DELETING_FILE)).then(() => true, () => false)) {
      throw new AppError("E_JOB_STATE", "Frame cache is being cleaned", { frameCacheKey: input.frameCacheKey });
    }
    let metadata = await readMetadata(directory, input.frameCacheKey);
    if (!metadata && existed) {
      metadata = await legacyMetadata(directory, input.frameCacheKey, now);
      await atomicJson(join(directory, METADATA_FILE), metadata);
      throw new AppError("E_JOB_STATE", "Legacy frame cache cannot be reused by v0.3.1", {
        frameCacheKey: input.frameCacheKey,
        status: "legacy",
      });
    }
    metadata ??= {
      schemaVersion: 1,
      createdAt: iso(now),
      lastAccessAt: iso(now),
      sizeBytes: 0,
      status: "recoverable",
      activeJobIds: [],
      recoverableJobIds: [],
      frameCacheKey: input.frameCacheKey,
      inputFingerprint: input.inputFingerprint,
    };
    if (metadata.status === "legacy") {
      throw new AppError("E_JOB_STATE", "Legacy frame cache cannot be reused by v0.3.1", {
        frameCacheKey: input.frameCacheKey,
        status: "legacy",
      });
    }
    metadata.recoverableJobIds ??= await referencingRecoverableJobIds(roots.jobsRoot, input.frameCacheKey);
    if (!metadata.activeJobIds.includes(input.jobId)) metadata.activeJobIds.push(input.jobId);
    metadata.activeJobIds.sort();
    metadata.status = "active";
    metadata.lastAccessAt = iso(now);
    metadata.inputFingerprint = input.inputFingerprint;
    metadata.sizeBytes = await directorySize(directory);
    await atomicJson(join(directory, METADATA_FILE), metadata);
    return metadata;
  });
}

export async function releaseFrameCacheUse(input: CacheUseRelease): Promise<FrameCacheMetadata | null> {
  const roots = await prepareSafeRoots(input.workDirectory);
  const directory = checkedCacheDirectory(roots.work, input.frameCacheKey);
  if (!await access(directory).then(() => true, () => false)) return null;
  const now = input.now ?? Date.now();
  return await withMetadataLock(directory, async () => {
    const metadata = await readMetadata(directory, input.frameCacheKey);
    if (!metadata || metadata.status === "legacy") return metadata;
    metadata.recoverableJobIds ??= await referencingRecoverableJobIds(roots.jobsRoot, input.frameCacheKey);
    metadata.activeJobIds = metadata.activeJobIds.filter((id) => id !== input.jobId);
    const recoverableJobIds = new Set(metadata.recoverableJobIds);
    if (input.outcome === "recoverable") recoverableJobIds.add(input.jobId);
    else recoverableJobIds.delete(input.jobId);
    metadata.recoverableJobIds = [...recoverableJobIds].sort();
    metadata.status = cacheStatusAfterRelease(metadata.activeJobIds, input.outcome, metadata.recoverableJobIds);
    metadata.lastAccessAt = iso(now);
    metadata.sizeBytes = await directorySize(directory);
    await atomicJson(join(directory, METADATA_FILE), metadata);
    return metadata;
  });
}

async function referencingActiveJob(jobsRoot: string, key: string): Promise<boolean> {
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!JOB_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const jobDirectory = join(jobsRoot, entry.name);
    if (!await jobLockOwnerIsAlive(join(jobDirectory, JOB_LOCK_FILE))) continue;
    try {
      const state = JSON.parse(await readFile(join(jobDirectory, "job-state.json"), "utf8")) as Record<string, unknown>;
      if (state.frameCacheKey === key) return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function removeReferencingInactiveJobs(jobsRoot: string, key: string): Promise<void> {
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!JOB_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const jobDirectory = join(jobsRoot, entry.name);
    if (await jobLockOwnerIsAlive(join(jobDirectory, JOB_LOCK_FILE))) continue;
    try {
      const state = JSON.parse(await readFile(join(jobDirectory, "job-state.json"), "utf8")) as Record<string, unknown>;
      if (state.frameCacheKey === key) await rm(jobDirectory, { recursive: true, force: true });
    } catch {
      // Unknown job directories are not owned strongly enough to delete.
    }
  }
}

async function reconcileJobClaims(
  jobsRoot: string,
  metadata: FrameCacheMetadata,
): Promise<FrameCacheMetadata> {
  if (metadata.status === "legacy") return metadata;
  const hadActiveClaim = metadata.status === "active" || metadata.activeJobIds.length > 0;
  const liveJobIds: string[] = [];
  for (const jobId of metadata.activeJobIds) {
    if (await jobLockOwnerIsAlive(join(jobsRoot, jobId, JOB_LOCK_FILE))) liveJobIds.push(jobId);
  }
  metadata.activeJobIds = liveJobIds.sort();
  const recoverableJobIds = new Set(metadata.recoverableJobIds ?? []);
  for (const jobId of await referencingRecoverableJobIds(jobsRoot, metadata.frameCacheKey)) {
    if (!metadata.activeJobIds.includes(jobId)) recoverableJobIds.add(jobId);
  }
  metadata.recoverableJobIds = [...recoverableJobIds].sort();
  if (metadata.activeJobIds.length > 0) metadata.status = "active";
  else if (hadActiveClaim || metadata.recoverableJobIds.length > 0) metadata.status = "recoverable";
  return metadata;
}

async function deleteTrash(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
}

async function trashCache(
  roots: { frameRoot: string; jobsRoot: string },
  metadata: FrameCacheMetadata,
): Promise<{ removed: boolean; bytes: number; error?: string }> {
  if (metadata.activeJobIds.length > 0 || await referencingActiveJob(roots.jobsRoot, metadata.frameCacheKey)) {
    return { removed: false, bytes: 0 };
  }
  const directory = checkedCacheDirectory(dirname(roots.frameRoot), metadata.frameCacheKey);
  const trash = join(roots.frameRoot, `.trash-${randomUUID()}`);
  try {
    const reserved = await withMetadataLock(directory, async () => {
      const current = await readMetadata(directory, metadata.frameCacheKey) ??
        (metadata.status === "legacy" ? metadata : null);
      if (!current || current.activeJobIds.length > 0 || current.status === "active") return false;
      await writeFile(join(directory, DELETING_FILE), iso(), { encoding: "utf8", flag: "wx" });
      metadata.sizeBytes = current.sizeBytes;
      return true;
    });
    if (!reserved || await referencingActiveJob(roots.jobsRoot, metadata.frameCacheKey)) {
      await rm(join(directory, DELETING_FILE), { force: true }).catch(() => undefined);
      return { removed: false, bytes: 0 };
    }
    await removeReferencingInactiveJobs(roots.jobsRoot, metadata.frameCacheKey);
    await rename(directory, trash);
    await deleteTrash(trash);
    return { removed: true, bytes: metadata.sizeBytes };
  } catch (error) {
    await rm(join(directory, DELETING_FILE), { force: true }).catch(() => undefined);
    return { removed: false, bytes: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function scanCaches(
  roots: { frameRoot: string; jobsRoot: string },
  now: number,
): Promise<FrameCacheMetadata[]> {
  const entries = await readdir(roots.frameRoot, { withFileTypes: true }).catch(() => []);
  const result: FrameCacheMetadata[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".trash-")) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await deleteTrash(join(roots.frameRoot, entry.name));
      }
      continue;
    }
    if (!KEY_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = join(roots.frameRoot, entry.name);
    if (await access(join(directory, METADATA_LOCK_FILE)).then(() => true, () => false)) continue;
    let metadata = await readMetadata(directory, entry.name);
    if (!metadata) {
      metadata = await legacyMetadata(directory, entry.name, now);
      await atomicJson(join(directory, METADATA_FILE), metadata).catch(() => undefined);
    } else {
      if (metadata.recoverableJobIds === undefined) {
        metadata.recoverableJobIds = await referencingRecoverableJobIds(roots.jobsRoot, entry.name);
        if (metadata.activeJobIds.length === 0 && metadata.recoverableJobIds.length > 0) {
          metadata.status = "recoverable";
        }
      }
      metadata = await reconcileJobClaims(roots.jobsRoot, metadata);
      metadata.sizeBytes = await directorySize(directory);
      await atomicJson(join(directory, METADATA_FILE), metadata).catch(() => undefined);
    }
    result.push(metadata);
  }
  return result;
}

function isExpired(metadata: FrameCacheMetadata, policy: CachePolicy, now: number): boolean {
  if (metadata.status === "legacy" || metadata.status === "active") return false;
  const age = now - Date.parse(metadata.lastAccessAt);
  if (policy === "keep-all") return false;
  if (policy === "cleanup-on-success" && metadata.status === "complete") return true;
  return age >= CACHE_TTL_MS;
}

export async function runCacheMaintenance(
  workDirectory: string,
  options: CacheMaintenanceOptions = {},
): Promise<CacheMaintenanceResult> {
  const roots = await prepareSafeRoots(workDirectory);
  const now = options.now ?? Date.now();
  const policy = options.policy ?? DEFAULT_CACHE_POLICY;
  const limitBytes = validLimit(options.limitBytes);
  const entries = await scanCaches(roots, now);
  const errors: string[] = [];
  const removedKeys: string[] = [];
  let releasedBytes = 0;
  const removed = new Set<string>();

  const candidates = entries
    .filter((entry) => entry.activeJobIds.length === 0 && entry.status !== "active")
    .sort((left, right) => Date.parse(left.lastAccessAt) - Date.parse(right.lastAccessAt));

  for (const metadata of candidates) {
    if (!options.force && !isExpired(metadata, policy, now)) continue;
    const result = await trashCache(roots, metadata);
    if (result.error) errors.push(`${metadata.frameCacheKey}: ${result.error}`);
    if (!result.removed) continue;
    removed.add(metadata.frameCacheKey);
    removedKeys.push(metadata.frameCacheKey);
    releasedBytes += result.bytes;
  }

  let remainingEntries = entries.filter((entry) => !removed.has(entry.frameCacheKey));
  let remainingBytes = remainingEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (!options.force && remainingBytes > limitBytes) {
    const lru = remainingEntries
      .filter((entry) => entry.status !== "active" && entry.status !== "legacy" && entry.activeJobIds.length === 0)
      .sort((left, right) => Date.parse(left.lastAccessAt) - Date.parse(right.lastAccessAt));
    for (const metadata of lru) {
      if (remainingBytes <= limitBytes) break;
      const result = await trashCache(roots, metadata);
      if (result.error) errors.push(`${metadata.frameCacheKey}: ${result.error}`);
      if (!result.removed) continue;
      removed.add(metadata.frameCacheKey);
      removedKeys.push(metadata.frameCacheKey);
      releasedBytes += result.bytes;
      remainingBytes -= result.bytes;
    }
    remainingEntries = entries.filter((entry) => !removed.has(entry.frameCacheKey));
  }

  return {
    workDirectory: roots.work,
    cacheDirectory: roots.frameRoot,
    policy,
    limitBytes,
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    releasedBytes,
    remainingBytes: remainingEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    removedKeys,
    legacyCount: remainingEntries.filter((entry) => entry.status === "legacy").length,
    entries: remainingEntries,
    errors,
  };
}

export async function inspectCache(
  workDirectory: string,
  options: Omit<CacheMaintenanceOptions, "force"> = {},
): Promise<CacheMaintenanceResult> {
  const roots = await prepareSafeRoots(workDirectory);
  const policy = options.policy ?? DEFAULT_CACHE_POLICY;
  const limitBytes = validLimit(options.limitBytes);
  const entries = await scanCaches(roots, options.now ?? Date.now());
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return {
    workDirectory: roots.work,
    cacheDirectory: roots.frameRoot,
    policy,
    limitBytes,
    totalBytes,
    releasedBytes: 0,
    remainingBytes: totalBytes,
    removedKeys: [],
    legacyCount: entries.filter((entry) => entry.status === "legacy").length,
    entries,
    errors: [],
  };
}

export async function cleanupOneFrameCache(frameCacheKey: string, workDirectory: string): Promise<void> {
  const roots = await prepareSafeRoots(workDirectory);
  const directory = checkedCacheDirectory(roots.work, frameCacheKey);
  if (!await access(directory).then(() => true, () => false)) return;
  const metadata = await reconcileJobClaims(
    roots.jobsRoot,
    await readMetadata(directory, frameCacheKey) ?? await legacyMetadata(directory, frameCacheKey, Date.now()),
  );
  await atomicJson(join(directory, METADATA_FILE), metadata);
  if (metadata.activeJobIds.length > 0 || await referencingActiveJob(roots.jobsRoot, frameCacheKey)) {
    throw new AppError("E_JOB_STATE", "Active frame cache cannot be deleted", { frameCacheKey });
  }
  const result = await trashCache(roots, metadata);
  if (result.error) throw new AppError("E_IO", "Could not move frame cache to trash", { frameCacheKey, error: result.error });
}

export function cacheStatusAfterRelease(
  activeJobIds: string[],
  outcome: CacheEntryStatus,
  recoverableJobIds: string[] = [],
): CacheEntryStatus {
  if (activeJobIds.length > 0) return "active";
  return outcome === "recoverable" || recoverableJobIds.length > 0 ? "recoverable" : outcome;
}
