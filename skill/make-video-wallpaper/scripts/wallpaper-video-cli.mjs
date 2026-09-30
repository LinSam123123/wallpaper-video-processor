#!/usr/bin/env node

// apps/cli/src/index.ts
import { readFile as readFile3 } from "node:fs/promises";
import { dirname as dirname5, isAbsolute, resolve as resolve6 } from "node:path";
import { pathToFileURL } from "node:url";

// packages/core/dist/errors.js
var AppError = class extends Error {
  code;
  details;
  constructor(code, message, details, options) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...this.details === void 0 ? {} : { details: this.details }
    };
  }
};
function toAppError(error, fallbackCode = "E_IO") {
  if (error instanceof AppError)
    return error;
  if (error instanceof Error) {
    return new AppError(fallbackCode, error.message, void 0, { cause: error });
  }
  return new AppError(fallbackCode, String(error));
}

// packages/core/dist/process-runner.js
import { spawn } from "node:child_process";
function boundedAppend(current, chunk, maxBytes) {
  const combined = current + chunk;
  return combined.length <= maxBytes ? combined : combined.slice(combined.length - maxBytes);
}
var runCommand = async (spec, options = {}) => {
  if (options.signal?.aborted)
    throw new AppError("E_CANCELLED", "Operation cancelled");
  const accepted = options.acceptedExitCodes ?? [0];
  const maxCapture = options.maxCaptureBytes ?? 2 * 1024 * 1024;
  return await new Promise((resolve7, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const finishError = (error) => {
      if (settled)
        return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finishError(new AppError("E_CANCELLED", "Operation cancelled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > maxCapture)
        stdoutTruncated = true;
      stdout = boundedAppend(stdout, chunk, maxCapture);
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length > maxCapture)
        stderrTruncated = true;
      stderr = boundedAppend(stderr, chunk, maxCapture);
      options.onStderr?.(chunk);
    });
    child.on("error", (error) => {
      const code = error.code === "ENOENT" ? "E_DEPENDENCY_MISSING" : "E_PROCESS_FAILED";
      finishError(new AppError(code, `Could not start ${spec.executable}: ${error.message}`, {
        executable: spec.executable,
        args: spec.args
      }, { cause: error }));
    });
    child.on("close", (exitCode2) => {
      if (settled)
        return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      const normalizedCode = exitCode2 ?? -1;
      if (!accepted.includes(normalizedCode)) {
        reject(new AppError("E_PROCESS_FAILED", `${spec.executable} exited with code ${normalizedCode}`, {
          executable: spec.executable,
          args: spec.args,
          exitCode: normalizedCode,
          stderr,
          stderrTruncated
        }));
        return;
      }
      resolve7({
        exitCode: normalizedCode,
        stdout,
        stderr,
        ...stdoutTruncated ? { stdoutTruncated: true } : {},
        ...stderrTruncated ? { stderrTruncated: true } : {}
      });
    });
  });
};
var LineAccumulator = class {
  #pending = "";
  push(chunk) {
    const parts = (this.#pending + chunk).split(/\r?\n/);
    this.#pending = parts.pop() ?? "";
    return parts;
  }
  flush() {
    const value = this.#pending;
    this.#pending = "";
    return value.length > 0 ? value : null;
  }
};

// packages/core/dist/cache-manager.js
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
var DEFAULT_CACHE_POLICY = "cleanup-on-success";
var DEFAULT_CACHE_LIMIT_BYTES = 50 * 1024 * 1024 * 1024;
var CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
var METADATA_FILE = "cache-metadata.json";
var METADATA_LOCK_FILE = ".metadata.lock";
var DELETING_FILE = ".deleting";
var JOB_LOCK_FILE = ".job.lock";
var FRAME_CACHE_WRITE_LOCK_FILE = ".frame-cache.write.lock";
var MALFORMED_LOCK_GRACE_MS = 5e3;
var KEY_PATTERN = /^[a-f0-9]{64}$/;
var JOB_PATTERN = /^[a-f0-9]{20}$/;
function iso(now = Date.now()) {
  return new Date(now).toISOString();
}
function validLimit(value) {
  if (value === void 0)
    return DEFAULT_CACHE_LIMIT_BYTES;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError("E_INVALID_ARGUMENT", "Cache limit must be a non-negative safe integer");
  }
  return value;
}
function cacheRoot(workDirectory) {
  return resolve(workDirectory, "frame-cache");
}
function checkedCacheDirectory(workDirectory, key) {
  if (!KEY_PATTERN.test(key))
    throw new AppError("E_INVALID_ARGUMENT", "Invalid frame cache key");
  const root = cacheRoot(workDirectory);
  const target = resolve(root, key);
  if (dirname(target) !== root) {
    throw new AppError("E_INVALID_ARGUMENT", "Frame cache path escapes its work directory");
  }
  return target;
}
async function assertPlainDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AppError("E_INVALID_ARGUMENT", `${label} must be a real directory, not a link`, { path });
  }
}
async function prepareSafeRoots(workDirectory) {
  const work = resolve(workDirectory);
  const frameRoot = cacheRoot(work);
  const jobsRoot = resolve(work, "jobs");
  await mkdir(work, { recursive: true });
  await assertPlainDirectory(work, "Work root");
  await Promise.all([mkdir(frameRoot, { recursive: true }), mkdir(jobsRoot, { recursive: true })]);
  await Promise.all([
    assertPlainDirectory(frameRoot, "Frame cache root"),
    assertPlainDirectory(jobsRoot, "Jobs root")
  ]);
  const [realWork, realFrame, realJobs] = await Promise.all([realpath(work), realpath(frameRoot), realpath(jobsRoot)]);
  if (dirname(realFrame) !== realWork || dirname(realJobs) !== realWork) {
    throw new AppError("E_INVALID_ARGUMENT", "Cache roots escape the selected work directory", {
      work: realWork,
      frameRoot: realFrame,
      jobsRoot: realJobs
    });
  }
  return { work, frameRoot, jobsRoot };
}
async function directorySize(path) {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT")
      return [];
    throw error;
  });
  for (const entry of entries) {
    if ([
      METADATA_FILE,
      METADATA_LOCK_FILE,
      DELETING_FILE,
      FRAME_CACHE_WRITE_LOCK_FILE,
      `${FRAME_CACHE_WRITE_LOCK_FILE}.recovery`
    ].includes(entry.name))
      continue;
    const child = join(path, entry.name);
    const info = await lstat(child).catch(() => null);
    if (!info || info.isSymbolicLink())
      continue;
    if (info.isDirectory())
      total += await directorySize(child);
    else if (info.isFile())
      total += info.size;
  }
  return total;
}
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}
`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => void 0);
    throw error;
  }
}
function isMetadata(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const record2 = value;
  return record2.schemaVersion === 1 && record2.frameCacheKey === key && typeof record2.createdAt === "string" && typeof record2.lastAccessAt === "string" && typeof record2.sizeBytes === "number" && ["active", "recoverable", "complete", "legacy"].includes(String(record2.status)) && Array.isArray(record2.activeJobIds) && record2.activeJobIds.every((id) => typeof id === "string" && JOB_PATTERN.test(id)) && (record2.recoverableJobIds === void 0 || Array.isArray(record2.recoverableJobIds) && record2.recoverableJobIds.every((id) => typeof id === "string" && JOB_PATTERN.test(id)));
}
async function readMetadata(directory, key) {
  try {
    const parsed = JSON.parse(await readFile(join(directory, METADATA_FILE), "utf8"));
    return isMetadata(parsed, key) ? parsed : null;
  } catch {
    return null;
  }
}
async function lockMetadata(directory) {
  const path = join(directory, METADATA_LOCK_FILE);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await open(path, "wx");
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      const age = await stat(path).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > 60 * 60 * 1e3)
        await rm(path, { force: true }).catch(() => void 0);
      else
        await delay(25);
    }
  }
  throw new AppError("E_JOB_STATE", "Timed out waiting for the frame cache metadata lock", { directory });
}
async function withMetadataLock(directory, operation) {
  await mkdir(directory, { recursive: true });
  const handle = await lockMetadata(directory);
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => void 0);
    await rm(join(directory, METADATA_LOCK_FILE), { force: true }).catch(() => void 0);
  }
}
async function legacyMetadata(directory, key, now) {
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
    inputFingerprint: null
  };
}
async function referencingRecoverableJobIds(jobsRoot, key) {
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  const jobIds = [];
  for (const entry of entries) {
    if (!JOB_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      continue;
    try {
      const state = JSON.parse(await readFile(join(jobsRoot, entry.name, "job-state.json"), "utf8"));
      if (state.frameCacheKey === key && state.phase !== "complete")
        jobIds.push(entry.name);
    } catch {
    }
  }
  return jobIds.sort();
}
async function jobLockOwnerIsAlive(path) {
  try {
    const contents = await readFile(path, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      const info = await stat(path);
      return Date.now() - info.mtimeMs < MALFORMED_LOCK_GRACE_MS;
    }
    if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
      const info = await stat(path);
      return Date.now() - info.mtimeMs < MALFORMED_LOCK_GRACE_MS;
    }
    const pid = parsed.pid;
    if (pid === process.pid)
      return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  } catch (error) {
    return error.code !== "ENOENT";
  }
}
async function createJobLockFile(path, jobId) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify({ jobId, pid: process.pid, createdAt: iso() })}
`, "utf8");
    return handle;
  } catch (error) {
    await handle.close().catch(() => void 0);
    await rm(path, { force: true }).catch(() => void 0);
    throw error;
  }
}
async function acquireRecoveryClaim(path, jobId) {
  try {
    return await createJobLockFile(path, jobId);
  } catch (error) {
    if (error.code !== "EEXIST" || await jobLockOwnerIsAlive(path))
      throw error;
    await rm(path, { force: true });
    return await createJobLockFile(path, jobId);
  }
}
async function acquireJobLock(jobDirectory, jobId) {
  if (!JOB_PATTERN.test(jobId))
    throw new AppError("E_INVALID_ARGUMENT", "Invalid job id");
  await mkdir(jobDirectory, { recursive: true });
  const path = join(jobDirectory, JOB_LOCK_FILE);
  const recoveryPath = `${path}.recovery`;
  let handle;
  try {
    handle = await createJobLockFile(path, jobId);
  } catch (error) {
    if (error.code !== "EEXIST" || await jobLockOwnerIsAlive(path)) {
      throw new AppError("E_JOB_STATE", "This job is already active", { jobId, lockPath: path }, { cause: error });
    }
    let recovery;
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
      throw recoveryError instanceof AppError ? recoveryError : new AppError("E_JOB_STATE", "Could not replace a stale job lock", { jobId, lockPath: path }, { cause: recoveryError });
    } finally {
      await recovery.close().catch(() => void 0);
      await rm(recoveryPath, { force: true }).catch(() => void 0);
    }
  }
  let released = false;
  return {
    path,
    async release() {
      if (released)
        return;
      released = true;
      await handle.close().catch(() => void 0);
      await rm(path, { force: true }).catch(() => void 0);
    }
  };
}
async function acquireFrameCacheWriteLock(input) {
  if (!JOB_PATTERN.test(input.jobId))
    throw new AppError("E_INVALID_ARGUMENT", "Invalid job id");
  const roots = await prepareSafeRoots(input.workDirectory);
  const directory = checkedCacheDirectory(roots.work, input.frameCacheKey);
  if (!await access(directory).then(() => true, () => false)) {
    throw new AppError("E_JOB_STATE", "Frame cache must be registered before acquiring its write lock", {
      frameCacheKey: input.frameCacheKey
    });
  }
  await assertPlainDirectory(directory, "Frame cache directory");
  const path = join(directory, FRAME_CACHE_WRITE_LOCK_FILE);
  const recoveryPath = `${path}.recovery`;
  for (; ; ) {
    if (input.signal?.aborted)
      throw new AppError("E_CANCELLED", "Operation cancelled");
    await input.assertNotCancelled?.();
    try {
      const handle = await createJobLockFile(path, input.jobId);
      let released = false;
      return {
        path,
        release: async () => {
          if (released)
            return;
          released = true;
          await handle.close().catch(() => void 0);
          await rm(path, { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => void 0);
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
    }
    if (!await jobLockOwnerIsAlive(path)) {
      let recovery = null;
      let recoveryBusy = false;
      try {
        recovery = await acquireRecoveryClaim(recoveryPath, input.jobId);
        if (!await jobLockOwnerIsAlive(path))
          await rm(path, { force: true });
      } catch (error) {
        if (error.code !== "EEXIST")
          throw error;
        recoveryBusy = true;
      } finally {
        await recovery?.close().catch(() => void 0);
        if (recovery)
          await rm(recoveryPath, { force: true }).catch(() => void 0);
      }
      if (recoveryBusy)
        await delay(100);
      continue;
    }
    await delay(100);
  }
}
async function registerFrameCacheUse(input) {
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
        status: "legacy"
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
      inputFingerprint: input.inputFingerprint
    };
    if (metadata.status === "legacy") {
      throw new AppError("E_JOB_STATE", "Legacy frame cache cannot be reused by v0.3.1", {
        frameCacheKey: input.frameCacheKey,
        status: "legacy"
      });
    }
    metadata.recoverableJobIds ??= await referencingRecoverableJobIds(roots.jobsRoot, input.frameCacheKey);
    if (!metadata.activeJobIds.includes(input.jobId))
      metadata.activeJobIds.push(input.jobId);
    metadata.activeJobIds.sort();
    metadata.status = "active";
    metadata.lastAccessAt = iso(now);
    metadata.inputFingerprint = input.inputFingerprint;
    metadata.sizeBytes = await directorySize(directory);
    await atomicJson(join(directory, METADATA_FILE), metadata);
    return metadata;
  });
}
async function releaseFrameCacheUse(input) {
  const roots = await prepareSafeRoots(input.workDirectory);
  const directory = checkedCacheDirectory(roots.work, input.frameCacheKey);
  if (!await access(directory).then(() => true, () => false))
    return null;
  const now = input.now ?? Date.now();
  return await withMetadataLock(directory, async () => {
    const metadata = await readMetadata(directory, input.frameCacheKey);
    if (!metadata || metadata.status === "legacy")
      return metadata;
    metadata.recoverableJobIds ??= await referencingRecoverableJobIds(roots.jobsRoot, input.frameCacheKey);
    metadata.activeJobIds = metadata.activeJobIds.filter((id) => id !== input.jobId);
    const recoverableJobIds = new Set(metadata.recoverableJobIds);
    if (input.outcome === "recoverable")
      recoverableJobIds.add(input.jobId);
    else
      recoverableJobIds.delete(input.jobId);
    metadata.recoverableJobIds = [...recoverableJobIds].sort();
    metadata.status = cacheStatusAfterRelease(metadata.activeJobIds, input.outcome, metadata.recoverableJobIds);
    metadata.lastAccessAt = iso(now);
    metadata.sizeBytes = await directorySize(directory);
    await atomicJson(join(directory, METADATA_FILE), metadata);
    return metadata;
  });
}
async function referencingActiveJob(jobsRoot, key) {
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!JOB_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      continue;
    const jobDirectory = join(jobsRoot, entry.name);
    if (!await jobLockOwnerIsAlive(join(jobDirectory, JOB_LOCK_FILE)))
      continue;
    try {
      const state = JSON.parse(await readFile(join(jobDirectory, "job-state.json"), "utf8"));
      if (state.frameCacheKey === key)
        return true;
    } catch {
      return true;
    }
  }
  return false;
}
async function removeReferencingInactiveJobs(jobsRoot, key) {
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!JOB_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      continue;
    const jobDirectory = join(jobsRoot, entry.name);
    if (await jobLockOwnerIsAlive(join(jobDirectory, JOB_LOCK_FILE)))
      continue;
    try {
      const state = JSON.parse(await readFile(join(jobDirectory, "job-state.json"), "utf8"));
      if (state.frameCacheKey === key)
        await rm(jobDirectory, { recursive: true, force: true });
    } catch {
    }
  }
}
async function reconcileJobClaims(jobsRoot, metadata) {
  if (metadata.status === "legacy")
    return metadata;
  const hadActiveClaim = metadata.status === "active" || metadata.activeJobIds.length > 0;
  const liveJobIds = [];
  for (const jobId of metadata.activeJobIds) {
    if (await jobLockOwnerIsAlive(join(jobsRoot, jobId, JOB_LOCK_FILE)))
      liveJobIds.push(jobId);
  }
  metadata.activeJobIds = liveJobIds.sort();
  const recoverableJobIds = new Set(metadata.recoverableJobIds ?? []);
  for (const jobId of await referencingRecoverableJobIds(jobsRoot, metadata.frameCacheKey)) {
    if (!metadata.activeJobIds.includes(jobId))
      recoverableJobIds.add(jobId);
  }
  metadata.recoverableJobIds = [...recoverableJobIds].sort();
  if (metadata.activeJobIds.length > 0)
    metadata.status = "active";
  else if (hadActiveClaim || metadata.recoverableJobIds.length > 0)
    metadata.status = "recoverable";
  return metadata;
}
async function deleteTrash(path) {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => void 0);
}
async function trashCache(roots, metadata) {
  if (metadata.activeJobIds.length > 0 || await referencingActiveJob(roots.jobsRoot, metadata.frameCacheKey)) {
    return { removed: false, bytes: 0 };
  }
  const directory = checkedCacheDirectory(dirname(roots.frameRoot), metadata.frameCacheKey);
  const trash = join(roots.frameRoot, `.trash-${randomUUID()}`);
  try {
    const reserved = await withMetadataLock(directory, async () => {
      const current = await readMetadata(directory, metadata.frameCacheKey) ?? (metadata.status === "legacy" ? metadata : null);
      if (!current || current.activeJobIds.length > 0 || current.status === "active")
        return false;
      await writeFile(join(directory, DELETING_FILE), iso(), { encoding: "utf8", flag: "wx" });
      metadata.sizeBytes = current.sizeBytes;
      return true;
    });
    if (!reserved || await referencingActiveJob(roots.jobsRoot, metadata.frameCacheKey)) {
      await rm(join(directory, DELETING_FILE), { force: true }).catch(() => void 0);
      return { removed: false, bytes: 0 };
    }
    await removeReferencingInactiveJobs(roots.jobsRoot, metadata.frameCacheKey);
    await rename(directory, trash);
    await deleteTrash(trash);
    return { removed: true, bytes: metadata.sizeBytes };
  } catch (error) {
    await rm(join(directory, DELETING_FILE), { force: true }).catch(() => void 0);
    return { removed: false, bytes: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
async function scanCaches(roots, now) {
  const entries = await readdir(roots.frameRoot, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".trash-")) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await deleteTrash(join(roots.frameRoot, entry.name));
      }
      continue;
    }
    if (!KEY_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      continue;
    const directory = join(roots.frameRoot, entry.name);
    if (await access(join(directory, METADATA_LOCK_FILE)).then(() => true, () => false))
      continue;
    let metadata = await readMetadata(directory, entry.name);
    if (!metadata) {
      metadata = await legacyMetadata(directory, entry.name, now);
      await atomicJson(join(directory, METADATA_FILE), metadata).catch(() => void 0);
    } else {
      if (metadata.recoverableJobIds === void 0) {
        metadata.recoverableJobIds = await referencingRecoverableJobIds(roots.jobsRoot, entry.name);
        if (metadata.activeJobIds.length === 0 && metadata.recoverableJobIds.length > 0) {
          metadata.status = "recoverable";
        }
      }
      metadata = await reconcileJobClaims(roots.jobsRoot, metadata);
      metadata.sizeBytes = await directorySize(directory);
      await atomicJson(join(directory, METADATA_FILE), metadata).catch(() => void 0);
    }
    result.push(metadata);
  }
  return result;
}
function isExpired(metadata, policy, now) {
  if (metadata.status === "legacy" || metadata.status === "active")
    return false;
  const age = now - Date.parse(metadata.lastAccessAt);
  if (policy === "keep-all")
    return false;
  if (policy === "cleanup-on-success" && metadata.status === "complete")
    return true;
  return age >= CACHE_TTL_MS;
}
async function runCacheMaintenance(workDirectory, options = {}) {
  const roots = await prepareSafeRoots(workDirectory);
  const now = options.now ?? Date.now();
  const policy = options.policy ?? DEFAULT_CACHE_POLICY;
  const limitBytes = validLimit(options.limitBytes);
  const entries = await scanCaches(roots, now);
  const errors = [];
  const removedKeys = [];
  let releasedBytes = 0;
  const removed = /* @__PURE__ */ new Set();
  const candidates = entries.filter((entry) => entry.activeJobIds.length === 0 && entry.status !== "active").sort((left, right) => Date.parse(left.lastAccessAt) - Date.parse(right.lastAccessAt));
  for (const metadata of candidates) {
    if (!options.force && !isExpired(metadata, policy, now))
      continue;
    const result = await trashCache(roots, metadata);
    if (result.error)
      errors.push(`${metadata.frameCacheKey}: ${result.error}`);
    if (!result.removed)
      continue;
    removed.add(metadata.frameCacheKey);
    removedKeys.push(metadata.frameCacheKey);
    releasedBytes += result.bytes;
  }
  let remainingEntries = entries.filter((entry) => !removed.has(entry.frameCacheKey));
  let remainingBytes = remainingEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (!options.force && remainingBytes > limitBytes) {
    const lru = remainingEntries.filter((entry) => entry.status !== "active" && entry.status !== "legacy" && entry.activeJobIds.length === 0).sort((left, right) => Date.parse(left.lastAccessAt) - Date.parse(right.lastAccessAt));
    for (const metadata of lru) {
      if (remainingBytes <= limitBytes)
        break;
      const result = await trashCache(roots, metadata);
      if (result.error)
        errors.push(`${metadata.frameCacheKey}: ${result.error}`);
      if (!result.removed)
        continue;
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
    errors
  };
}
async function inspectCache(workDirectory, options = {}) {
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
    errors: []
  };
}
async function cleanupOneFrameCache(frameCacheKey2, workDirectory) {
  const roots = await prepareSafeRoots(workDirectory);
  const directory = checkedCacheDirectory(roots.work, frameCacheKey2);
  if (!await access(directory).then(() => true, () => false))
    return;
  const metadata = await reconcileJobClaims(roots.jobsRoot, await readMetadata(directory, frameCacheKey2) ?? await legacyMetadata(directory, frameCacheKey2, Date.now()));
  await atomicJson(join(directory, METADATA_FILE), metadata);
  if (metadata.activeJobIds.length > 0 || await referencingActiveJob(roots.jobsRoot, frameCacheKey2)) {
    throw new AppError("E_JOB_STATE", "Active frame cache cannot be deleted", { frameCacheKey: frameCacheKey2 });
  }
  const result = await trashCache(roots, metadata);
  if (result.error)
    throw new AppError("E_IO", "Could not move frame cache to trash", { frameCacheKey: frameCacheKey2, error: result.error });
}
function cacheStatusAfterRelease(activeJobIds, outcome, recoverableJobIds = []) {
  if (activeJobIds.length > 0)
    return "active";
  return outcome === "recoverable" || recoverableJobIds.length > 0 ? "recoverable" : outcome;
}

// packages/core/dist/doctor.js
import { constants } from "node:fs";
import { access as access2, mkdir as mkdir2, open as open2, readdir as readdir2, rm as rm2 } from "node:fs/promises";
import { delimiter, dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";

// packages/core/dist/types.js
var LEGACY_JOB_SPEC_VERSION = 1;
var INTERPOLATION_JOB_SPEC_VERSION = 2;
var SOURCE_RANGE_JOB_SPEC_VERSION = 3;
var JOB_SPEC_VERSION = 4;
var SUPPORTED_JOB_SPEC_VERSIONS = [
  LEGACY_JOB_SPEC_VERSION,
  INTERPOLATION_JOB_SPEC_VERSION,
  SOURCE_RANGE_JOB_SPEC_VERSION,
  JOB_SPEC_VERSION
];

// packages/core/dist/doctor.js
var H264_NVENC_MAX_DIMENSION = 4096;
async function probeH264Nvenc(ffmpegPath, runner = runCommand) {
  if (!ffmpegPath) {
    return { available: false, maxDimension: H264_NVENC_MAX_DIMENSION, error: "FFmpeg is unavailable" };
  }
  try {
    await runner({
      executable: ffmpegPath,
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=256x256:r=1",
        "-frames:v",
        "1",
        "-an",
        "-c:v",
        "h264_nvenc",
        "-profile:v",
        "high",
        "-preset",
        "p6",
        "-tune",
        "hq",
        "-rc",
        "vbr",
        "-cq",
        "17",
        "-b:v",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "null",
        "-"
      ]
    });
    return { available: true, maxDimension: H264_NVENC_MAX_DIMENSION };
  } catch (error) {
    return {
      available: false,
      maxDimension: H264_NVENC_MAX_DIMENSION,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
function defaultCacheDirectory() {
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? join2(process.env.HOME ?? process.cwd(), ".cache");
  return join2(base, "AI Video Wallpaper");
}
async function isExecutable(path) {
  try {
    await access2(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function pathExists(path) {
  try {
    await access2(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
async function findExecutable(name, candidates = []) {
  const suffix = process.platform === "win32" && !name.toLowerCase().endsWith(".exe") ? ".exe" : "";
  const executable = name + suffix;
  const pathCandidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join2(directory.replace(/^"|"$/g, ""), executable));
  for (const candidate of [...candidates, ...pathCandidates]) {
    const absolute = resolve2(candidate);
    if (await isExecutable(absolute))
      return absolute;
  }
  return null;
}
async function findInstalledExecutable(root, executableName, maxDepth = 4) {
  const visit = async (directory, depth) => {
    if (depth > maxDepth)
      return null;
    const entries = await readdir2(directory, { withFileTypes: true }).catch(() => []);
    const direct = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === executableName.toLowerCase());
    if (direct)
      return join2(directory, direct.name);
    for (const entry of entries) {
      if (!entry.isDirectory())
        continue;
      const found = await visit(join2(directory, entry.name), depth + 1);
      if (found)
        return found;
    }
    return null;
  };
  return await visit(root, 0);
}
async function resolveBinaryPaths(cacheDirectory = defaultCacheDirectory(), overrides = {}) {
  const tools = join2(cacheDirectory, "tools");
  const installedFfmpeg = await findInstalledExecutable(tools, "ffmpeg.exe");
  const installedFfprobe = await findInstalledExecutable(tools, "ffprobe.exe");
  const installedRealesrgan = await findInstalledExecutable(tools, "realesrgan-ncnn-vulkan.exe");
  const installedRife = await findInstalledExecutable(tools, "rife-ncnn-vulkan.exe");
  const ffmpeg = overrides.ffmpeg ?? await findExecutable("ffmpeg", [
    join2(tools, "ffmpeg", "bin", "ffmpeg.exe"),
    join2(tools, "ffmpeg", "ffmpeg.exe"),
    ...installedFfmpeg ? [installedFfmpeg] : []
  ]);
  const ffprobe = overrides.ffprobe ?? await findExecutable("ffprobe", [
    join2(tools, "ffmpeg", "bin", "ffprobe.exe"),
    join2(tools, "ffmpeg", "ffprobe.exe"),
    ...installedFfprobe ? [installedFfprobe] : []
  ]);
  const realesrgan = overrides.realesrgan ?? await findExecutable("realesrgan-ncnn-vulkan", [
    join2(tools, "realesrgan", "realesrgan-ncnn-vulkan.exe"),
    ...installedRealesrgan ? [installedRealesrgan] : []
  ]);
  const rife = overrides.rife ?? await findExecutable("rife-ncnn-vulkan", [
    join2(tools, "rife", "rife-ncnn-vulkan.exe"),
    ...installedRife ? [installedRife] : []
  ]);
  return {
    ...ffmpeg ? { ffmpeg } : {},
    ...ffprobe ? { ffprobe } : {},
    ...realesrgan ? { realesrgan } : {},
    ...rife ? { rife } : {}
  };
}
async function toolStatus(name, path, runner) {
  if (!path)
    return { name, available: false, path: null, version: null, error: "not found" };
  const args = name === "realesrgan" || name === "rife" ? ["-h"] : ["-version"];
  try {
    const acceptedExitCodes = name === "realesrgan" || name === "rife" ? [0, 1, -1, 4294967295] : [0, 1];
    const result = await runner({ executable: path, args }, { acceptedExitCodes });
    const firstLine = `${result.stdout}
${result.stderr}`.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "available";
    if (name === "rife") {
      const modelDirectory = join2(dirname2(path), "rife-v4.6");
      const requiredModelFiles = ["flownet.bin", "flownet.param"].map((file) => join2(modelDirectory, file));
      const missingModelFiles = [];
      for (const modelFile of requiredModelFiles) {
        if (!await pathExists(modelFile))
          missingModelFiles.push(modelFile);
      }
      if (missingModelFiles.length > 0) {
        return {
          name,
          available: false,
          path,
          version: firstLine,
          error: `model files not found: ${missingModelFiles.join(", ")}`
        };
      }
    }
    return { name, available: true, path, version: firstLine };
  } catch (error) {
    return { name, available: false, path, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}
async function checkWritable(directory) {
  const marker = join2(directory, `.doctor-${randomUUID2()}`);
  try {
    await mkdir2(directory, { recursive: true });
    const handle = await open2(marker, "wx");
    await handle.close();
    await rm2(marker);
    return true;
  } catch {
    await rm2(marker, { force: true }).catch(() => void 0);
    return false;
  }
}
async function doctor(options = {}) {
  const cacheDirectory = resolve2(options.cacheDirectory ?? defaultCacheDirectory());
  const runner = options.runner ?? runCommand;
  const binaries = await resolveBinaryPaths(cacheDirectory, options.binaries);
  const tools = await Promise.all([
    toolStatus("ffmpeg", binaries.ffmpeg, runner),
    toolStatus("ffprobe", binaries.ffprobe, runner),
    toolStatus("realesrgan", binaries.realesrgan, runner),
    toolStatus("rife", binaries.rife, runner)
  ]);
  const h264Nvenc = await probeH264Nvenc(binaries.ffmpeg, runner);
  const cacheWritable = await checkWritable(cacheDirectory);
  const recommendations = [];
  if (!tools.find((tool) => tool.name === "ffmpeg")?.available)
    recommendations.push("Install or configure FFmpeg.");
  if (!tools.find((tool) => tool.name === "ffprobe")?.available)
    recommendations.push("Install or configure ffprobe.");
  if (!tools.find((tool) => tool.name === "realesrgan")?.available)
    recommendations.push("Install Real-ESRGAN for AI upscaling; Lanczos remains available.");
  if (!tools.find((tool) => tool.name === "rife")?.available)
    recommendations.push("Install RIFE ncnn Vulkan to enable AI frame interpolation.");
  if (!cacheWritable)
    recommendations.push(`Make the cache directory writable: ${dirname2(cacheDirectory)}`);
  return {
    ok: cacheWritable && tools.filter((tool) => tool.name !== "realesrgan" && tool.name !== "rife").every((tool) => tool.available),
    platform: process.platform,
    arch: process.arch,
    cacheDirectory,
    cacheWritable,
    tools,
    recommendations,
    capabilities: {
      jobSpecVersions: [...SUPPORTED_JOB_SPEC_VERSIONS],
      previewModes: ["segment", "loop-boundary"],
      h264Nvenc
    }
  };
}

// packages/core/dist/frame-risk.js
var detectorRevision = "frame-risk-v2";
var FRAME_RISK_MIN_CAPTURE_BYTES = 2 * 1024 * 1024;
var FRAME_RISK_MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
var FRAME_RISK_CAPTURE_BYTES_PER_FRAME = 2048;
function frameRiskCaptureBytes(frameCount) {
  const normalized = Number.isFinite(frameCount) ? Math.max(0, Math.ceil(frameCount)) : 0;
  return Math.min(FRAME_RISK_MAX_CAPTURE_BYTES, Math.max(FRAME_RISK_MIN_CAPTURE_BYTES, normalized * FRAME_RISK_CAPTURE_BYTES_PER_FRAME));
}
var frameRiskThresholds = Object.freeze({
  nearDuplicateMaxMafd: 0.75,
  nearDuplicateMaxMeanColorDelta: 1.5,
  nearDuplicateMaxSceneScore: 0.6,
  hardCutMinSceneScore: 10,
  hardCutFallbackMinMafd: 12,
  hardCutFallbackMinMeanColorDelta: 18,
  flashMinBoundarySceneScore: 7,
  flashMinBoundaryMafd: 10,
  flashMinLumaDelta: 28,
  flashMinBlackPercentDelta: 65,
  flashMaxReturnMeanColorDelta: 5,
  gradualMinTransitions: 3,
  gradualMinSceneScore: 0.8,
  gradualMaxSceneScore: 9.999,
  gradualMinMeanColorStep: 1.2,
  gradualMaxMeanColorStep: 18,
  gradualMinTotalMeanColorDelta: 10,
  gradualMinDirectionCoherence: 0.72,
  highVariationMinMafd: 6,
  highVariationMaxSceneScore: 9.999,
  highVariationMaxMeanColorDelta: 3
});
var signalFieldMap = Object.freeze({
  YAVG: "yAverage",
  UAVG: "uAverage",
  VAVG: "vAverage",
  SATAVG: "saturationAverage",
  TOUT: "temporalOutlier",
  VREP: "verticalRepeat",
  BRNG: "broadcastRange"
});
function finiteNumber(value) {
  if (value === void 0)
    return void 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function frameAt(frames, index) {
  const existing = frames.get(index);
  if (existing)
    return existing;
  const created = { frame: index };
  frames.set(index, created);
  return created;
}
function nearestFrameAtTime(frames, time) {
  let nearest;
  for (const frame of frames.values()) {
    if (frame.ptsTime === void 0)
      continue;
    const distance = Math.abs(frame.ptsTime - time);
    if (nearest === void 0 || distance < nearest.distance)
      nearest = { frame: frame.frame, distance };
  }
  return nearest?.frame;
}
function parseMetadataText(text, frames) {
  let currentFrame;
  for (const line of text.split(/\r?\n/)) {
    const frameMatch = /(?:^|\s)frame:\s*(\d+)/.exec(line);
    if (frameMatch) {
      currentFrame = Number(frameMatch[1]);
      const target2 = frameAt(frames, currentFrame);
      const pts = finiteNumber(/(?:^|\s)pts:\s*(-?\d+)/.exec(line)?.[1]);
      const ptsTime = finiteNumber(/(?:^|\s)(?:pts_time|t):\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/.exec(line)?.[1]);
      const blackPercent = finiteNumber(/(?:^|\s)pblack:\s*(\d+(?:\.\d*)?)/.exec(line)?.[1]);
      if (pts !== void 0)
        target2.pts = pts;
      if (ptsTime !== void 0)
        target2.ptsTime = ptsTime;
      if (blackPercent !== void 0)
        target2.blackPercent = blackPercent;
    }
    const sceneMatches = [...line.matchAll(/lavfi\.scd\.(mafd|score|time)\s*[=:]\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/gi)];
    const sceneTime = finiteNumber(sceneMatches.find((match) => match[1].toLowerCase() === "time")?.[2]);
    const targetFrame = frameMatch || sceneTime === void 0 ? currentFrame : nearestFrameAtTime(frames, sceneTime);
    if (targetFrame === void 0)
      continue;
    const target = frameAt(frames, targetFrame);
    for (const match of line.matchAll(/lavfi\.signalstats\.([A-Z]+)\s*[=:]\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/g)) {
      const field = signalFieldMap[match[1]];
      const value = finiteNumber(match[2]);
      if (field !== void 0 && value !== void 0) {
        target[field] = value;
      }
    }
    for (const match of sceneMatches) {
      const value = finiteNumber(match[2]);
      if (value === void 0)
        continue;
      const field = match[1].toLowerCase();
      if (field === "mafd")
        target.mafd = value;
      if (field === "score")
        target.sceneScore = value;
      if (field === "time")
        target.sceneTime = value;
    }
  }
}
function parseRatio(value) {
  const match = /^\s*(-?\d+)\s*\/\s*(-?\d+)\s*$/.exec(value);
  if (!match)
    return void 0;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (denominator === 0)
    return void 0;
  return numerator / denominator;
}
function parseFrameMd5(text, frames) {
  const timeBases = /* @__PURE__ */ new Map();
  const streamFrames = /* @__PURE__ */ new Map();
  let selectedStream;
  for (const line of text.split(/\r?\n/)) {
    const timeBaseMatch = /^#tb\s+(\d+)\s*:\s*(\S+)/.exec(line.trim());
    if (timeBaseMatch) {
      const ratio = parseRatio(timeBaseMatch[2]);
      if (ratio !== void 0)
        timeBases.set(Number(timeBaseMatch[1]), ratio);
      continue;
    }
    const row = /^\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([A-Za-z0-9+/=]{8,})\s*$/.exec(line);
    if (!row)
      continue;
    const stream = Number(row[1]);
    selectedStream ??= stream;
    if (stream !== selectedStream)
      continue;
    const index = streamFrames.get(stream) ?? 0;
    streamFrames.set(stream, index + 1);
    const target = frameAt(frames, index);
    const pts = Number(row[3]);
    target.pts = pts;
    target.packetSize = Number(row[5]);
    target.checksum = row[6].toLowerCase();
    const timeBase = timeBases.get(stream);
    if (timeBase !== void 0)
      target.ptsTime = pts * timeBase;
  }
}
function parseFfmpegFrameMetadata(sources) {
  const frames = /* @__PURE__ */ new Map();
  const texts = typeof sources === "string" ? [sources] : [sources.signalstats, sources.scdet, sources.blackframe, sources.framemd5].filter((value) => typeof value === "string");
  for (const text of texts) {
    parseMetadataText(text, frames);
    parseFrameMd5(text, frames);
  }
  return [...frames.values()].sort((left, right) => left.frame - right.frame);
}
function difference(left, right) {
  return left === void 0 || right === void 0 ? void 0 : right - left;
}
function pairMetrics(left, right, index) {
  const y = difference(left.yAverage, right.yAverage);
  const u = difference(left.uAverage, right.uAverage);
  const v = difference(left.vAverage, right.vAverage);
  const available = [y, u, v].filter((value) => value !== void 0);
  const colorVector = available.length === 0 ? void 0 : [y ?? 0, u ?? 0, v ?? 0];
  const meanColorDelta = colorVector === void 0 ? void 0 : Math.sqrt(colorVector.reduce((sum, value) => sum + value * value, 0));
  const adjacent = right.frame === left.frame + 1;
  return {
    index,
    left,
    right,
    adjacent,
    exactDuplicate: adjacent && left.checksum !== void 0 && right.checksum !== void 0 && left.checksum.toLowerCase() === right.checksum.toLowerCase(),
    colorVector,
    meanColorDelta,
    lumaDelta: y === void 0 ? void 0 : Math.abs(y),
    blackPercentDelta: left.blackPercent === void 0 || right.blackPercent === void 0 ? void 0 : Math.abs(right.blackPercent - left.blackPercent),
    sceneScore: right.sceneScore,
    mafd: right.mafd
  };
}
function mergedThresholds(overrides) {
  const result = { ...frameRiskThresholds, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError(`${key} must be a non-negative finite number`);
  }
  if (!Number.isInteger(result.gradualMinTransitions) || result.gradualMinTransitions < 2) {
    throw new RangeError("gradualMinTransitions must be an integer of at least 2");
  }
  return result;
}
function normalizedScore(value) {
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}
function timeOf(frame) {
  return frame.ptsTime === void 0 ? {} : { previewTime: frame.ptsTime };
}
function evidenceOf(pair) {
  return {
    ...pair.sceneScore === void 0 ? {} : { sceneScore: pair.sceneScore },
    ...pair.mafd === void 0 ? {} : { mafd: pair.mafd },
    ...pair.meanColorDelta === void 0 ? {} : { meanColorDelta: pair.meanColorDelta },
    ...pair.lumaDelta === void 0 ? {} : { lumaDelta: pair.lumaDelta },
    ...pair.blackPercentDelta === void 0 ? {} : { blackPercentDelta: pair.blackPercentDelta }
  };
}
function exactDuplicateIntervals(pairs) {
  const result = [];
  let runStart;
  const emit2 = (endPairExclusive) => {
    if (runStart === void 0)
      return;
    const first = pairs[runStart];
    const last = pairs[endPairExclusive - 1];
    result.push({
      kind: "exact-duplicate",
      startFrame: first.left.frame,
      endFrameExclusive: last.right.frame + 1,
      checksum: first.left.checksum.toLowerCase(),
      holdBoundariesAfter: pairs.slice(runStart, endPairExclusive).map((pair) => pair.left.frame),
      previewFrame: first.right.frame,
      ...timeOf(first.right),
      score: 1,
      recommendedAction: "hold"
    });
    runStart = void 0;
  };
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair.exactDuplicate) {
      runStart ??= index;
    } else {
      emit2(index);
    }
  }
  emit2(pairs.length);
  return result;
}
function cadenceEvents(exact) {
  return exact.flatMap((interval) => {
    const exposureFrames = interval.endFrameExclusive - interval.startFrame;
    if (exposureFrames !== 2 && exposureFrames !== 3)
      return [];
    return [{
      kind: "cadence",
      startFrame: interval.startFrame,
      endFrameExclusive: interval.endFrameExclusive,
      previewFrame: interval.previewFrame,
      ...interval.previewTime === void 0 ? {} : { previewTime: interval.previewTime },
      score: exposureFrames === 3 ? 0.9 : 0.85,
      recommendedAction: "review",
      evidence: { exposureFrames }
    }];
  });
}
function boundaryStrongEnoughForFlash(pair, thresholds) {
  return (pair.sceneScore ?? -Infinity) >= thresholds.flashMinBoundarySceneScore || (pair.mafd ?? -Infinity) >= thresholds.flashMinBoundaryMafd;
}
function flashEvents(frames, pairs, thresholds) {
  const risks = [];
  const suppressedPairs = /* @__PURE__ */ new Set();
  for (let center = 1; center < frames.length - 1; center += 1) {
    const before = pairs[center - 1];
    const after = pairs[center];
    if (!before.adjacent || !after.adjacent || before.exactDuplicate || after.exactDuplicate || !boundaryStrongEnoughForFlash(before, thresholds) || !boundaryStrongEnoughForFlash(after, thresholds))
      continue;
    const previous = frames[center - 1];
    const current = frames[center];
    const next = frames[center + 1];
    const returnPair = pairMetrics(previous, next, -1);
    const returnedToBaseline = returnPair.meanColorDelta !== void 0 && returnPair.meanColorDelta <= thresholds.flashMaxReturnMeanColorDelta;
    const lumaExcursion = before.lumaDelta !== void 0 && after.lumaDelta !== void 0 && Math.min(before.lumaDelta, after.lumaDelta) >= thresholds.flashMinLumaDelta;
    const blackExcursion = before.blackPercentDelta !== void 0 && after.blackPercentDelta !== void 0 && Math.min(before.blackPercentDelta, after.blackPercentDelta) >= thresholds.flashMinBlackPercentDelta;
    if (!returnedToBaseline || !lumaExcursion && !blackExcursion)
      continue;
    const boundaryStrength = Math.min(Math.max(before.sceneScore ?? 0, before.mafd ?? 0), Math.max(after.sceneScore ?? 0, after.mafd ?? 0));
    const excursion = lumaExcursion ? Math.min(before.lumaDelta, after.lumaDelta) / thresholds.flashMinLumaDelta : Math.min(before.blackPercentDelta, after.blackPercentDelta) / thresholds.flashMinBlackPercentDelta;
    risks.push({
      kind: "flash",
      startFrame: previous.frame,
      endFrameExclusive: next.frame + 1,
      previewFrame: current.frame,
      ...timeOf(current),
      score: normalizedScore(0.5 * Math.min(1, excursion) + 0.5 * Math.min(1, boundaryStrength / 20)),
      recommendedAction: "review",
      evidence: {
        sceneScore: Math.max(before.sceneScore ?? 0, after.sceneScore ?? 0),
        mafd: Math.max(before.mafd ?? 0, after.mafd ?? 0),
        meanColorDelta: returnPair.meanColorDelta,
        lumaDelta: Math.max(before.lumaDelta ?? 0, after.lumaDelta ?? 0),
        blackPercentDelta: Math.max(before.blackPercentDelta ?? 0, after.blackPercentDelta ?? 0)
      }
    });
    suppressedPairs.add(center - 1);
    suppressedPairs.add(center);
  }
  return { risks, suppressedPairs };
}
function hardCutEvents(pairs, thresholds, suppressedPairs) {
  const risks = [];
  const pairIndices = /* @__PURE__ */ new Set();
  for (const pair of pairs) {
    if (!pair.adjacent || pair.exactDuplicate || suppressedPairs.has(pair.index))
      continue;
    const explicitCut = (pair.sceneScore ?? -Infinity) >= thresholds.hardCutMinSceneScore;
    const fallbackCut = (pair.mafd ?? -Infinity) >= thresholds.hardCutFallbackMinMafd && (pair.meanColorDelta ?? -Infinity) >= thresholds.hardCutFallbackMinMeanColorDelta;
    if (!explicitCut && !fallbackCut)
      continue;
    const strength = Math.max((pair.sceneScore ?? 0) / thresholds.hardCutMinSceneScore, Math.min((pair.mafd ?? 0) / thresholds.hardCutFallbackMinMafd, (pair.meanColorDelta ?? 0) / thresholds.hardCutFallbackMinMeanColorDelta));
    risks.push({
      kind: "hard-cut",
      startFrame: pair.left.frame,
      endFrameExclusive: pair.right.frame + 1,
      previewFrame: pair.right.frame,
      ...timeOf(pair.right),
      score: normalizedScore(strength),
      recommendedAction: "review",
      evidence: evidenceOf(pair)
    });
    pairIndices.add(pair.index);
  }
  return { risks, pairIndices };
}
function contiguousRuns(indices) {
  const result = [];
  let current = [];
  for (const index of indices) {
    if (current.length === 0 || index === current.at(-1) + 1) {
      current.push(index);
    } else {
      result.push(current);
      current = [index];
    }
  }
  if (current.length > 0)
    result.push(current);
  return result;
}
function nearDuplicateEvents(pairs, thresholds, excludedPairs) {
  const candidates = pairs.filter((pair) => pair.adjacent && !pair.exactDuplicate && !excludedPairs.has(pair.index) && pair.mafd !== void 0 && pair.mafd <= thresholds.nearDuplicateMaxMafd && (pair.meanColorDelta === void 0 || pair.meanColorDelta <= thresholds.nearDuplicateMaxMeanColorDelta) && (pair.sceneScore === void 0 || pair.sceneScore <= thresholds.nearDuplicateMaxSceneScore));
  const pairIndices = new Set(candidates.map((pair) => pair.index));
  const risks = contiguousRuns([...pairIndices]).map((run) => {
    const runPairs = run.map((index) => pairs[index]);
    const preview = runPairs.reduce((best, pair) => (pair.mafd ?? Infinity) < (best.mafd ?? Infinity) ? pair : best);
    const mafdScore = 1 - preview.mafd / Math.max(Number.EPSILON, thresholds.nearDuplicateMaxMafd);
    const colorScore = preview.meanColorDelta === void 0 ? mafdScore : 1 - preview.meanColorDelta / Math.max(Number.EPSILON, thresholds.nearDuplicateMaxMeanColorDelta);
    return {
      kind: "near-duplicate",
      startFrame: runPairs[0]?.left.frame,
      endFrameExclusive: runPairs.at(-1)?.right.frame + 1,
      previewFrame: preview.right.frame,
      ...timeOf(preview.right),
      score: normalizedScore(0.55 + 0.45 * Math.max(0, Math.min(mafdScore, colorScore))),
      recommendedAction: "review",
      evidence: evidenceOf(preview)
    };
  });
  return { risks, pairIndices };
}
function vectorLength(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}
function directionCoherence(runPairs) {
  const vectors = runPairs.map((pair) => pair.colorVector).filter((value) => value !== void 0);
  const pathLength = vectors.reduce((sum, vector) => sum + vectorLength(vector), 0);
  if (pathLength <= Number.EPSILON)
    return 0;
  const net = vectors.reduce((sum, vector) => [sum[0] + vector[0], sum[1] + vector[1], sum[2] + vector[2]], [0, 0, 0]);
  return Math.min(1, vectorLength(net) / pathLength);
}
function gradualTransitionEvents(pairs, thresholds, excludedPairs) {
  const candidateIndices = pairs.filter((pair) => {
    if (!pair.adjacent || pair.exactDuplicate || excludedPairs.has(pair.index) || pair.meanColorDelta === void 0)
      return false;
    const score = pair.sceneScore ?? pair.mafd;
    return score !== void 0 && score >= thresholds.gradualMinSceneScore && score <= thresholds.gradualMaxSceneScore && pair.meanColorDelta >= thresholds.gradualMinMeanColorStep && pair.meanColorDelta <= thresholds.gradualMaxMeanColorStep;
  }).map((pair) => pair.index);
  const risks = [];
  const pairIndices = /* @__PURE__ */ new Set();
  for (const run of contiguousRuns(candidateIndices)) {
    if (run.length < thresholds.gradualMinTransitions)
      continue;
    const runPairs = run.map((index) => pairs[index]);
    const coherence = directionCoherence(runPairs);
    const first = runPairs[0];
    const last = runPairs.at(-1);
    const totalDelta = pairMetrics(first.left, last.right, -1).meanColorDelta ?? 0;
    if (coherence < thresholds.gradualMinDirectionCoherence || totalDelta < thresholds.gradualMinTotalMeanColorDelta)
      continue;
    const middle = runPairs[Math.floor(runPairs.length / 2)];
    const score = 0.35 * Math.min(1, run.length / (thresholds.gradualMinTransitions * 2)) + 0.35 * coherence + 0.3 * Math.min(1, totalDelta / (thresholds.gradualMinTotalMeanColorDelta * 2));
    risks.push({
      kind: "gradual-transition",
      startFrame: first.left.frame,
      endFrameExclusive: last.right.frame + 1,
      previewFrame: middle.right.frame,
      ...timeOf(middle.right),
      score: normalizedScore(score),
      recommendedAction: "review",
      evidence: {
        ...evidenceOf(middle),
        meanColorDelta: totalDelta,
        directionCoherence: Number(coherence.toFixed(4))
      }
    });
    for (const index of run)
      pairIndices.add(index);
  }
  return { risks, pairIndices };
}
function highVariationEvents(pairs, thresholds, excludedPairs) {
  const candidateIndices = pairs.filter((pair) => pair.adjacent && !pair.exactDuplicate && !excludedPairs.has(pair.index) && (pair.mafd ?? -Infinity) >= thresholds.highVariationMinMafd && (pair.sceneScore === void 0 || pair.sceneScore <= thresholds.highVariationMaxSceneScore) && (pair.meanColorDelta === void 0 || pair.meanColorDelta <= thresholds.highVariationMaxMeanColorDelta)).map((pair) => pair.index);
  return contiguousRuns(candidateIndices).map((run) => {
    const runPairs = run.map((index) => pairs[index]);
    const preview = runPairs.reduce((best, pair) => (pair.mafd ?? 0) > (best.mafd ?? 0) ? pair : best);
    return {
      kind: "high-variation",
      startFrame: runPairs[0]?.left.frame,
      endFrameExclusive: runPairs.at(-1)?.right.frame + 1,
      previewFrame: preview.right.frame,
      ...timeOf(preview.right),
      score: normalizedScore(0.5 + 0.5 * Math.min(1, preview.mafd / 20)),
      recommendedAction: "review",
      evidence: evidenceOf(preview)
    };
  });
}
function previewFrames(exact, risks, maximum) {
  const candidates = [
    ...exact.map((risk) => ({ frame: risk.previewFrame, ptsTime: risk.previewTime, score: risk.score, kind: risk.kind })),
    ...risks.map((risk) => ({ frame: risk.previewFrame, ptsTime: risk.previewTime, score: risk.score, kind: risk.kind }))
  ].sort((left, right) => right.score - left.score || left.frame - right.frame || left.kind.localeCompare(right.kind));
  const selected = [];
  const kinds = [
    "flash",
    "hard-cut",
    "gradual-transition",
    "high-variation",
    "near-duplicate",
    "cadence",
    "exact-duplicate"
  ];
  for (const kind of kinds) {
    const candidate = candidates.find((item) => item.kind === kind);
    if (candidate)
      selected.push(candidate);
  }
  for (const candidate of candidates) {
    if (!selected.includes(candidate))
      selected.push(candidate);
  }
  const merged = /* @__PURE__ */ new Map();
  for (const candidate of selected) {
    const existing = merged.get(candidate.frame);
    if (existing) {
      if (!existing.kinds.includes(candidate.kind))
        existing.kinds.push(candidate.kind);
      existing.score = Math.max(existing.score, candidate.score);
      continue;
    }
    if (merged.size >= maximum)
      continue;
    merged.set(candidate.frame, {
      frame: candidate.frame,
      ...candidate.ptsTime === void 0 ? {} : { ptsTime: candidate.ptsTime },
      score: candidate.score,
      kinds: [candidate.kind]
    });
  }
  return [...merged.values()];
}
var diagnosticRiskPriority = [
  "flash",
  "gradual-transition",
  "high-variation",
  "near-duplicate",
  "cadence",
  "hard-cut",
  "exact-duplicate"
];
function selectDiagnosticRiskPreview(analysis) {
  if (!analysis || analysis.previewFrames.length === 0)
    return void 0;
  const priority = (preview) => Math.min(...preview.kinds.map((kind) => diagnosticRiskPriority.indexOf(kind)).filter((index) => index >= 0));
  const reviewOnly = analysis.previewFrames.filter((preview) => preview.kinds.some((kind) => kind !== "exact-duplicate"));
  return [...reviewOnly.length > 0 ? reviewOnly : analysis.previewFrames].sort((left, right) => priority(left) - priority(right) || right.score - left.score || left.frame - right.frame)[0];
}
function analyzeFrameRisks(inputFrames, options = {}) {
  const thresholds = mergedThresholds(options.thresholds);
  const maximum = options.maxPreviewFrames ?? 12;
  if (!Number.isInteger(maximum) || maximum < 0)
    throw new RangeError("maxPreviewFrames must be a non-negative integer");
  const frames = [...inputFrames].sort((left, right) => left.frame - right.frame);
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!Number.isInteger(frame.frame) || frame.frame < 0)
      throw new RangeError("frame indices must be non-negative integers");
    if (index > 0 && frame.frame === frames[index - 1]?.frame)
      throw new RangeError(`duplicate frame metadata for frame ${frame.frame}`);
  }
  const pairs = frames.slice(1).map((frame, index) => pairMetrics(frames[index], frame, index));
  const exact = exactDuplicateIntervals(pairs);
  const cadence = cadenceEvents(exact);
  const flashes = flashEvents(frames, pairs, thresholds);
  const cuts = hardCutEvents(pairs, thresholds, flashes.suppressedPairs);
  const firstExcluded = /* @__PURE__ */ new Set([...flashes.suppressedPairs, ...cuts.pairIndices]);
  const near = nearDuplicateEvents(pairs, thresholds, firstExcluded);
  const gradual = gradualTransitionEvents(pairs, thresholds, /* @__PURE__ */ new Set([...firstExcluded, ...near.pairIndices]));
  const highVariation = highVariationEvents(pairs, thresholds, /* @__PURE__ */ new Set([...firstExcluded, ...near.pairIndices, ...gradual.pairIndices]));
  const allRisks = [
    ...cadence,
    ...near.risks,
    ...cuts.risks,
    ...flashes.risks,
    ...gradual.risks,
    ...highVariation
  ];
  return {
    detectorRevision,
    frameCount: frames.length,
    exactDuplicateIntervals: exact,
    cadenceRisks: cadence,
    nearDuplicateRisks: near.risks,
    hardCuts: cuts.risks,
    flashRisks: flashes.risks,
    gradualTransitionRisks: gradual.risks,
    highVariationRisks: highVariation,
    previewFrames: previewFrames(exact, allRisks, maximum)
  };
}

// packages/core/dist/job-state.js
import { randomUUID as randomUUID3 } from "node:crypto";
import { access as access3, copyFile, link, mkdir as mkdir3, readFile as readFile2, rename as rename2, stat as stat2, statfs, unlink, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname3, join as join3, resolve as resolve3 } from "node:path";

// packages/core/dist/pure.js
import { createHash } from "node:crypto";
var FRAME_CACHE_PIPELINE_REVISION = "dual-mode-pipeline-v1";
function pingPongIndices(frameCount) {
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new RangeError("frameCount must be a positive integer");
  }
  const result = Array.from({ length: frameCount }, (_, index) => index);
  for (let index = frameCount - 2; index >= 1; index -= 1)
    result.push(index);
  return result;
}
function outputFrameCount(sourceFrameCount, loopMode) {
  if (!Number.isInteger(sourceFrameCount) || sourceFrameCount < 1) {
    throw new RangeError("sourceFrameCount must be a positive integer");
  }
  return loopMode === "pingpong" ? Math.max(1, sourceFrameCount * 2 - 2) : sourceFrameCount;
}
function interpolatedForwardFrameCount(sourceFrameCount, factor = 1) {
  if (!Number.isInteger(sourceFrameCount) || sourceFrameCount < 1) {
    throw new RangeError("sourceFrameCount must be a positive integer");
  }
  return factor === 2 ? sourceFrameCount * 2 - 1 : sourceFrameCount;
}
function interpolatedOutputFrameCount(sourceFrameCount, loopMode, factor = 1) {
  const forward = interpolatedForwardFrameCount(sourceFrameCount, factor);
  if (factor === 2 && (loopMode === "none" || sourceFrameCount === 1))
    return sourceFrameCount * 2;
  return outputFrameCount(forward, loopMode);
}
function interpolationFrameMap(sourceIndices, options = {}) {
  if (sourceIndices.length === 0 || sourceIndices.some((index, position) => !Number.isInteger(index) || index < 0 || position > 0 && index !== sourceIndices[position - 1] + 1)) {
    throw new RangeError("sourceIndices must be a non-empty contiguous range");
  }
  const cuts = new Set(options.sceneCutsAfter ?? []);
  const holds = new Set(options.holdBoundariesAfter ?? []);
  const result = [];
  for (let position = 0; position < sourceIndices.length; position += 1) {
    const sourceIndex = sourceIndices[position];
    result.push({ outputIndex: sourceIndex * 2, kind: "source", sourceIndex });
    const nextSourceIndex = sourceIndices[position + 1];
    if (nextSourceIndex !== void 0) {
      result.push({
        outputIndex: sourceIndex * 2 + 1,
        kind: cuts.has(sourceIndex) || holds.has(sourceIndex) ? "hold" : "interpolated",
        sourceIndex,
        nextSourceIndex
      });
    }
  }
  if (options.includeTail) {
    const sourceIndex = sourceIndices.at(-1);
    result.push({ outputIndex: sourceIndex * 2 + 1, kind: "hold", sourceIndex });
  }
  return result;
}
function durationForFrames(frameCount, frameRate) {
  if (!Number.isInteger(frameCount) || frameCount < 0)
    throw new RangeError("frameCount cannot be negative");
  if (!Number.isFinite(frameRate) || frameRate <= 0)
    throw new RangeError("frameRate must be positive");
  return frameCount / frameRate;
}
function parseRational(value) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : 0;
  if (!value || value === "N/A")
    return 0;
  if (!value.includes("/")) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const [numeratorText, denominatorText] = value.split("/", 2);
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0)
    return 0;
  return numerator / denominator;
}
function clampFocus(focus) {
  return {
    x: Math.min(1, Math.max(0, focus.x)),
    y: Math.min(1, Math.max(0, focus.y))
  };
}
function supportedAiScales(model) {
  return model === "realesr-animevideov3" ? [2, 3, 4] : [4];
}
function requiredUpscaleRatio(source, target, mode) {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) {
    throw new RangeError("source and target dimensions must be positive");
  }
  const widthRatio = target.width / source.width;
  const heightRatio = target.height / source.height;
  return mode === "cover" ? Math.max(widthRatio, heightRatio) : Math.min(widthRatio, heightRatio);
}
function selectAiScale(source, target, mode, model, requested = "auto") {
  const supported = supportedAiScales(model);
  if (requested !== "auto") {
    if (!supported.includes(requested))
      throw new RangeError(`${model} does not support x${requested}`);
    return requested;
  }
  const required = requiredUpscaleRatio(source, target, mode);
  if (required <= 1)
    return 1;
  const maximumLanczosUpscale = 1.2;
  return supported.find((scale) => required / scale <= maximumLanczosUpscale) ?? supported.at(-1) ?? 4;
}
function decimal(value) {
  return Number(value.toFixed(6)).toString();
}
function buildFfmpegVideoFilter(mode, target, focus = { x: 0.5, y: 0.5 }) {
  const x = decimal(clampFocus(focus).x);
  const y = decimal(clampFocus(focus).y);
  const size = `${target.width}:${target.height}`;
  const outputMetadata = "setsar=1,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709";
  if (mode === "cover") {
    return `scale=${size}:force_original_aspect_ratio=increase:flags=lanczos,crop=${size}:(iw-ow)*${x}:(ih-oh)*${y},${outputMetadata}`;
  }
  if (mode === "contain") {
    return `scale=${size}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${size}:(ow-iw)*${x}:(oh-ih)*${y}:color=black,${outputMetadata}`;
  }
  return [
    "split=2[background][foreground]",
    `[background]scale=${size}:force_original_aspect_ratio=increase:flags=lanczos,crop=${size}:(iw-ow)*${x}:(ih-oh)*${y},boxblur=luma_radius=min(h\\,w)/40:luma_power=2[blurred]`,
    `[foreground]scale=${size}:force_original_aspect_ratio=decrease:flags=lanczos[subject]`,
    `[blurred][subject]overlay=(W-w)/2:(H-h)/2,${outputMetadata}`
  ].join(";");
}
function tileFallbackOrder(tile) {
  const manualFallbacks = [384, 256, 128, 64, 32];
  if (tile === 0)
    return [0, ...manualFallbacks];
  return [.../* @__PURE__ */ new Set([tile, ...manualFallbacks.filter((candidate) => candidate < tile)])].filter((candidate) => candidate > 0);
}
function frameCacheKey(input) {
  const usesRife = input.interpolation?.mode === "rife";
  return cacheKey({
    cacheSchemaVersion: 4,
    processingRevision: input.processingRevision ?? FRAME_CACHE_PIPELINE_REVISION,
    sceneDetectorRevision: input.sceneDetectorRevision ?? "frame-risk-v1",
    input: input.input,
    sourceFps: input.sourceFps,
    upscale: {
      mode: input.upscaleMode,
      backend: input.upscaleBackend ?? (input.upscaleMode === "lanczos" ? "lanczos" : "realesrgan-ncnn-vulkan"),
      model: input.model,
      actualScale: input.actualScale,
      requestedTile: input.requestedTile ?? null
    },
    runtimeIdentity: input.runtimeIdentity ?? {},
    ...usesRife ? {
      interpolation: input.interpolation
    } : {},
    ...usesRife && input.sourceRange ? { sourceRange: input.sourceRange } : {}
  });
}
function rifeDirectoryArguments(input) {
  if (!Number.isInteger(input.inputFrameCount) || input.inputFrameCount < 2) {
    throw new RangeError("RIFE directory mode requires at least two input frames");
  }
  const useUhd = input.interpolation.memoryMode === "uhd" || input.interpolation.memoryMode === "auto" && input.source.width * input.source.height >= 3840 * 2160;
  return [
    "-i",
    input.inputDirectory,
    "-o",
    input.outputDirectory,
    "-n",
    String(input.inputFrameCount * 2),
    "-m",
    input.interpolation.model,
    "-j",
    "1:2:2",
    "-f",
    "%08d.png",
    ...input.gpuId === void 0 || input.gpuId === "auto" ? [] : ["-g", String(input.gpuId)],
    ...useUhd ? ["-u"] : []
  ];
}
function projectFrameStorage(existingSizes, totalFrames, conservativeTotalBytes, measuredSafetyFactor = 1.5) {
  if (!Number.isInteger(totalFrames) || totalFrames < 0)
    throw new RangeError("totalFrames cannot be negative");
  if (conservativeTotalBytes < 0)
    throw new RangeError("conservativeTotalBytes cannot be negative");
  const validSizes = existingSizes.filter((size) => Number.isFinite(size) && size >= 0);
  const existingBytes = validSizes.reduce((sum, size) => sum + size, 0);
  const complete = validSizes.length >= totalFrames && totalFrames > 0;
  const measured = validSizes.length >= 8;
  const average = measured ? existingBytes / validSizes.length : 0;
  const measuredTotal = measured ? Math.ceil(average * totalFrames * measuredSafetyFactor) : conservativeTotalBytes;
  const estimatedTotalBytes = complete ? existingBytes : Math.max(existingBytes, Math.min(conservativeTotalBytes, measuredTotal));
  return {
    existingBytes,
    estimatedTotalBytes,
    remainingBytes: Math.max(0, estimatedTotalBytes - existingBytes),
    frameCount: validSizes.length,
    measured
  };
}
function videoEncoderArguments(encoding) {
  if (encoding.encoder === "h264_nvenc") {
    const preset = encoding.preset === "medium" ? "p5" : encoding.preset === "slow" ? "p6" : "p7";
    return [
      "-c:v",
      "h264_nvenc",
      "-profile:v",
      "high",
      "-preset",
      preset,
      "-tune",
      "hq",
      "-rc",
      "vbr",
      "-cq",
      String(encoding.crf),
      "-b:v",
      "0"
    ];
  }
  return [
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    encoding.preset,
    "-crf",
    String(encoding.crf),
    "-x264-params",
    "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv"
  ];
}
function estimateDiskUsage(input) {
  const safety = input.safetyFactor ?? 1.15;
  if (!Number.isFinite(safety) || safety < 1)
    throw new RangeError("safetyFactor must be at least 1");
  const sourceFrameCount = input.sourceFrameCount;
  const interpolationFactor = input.interpolationFactor ?? 1;
  const forwardFrameCount = interpolatedForwardFrameCount(sourceFrameCount, interpolationFactor);
  const processingFrameCount = interpolationFactor === 2 && input.loopMode === "none" ? sourceFrameCount * 2 : forwardFrameCount;
  const resultFrameCount = interpolatedOutputFrameCount(sourceFrameCount, input.loopMode, interpolationFactor);
  const upscaleFactor = input.upscaleMode === "realesrgan" ? input.upscaleFactor ?? 4 : 1;
  const rawSourceBytes = input.sourceWidth * input.sourceHeight * 4 * sourceFrameCount;
  const rawInterpolatedBytes = input.sourceWidth * input.sourceHeight * 4 * Math.max(0, processingFrameCount - sourceFrameCount);
  const rawEnhancedBytes = input.sourceWidth * upscaleFactor * input.sourceHeight * upscaleFactor * 4 * processingFrameCount;
  const sourceFramesBytes = Math.ceil(rawSourceBytes * safety);
  const interpolatedFramesBytes = interpolationFactor === 2 ? Math.ceil(rawInterpolatedBytes * safety) : 0;
  const enhancedFramesBytes = input.upscaleMode === "realesrgan" ? Math.ceil(rawEnhancedBytes * safety) : 0;
  const sequenceOverheadBytes = resultFrameCount * 4096;
  const rawTargetBytes = input.targetWidth * input.targetHeight * 1.5 * resultFrameCount;
  const outputBytes = Math.ceil(rawTargetBytes * 0.18 * safety);
  return {
    sourceFramesBytes,
    interpolatedFramesBytes,
    enhancedFramesBytes,
    sequenceOverheadBytes,
    outputBytes,
    totalBytes: sourceFramesBytes + interpolatedFramesBytes + enhancedFramesBytes + sequenceOverheadBytes + outputBytes
  };
}
function stableValue(value) {
  if (Array.isArray(value))
    return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}
function stableJson(value) {
  return JSON.stringify(stableValue(value));
}
function cacheKey(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
function makeProgressEvent(input) {
  const now = input.nowMs ?? Date.now();
  const total = Math.max(0, input.total);
  const current = Math.max(0, Math.min(input.current, total || input.current));
  const percent = total === 0 ? 0 : Number((current / total * 100).toFixed(2));
  const elapsed = Math.max(0, now - input.startedAtMs);
  const etaMs = current > 0 && current < total ? Math.max(0, Math.round(elapsed / current * (total - current))) : current >= total && total > 0 ? 0 : null;
  return { jobId: input.jobId, phase: input.phase, current, total, percent, etaMs, message: input.message };
}

// packages/core/dist/job-state.js
async function fingerprintInput(path) {
  try {
    const info = await stat2(path);
    if (!info.isFile())
      throw new Error("not a file");
    return { path: resolve3(path), size: info.size, modifiedMs: Math.round(info.mtimeMs) };
  } catch (error) {
    throw new AppError("E_INPUT_NOT_FOUND", `Input video does not exist: ${resolve3(path)}`, void 0, { cause: error });
  }
}
function jobSpecIdentity(spec) {
  if (spec.version === 1 && spec.interpolation.mode === "none") {
    const { interpolation: _interpolation, ...legacy } = spec;
    return legacy;
  }
  return spec;
}
function createJobId(spec, fingerprint) {
  return cacheKey({ spec: jobSpecIdentity(spec), input: fingerprint }).slice(0, 20);
}
function stateFilePath(jobDirectory) {
  return join3(jobDirectory, "job-state.json");
}
async function loadJobState(jobDirectory) {
  try {
    const parsed = JSON.parse(await readFile2(stateFilePath(jobDirectory), "utf8"));
    if (parsed.schemaVersion !== 1 || typeof parsed.jobId !== "string" || !Array.isArray(parsed.completedUpscaleFrames)) {
      throw new Error("unsupported state shape");
    }
    return parsed;
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT")
      return null;
    throw new AppError("E_JOB_STATE", `Could not read task state in ${jobDirectory}`, void 0, { cause: error });
  }
}
async function saveJobState(jobDirectory, state) {
  await mkdir3(jobDirectory, { recursive: true });
  const target = stateFilePath(jobDirectory);
  const temporary = `${target}.${randomUUID3()}.tmp`;
  state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const next = { ...state };
  try {
    await writeFile2(temporary, `${JSON.stringify(next, null, 2)}
`, { encoding: "utf8", flag: "wx" });
    await rename2(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => void 0);
    throw new AppError("E_JOB_STATE", `Could not save task state in ${jobDirectory}`, void 0, { cause: error });
  }
}
function cancellationFilePath(jobDirectory) {
  return join3(jobDirectory, ".cancel");
}
async function clearCancellation(jobDirectory) {
  await unlink(cancellationFilePath(jobDirectory)).catch(() => void 0);
}
async function assertNotCancelled(jobDirectory, signal) {
  if (signal?.aborted)
    throw new AppError("E_CANCELLED", "Operation cancelled");
  const requested = await access3(cancellationFilePath(jobDirectory)).then(() => true, () => false);
  if (requested)
    throw new AppError("E_CANCELLED", "Operation cancelled");
}
function frameFileName(zeroBasedIndex) {
  if (!Number.isInteger(zeroBasedIndex) || zeroBasedIndex < 0)
    throw new RangeError("frame index cannot be negative");
  return `frame_${String(zeroBasedIndex + 1).padStart(8, "0")}.png`;
}
async function linkOrCopy(source, destination) {
  await mkdir3(dirname3(destination), { recursive: true });
  if (await access3(destination).then(() => true, () => false))
    return "existing";
  try {
    await link(source, destination);
    return "linked";
  } catch (error) {
    const code = error.code;
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(code ?? ""))
      throw error;
    await copyFile(source, destination);
    return "copied";
  }
}
async function buildFrameSequence(sourceDirectory, destinationDirectory, sourceIndices, onFrame) {
  await mkdir3(destinationDirectory, { recursive: true });
  const counts = { linked: 0, copied: 0, existing: 0 };
  for (let sequenceIndex = 0; sequenceIndex < sourceIndices.length; sequenceIndex += 1) {
    const sourceIndex = sourceIndices[sequenceIndex];
    if (sourceIndex === void 0)
      throw new AppError("E_JOB_STATE", "Sequence contains an undefined source frame");
    const result = await linkOrCopy(join3(sourceDirectory, frameFileName(sourceIndex)), join3(destinationDirectory, frameFileName(sequenceIndex)));
    counts[result] += 1;
    onFrame?.(sequenceIndex + 1, sourceIndices.length);
  }
  return counts;
}
async function availableDiskBytes(path) {
  const info = await statfs(path, { bigint: true });
  const available = info.bavail * info.bsize;
  return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
}
async function sameFilesystem(leftPath, rightPath) {
  const [left, right] = await Promise.all([stat2(leftPath), stat2(rightPath)]);
  return left.dev === right.dev;
}
async function ensureDiskSpace(path, requiredBytes, purpose = "work") {
  const available = await availableDiskBytes(path);
  if (available < requiredBytes) {
    throw new AppError("E_INSUFFICIENT_SPACE", `Not enough ${purpose} disk space`, {
      path: resolve3(path),
      requiredBytes,
      availableBytes: available,
      purpose
    });
  }
}

// packages/core/dist/media.js
import { stat as stat3 } from "node:fs/promises";
import { resolve as resolve4 } from "node:path";
function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function detectFrameRateMode(frames, averageFrameRate, nominalFrameRate) {
  const timestamps = (frames ?? []).map((frame) => Number(frame.best_effort_timestamp_time)).filter((value) => Number.isFinite(value));
  if (timestamps.length >= 3 && averageFrameRate > 0) {
    const expectedInterval = 1 / averageFrameRate;
    const tolerance = Math.max(5e-4, expectedInterval * 0.01);
    for (let index = 1; index < timestamps.length; index += 1) {
      const interval = timestamps[index] - timestamps[index - 1];
      if (interval <= 0 || Math.abs(interval - expectedInterval) > tolerance)
        return "variable";
    }
    return "constant";
  }
  if (averageFrameRate > 0 && nominalFrameRate > 0) {
    const tolerance = Math.max(1e-3, averageFrameRate * 1e-3);
    return Math.abs(averageFrameRate - nominalFrameRate) <= tolerance ? "constant" : "variable";
  }
  return "unknown";
}
async function inspectMedia(inputPath, options = {}) {
  const absolutePath = resolve4(inputPath);
  let fileSize = 0;
  try {
    const info = await stat3(absolutePath);
    if (!info.isFile())
      throw new Error("not a file");
    fileSize = info.size;
  } catch (error) {
    throw new AppError("E_INPUT_NOT_FOUND", `Input video does not exist: ${absolutePath}`, { inputPath: absolutePath }, { cause: error });
  }
  const runner = options.runner ?? runCommand;
  let parsed;
  try {
    const result = await runner({
      executable: options.ffprobePath ?? "ffprobe",
      args: [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "format=format_name,duration,size:stream=index,codec_type,codec_name,width,height,sample_aspect_ratio,display_aspect_ratio,pix_fmt,color_space,color_primaries,color_transfer,color_range,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,duration:frame=stream_index,best_effort_timestamp_time",
        "-of",
        "json",
        absolutePath
      ]
    }, { signal: options.signal });
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    if (error instanceof AppError && ["E_INPUT_NOT_FOUND", "E_DEPENDENCY_MISSING", "E_CANCELLED"].includes(error.code))
      throw error;
    throw new AppError("E_MEDIA_INSPECTION_FAILED", `Could not inspect video: ${absolutePath}`, void 0, { cause: error });
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video || !video.width || !video.height) {
    throw new AppError("E_UNSUPPORTED_MEDIA", "Input contains no readable video stream", { inputPath: absolutePath });
  }
  const formatDuration = numberOrZero(parsed.format?.duration);
  const streamDuration = numberOrZero(video.duration);
  const durationSeconds = formatDuration || streamDuration;
  const averageFrameRate = parseRational(video.avg_frame_rate);
  const nominalFrameRate = parseRational(video.r_frame_rate);
  const frameRate = averageFrameRate || nominalFrameRate;
  const explicitFrames = numberOrZero(video.nb_read_frames) || numberOrZero(video.nb_frames);
  const frameCount = Math.max(0, Math.round(explicitFrames || durationSeconds * frameRate));
  if (frameRate <= 0 || frameCount <= 0) {
    throw new AppError("E_UNSUPPORTED_MEDIA", "Video frame rate or frame count could not be determined", {
      frameRate,
      frameCount
    });
  }
  return {
    path: absolutePath,
    format: parsed.format?.format_name ?? "unknown",
    durationSeconds,
    sizeBytes: numberOrZero(parsed.format?.size) || fileSize,
    video: {
      index: video.index ?? 0,
      codec: video.codec_name ?? "unknown",
      width: video.width,
      height: video.height,
      ...video.sample_aspect_ratio ? { sampleAspectRatio: video.sample_aspect_ratio } : {},
      ...video.display_aspect_ratio ? { displayAspectRatio: video.display_aspect_ratio } : {},
      ...video.pix_fmt ? { pixelFormat: video.pix_fmt } : {},
      ...video.color_space ? { colorSpace: video.color_space } : {},
      ...video.color_primaries ? { colorPrimaries: video.color_primaries } : {},
      ...video.color_transfer ? { colorTransfer: video.color_transfer } : {},
      ...video.color_range ? { colorRange: video.color_range } : {},
      frameRate,
      frameRateMode: detectFrameRateMode(parsed.frames?.filter((frame) => frame.stream_index === void 0 || frame.stream_index === (video.index ?? 0)), averageFrameRate, nominalFrameRate),
      frameCount,
      durationSeconds: streamDuration || durationSeconds
    },
    audio: streams.filter((stream) => stream.codec_type === "audio").map((stream) => ({ index: stream.index ?? 0, codec: stream.codec_name ?? "unknown" }))
  };
}
function exactCheck(name, expected, actual) {
  return { name, expected, actual, passed: expected === actual };
}
function toleranceCheck(name, expected, actual, tolerance) {
  return { name, expected, actual, passed: Math.abs(expected - actual) <= tolerance };
}
function finiteTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}
function healthSegment(start, end, reportedDuration) {
  const normalizedEnd = Math.max(start, end);
  const duration = reportedDuration === void 0 ? normalizedEnd - start : Math.max(0, reportedDuration);
  return {
    startSeconds: Number(start.toFixed(6)),
    endSeconds: Number(normalizedEnd.toFixed(6)),
    durationSeconds: Number(duration.toFixed(6))
  };
}
function parseBlackSegments(stderr) {
  return [...stderr.matchAll(/black_start:\s*([0-9]+(?:\.[0-9]+)?)\s+black_end:\s*([0-9]+(?:\.[0-9]+)?)\s+black_duration:\s*([0-9]+(?:\.[0-9]+)?)/g)].map((match) => healthSegment(Number(match[1]), Number(match[2]), Number(match[3])));
}
function parseFreezeSegments(stderr, mediaDuration) {
  const segments = [];
  let start;
  let duration;
  for (const line of stderr.split(/\r?\n/)) {
    const nextStart = finiteTimestamp(/(?:lavfi\.freezedetect\.)?freeze_start:\s*([0-9]+(?:\.[0-9]+)?)/.exec(line)?.[1]);
    if (nextStart !== void 0) {
      if (start !== void 0)
        segments.push(healthSegment(start, nextStart, duration));
      start = nextStart;
      duration = void 0;
    }
    const nextDuration = finiteTimestamp(/(?:lavfi\.freezedetect\.)?freeze_duration:\s*([0-9]+(?:\.[0-9]+)?)/.exec(line)?.[1]);
    if (nextDuration !== void 0)
      duration = nextDuration;
    const end = finiteTimestamp(/(?:lavfi\.freezedetect\.)?freeze_end:\s*([0-9]+(?:\.[0-9]+)?)/.exec(line)?.[1]);
    if (end !== void 0 && start !== void 0) {
      segments.push(healthSegment(start, end, duration));
      start = void 0;
      duration = void 0;
    }
  }
  if (start !== void 0)
    segments.push(healthSegment(start, Math.max(start, mediaDuration), duration));
  return segments;
}
function coveredDuration(segments) {
  const sorted = segments.map((segment) => ({ start: segment.startSeconds, end: segment.endSeconds })).sort((left, right) => left.start - right.start);
  let total = 0;
  let currentStart;
  let currentEnd = 0;
  for (const segment of sorted) {
    if (currentStart === void 0) {
      currentStart = segment.start;
      currentEnd = segment.end;
    } else if (segment.start <= currentEnd)
      currentEnd = Math.max(currentEnd, segment.end);
    else {
      total += currentEnd - currentStart;
      currentStart = segment.start;
      currentEnd = segment.end;
    }
  }
  return total + (currentStart === void 0 ? 0 : currentEnd - currentStart);
}
function catastrophicCoverage(segments, mediaDuration) {
  if (mediaDuration <= 0 || segments.length === 0)
    return false;
  const longest = Math.max(...segments.map((segment) => segment.durationSeconds));
  return coveredDuration(segments) >= mediaDuration * 0.98 || longest >= Math.max(2, mediaDuration * 0.9);
}
async function verifyDecodedHealth(inputPath, media, options) {
  if (options.sourceRange && options.sourceRanges) {
    throw new AppError("E_INVALID_CONFIG", "Decoded health reference cannot use sourceRange and sourceRanges together");
  }
  const requestedRanges = options.sourceRanges ?? (options.sourceRange ? [options.sourceRange] : void 0);
  const normalizedRanges = requestedRanges ? requestedRanges.map((range) => ({ ...range })).sort((left, right) => left.startFrame - right.startFrame).reduce((ranges, range) => {
    if (!Number.isSafeInteger(range.startFrame) || !Number.isSafeInteger(range.endFrameExclusive) || range.startFrame < 0 || range.endFrameExclusive <= range.startFrame || range.endFrameExclusive > media.video.frameCount) {
      throw new AppError("E_INVALID_CONFIG", "Decoded health reference range is outside the source video", {
        sourceRange: range,
        sourceFrameCount: media.video.frameCount
      });
    }
    const previous = ranges.at(-1);
    if (previous && range.startFrame <= previous.endFrameExclusive) {
      previous.endFrameExclusive = Math.max(previous.endFrameExclusive, range.endFrameExclusive);
    } else
      ranges.push(range);
    return ranges;
  }, []) : void 0;
  if (normalizedRanges?.length === 0) {
    throw new AppError("E_INVALID_CONFIG", "Decoded health reference requires at least one source range");
  }
  const selectedFrameCount = normalizedRanges?.reduce((total, range) => total + range.endFrameExclusive - range.startFrame, 0);
  const mediaDuration = selectedFrameCount !== void 0 ? selectedFrameCount / media.video.frameRate : Math.max(media.durationSeconds, media.video.durationSeconds, media.video.frameCount / media.video.frameRate);
  const rangeFilters = normalizedRanges?.length === 1 ? [
    `trim=start_frame=${normalizedRanges[0]?.startFrame}:end_frame=${normalizedRanges[0]?.endFrameExclusive}`,
    "setpts=PTS-STARTPTS"
  ] : normalizedRanges && normalizedRanges.length > 1 ? [
    `select=${normalizedRanges.map((range) => `between(n\\,${range.startFrame}\\,${range.endFrameExclusive - 1})`).join("+")}`,
    `setpts=N/(${media.video.frameRate}*TB)`
  ] : [];
  const healthFilters = [
    ...rangeFilters,
    "blackdetect=d=0.04:pic_th=0.98:pix_th=0.10",
    "freezedetect=n=-60dB:d=2"
  ];
  try {
    const result = await options.runner({
      executable: options.ffmpegPath,
      args: [
        "-hide_banner",
        "-loglevel",
        "info",
        "-nostdin",
        "-xerror",
        "-i",
        resolve4(inputPath),
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        healthFilters.join(","),
        "-f",
        "null",
        "-"
      ]
    }, { signal: options.signal });
    const blackSegments = parseBlackSegments(result.stderr);
    const freezeSegments = parseFreezeSegments(result.stderr, mediaDuration);
    return {
      fullDecodeCompleted: true,
      blackSegments,
      freezeSegments,
      catastrophicBlack: catastrophicCoverage(blackSegments, mediaDuration),
      catastrophicFreeze: catastrophicCoverage(freezeSegments, mediaDuration)
    };
  } catch (error) {
    if (error instanceof AppError && (error.code === "E_CANCELLED" || error.code === "E_DEPENDENCY_MISSING"))
      throw error;
    return {
      fullDecodeCompleted: false,
      blackSegments: [],
      freezeSegments: [],
      catastrophicBlack: false,
      catastrophicFreeze: false,
      decodeError: error instanceof Error ? error.message : String(error)
    };
  }
}
async function verifyMedia(inputPath, expectation, options = {}) {
  const media = await inspectMedia(inputPath, options);
  const checks = [];
  if (expectation.width !== void 0)
    checks.push(exactCheck("width", expectation.width, media.video.width));
  if (expectation.height !== void 0)
    checks.push(exactCheck("height", expectation.height, media.video.height));
  if (expectation.sampleAspectRatio !== void 0) {
    checks.push(exactCheck("sampleAspectRatio", expectation.sampleAspectRatio, media.video.sampleAspectRatio));
  }
  if (expectation.frameCount !== void 0)
    checks.push(exactCheck("frameCount", expectation.frameCount, media.video.frameCount));
  if (expectation.frameRate !== void 0) {
    checks.push(toleranceCheck("frameRate", expectation.frameRate, media.video.frameRate, expectation.frameRateTolerance ?? 0.01));
  }
  if (expectation.durationSeconds !== void 0) {
    checks.push(toleranceCheck("durationSeconds", expectation.durationSeconds, media.durationSeconds, expectation.durationToleranceSeconds ?? 0.05));
  }
  if (expectation.codec !== void 0)
    checks.push(exactCheck("codec", expectation.codec, media.video.codec));
  if (expectation.pixelFormat !== void 0)
    checks.push(exactCheck("pixelFormat", expectation.pixelFormat, media.video.pixelFormat));
  if (expectation.colorSpace !== void 0)
    checks.push(exactCheck("colorSpace", expectation.colorSpace, media.video.colorSpace));
  if (expectation.colorPrimaries !== void 0)
    checks.push(exactCheck("colorPrimaries", expectation.colorPrimaries, media.video.colorPrimaries));
  if (expectation.colorTransfer !== void 0)
    checks.push(exactCheck("colorTransfer", expectation.colorTransfer, media.video.colorTransfer));
  if (expectation.colorRange !== void 0)
    checks.push(exactCheck("colorRange", expectation.colorRange, media.video.colorRange));
  if (expectation.audio === "none")
    checks.push(exactCheck("audioStreams", 0, media.audio.length));
  const health = options.fullDecode ? await verifyDecodedHealth(inputPath, media, {
    ffmpegPath: options.ffmpegPath ?? "ffmpeg",
    runner: options.runner ?? runCommand,
    signal: options.signal
  }) : void 0;
  const referenceHealth = typeof options.fullDecode === "object" ? await verifyDecodedHealth(options.fullDecode.reference.inputPath, options.fullDecode.reference.media, {
    ffmpegPath: options.ffmpegPath ?? "ffmpeg",
    runner: options.runner ?? runCommand,
    signal: options.signal,
    sourceRange: options.fullDecode.reference.sourceRange,
    sourceRanges: options.fullDecode.reference.sourceRanges
  }) : void 0;
  if (health) {
    checks.push(exactCheck("fullDecode", true, health.fullDecodeCompleted));
    if (referenceHealth) {
      checks.push(exactCheck("referenceFullDecode", true, referenceHealth.fullDecodeCompleted));
      if (health.fullDecodeCompleted && referenceHealth.fullDecodeCompleted) {
        checks.push(exactCheck("catastrophicBlack", false, health.catastrophicBlack && !referenceHealth.catastrophicBlack));
        checks.push(exactCheck("catastrophicFreeze", false, health.catastrophicFreeze && !referenceHealth.catastrophicFreeze));
      }
    } else if (health.fullDecodeCompleted) {
      checks.push(exactCheck("catastrophicBlack", false, health.catastrophicBlack));
      checks.push(exactCheck("catastrophicFreeze", false, health.catastrophicFreeze));
    }
  }
  const result = {
    passed: checks.every((check) => check.passed),
    media,
    checks,
    ...health ? { health } : {},
    ...referenceHealth ? { referenceHealth } : {}
  };
  if (!result.passed && options.throwOnFailure) {
    throw new AppError("E_VERIFICATION_FAILED", "Output video did not match its expected properties", {
      failedChecks: checks.filter((check) => !check.passed),
      ...health ? { health } : {},
      ...referenceHealth ? { referenceHealth } : {}
    });
  }
  return result;
}

// packages/core/dist/pipeline.js
import { createHash as createHash2 } from "node:crypto";
import { createReadStream } from "node:fs";
import { access as access4, mkdir as mkdir4, readdir as readdir3, rename as rename3, rm as rm3, stat as stat5 } from "node:fs/promises";
import { dirname as dirname4, extname, join as join4, resolve as resolve5 } from "node:path";

// packages/core/dist/png.js
import { open as open3, stat as stat4 } from "node:fs/promises";
var SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const result = await handle.read(buffer, 0, length, position);
  return result.bytesRead === length ? buffer : null;
}
async function inspectPng(path) {
  let handle = null;
  try {
    const fileSize = (await stat4(path)).size;
    if (fileSize < 57)
      return null;
    handle = await open3(path, "r");
    const signature = await readExactly(handle, 8, 0);
    if (!signature?.equals(SIGNATURE))
      return null;
    let offset = 8;
    let dimensions = null;
    let sawImageData = false;
    let chunkCount = 0;
    while (offset + 12 <= fileSize && chunkCount < 1e5) {
      const header = await readExactly(handle, 8, offset);
      if (!header)
        return null;
      const dataLength = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      const nextOffset = offset + 12 + dataLength;
      if (nextOffset > fileSize)
        return null;
      if (chunkCount === 0) {
        if (type !== "IHDR" || dataLength !== 13)
          return null;
        const ihdr = await readExactly(handle, 13, offset + 8);
        if (!ihdr)
          return null;
        const width = ihdr.readUInt32BE(0);
        const height = ihdr.readUInt32BE(4);
        if (width === 0 || height === 0)
          return null;
        dimensions = { width, height };
      }
      if (type === "IDAT")
        sawImageData = true;
      if (type === "IEND") {
        if (dataLength !== 0 || !dimensions || !sawImageData)
          return null;
        return dimensions;
      }
      offset = nextOffset;
      chunkCount += 1;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => void 0);
  }
}
async function validatePng(path, expected) {
  const actual = await inspectPng(path);
  if (!actual)
    return false;
  return expected === void 0 || actual.width === expected.width && actual.height === expected.height;
}

// packages/core/dist/validation.js
var ASPECT_MODES = /* @__PURE__ */ new Set(["blur-background", "cover", "contain"]);
var LOOP_MODES = /* @__PURE__ */ new Set(["pingpong", "none"]);
var UPSCALE_MODES = /* @__PURE__ */ new Set(["realesrgan", "lanczos"]);
var PRESETS = /* @__PURE__ */ new Set(["medium", "slow", "slower"]);
var ENCODERS = /* @__PURE__ */ new Set(["libx264", "h264_nvenc"]);
var INTERPOLATION_MODES = /* @__PURE__ */ new Set(["none", "rife"]);
var RIFE_MEMORY_MODES = /* @__PURE__ */ new Set(["auto", "standard", "uhd"]);
var UPSCALE_BACKENDS = /* @__PURE__ */ new Set([
  "lanczos",
  "realesrgan-ncnn-vulkan"
]);
var INTERPOLATION_BACKENDS = /* @__PURE__ */ new Set([
  "rife-ncnn-vulkan"
]);
var RIFE_MODELS = /* @__PURE__ */ new Set(["rife-v4.6"]);
var SUPPORTED_JOB_SPEC_VERSION_SET = new Set(SUPPORTED_JOB_SPEC_VERSIONS);
function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("E_INVALID_CONFIG", `${label} must be an object`);
  }
  return value;
}
function stringValue(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("E_INVALID_CONFIG", `${label} must be a non-empty string`);
  }
  return value.trim();
}
function finiteNumber2(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("E_INVALID_CONFIG", `${label} must be a finite number`);
  }
  return value;
}
function integerInRange(value, label, min, max) {
  const parsed = finiteNumber2(value, label);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError("E_INVALID_CONFIG", `${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
function evenDimension(value, label) {
  const parsed = integerInRange(value, label, 2, 16384);
  if (parsed % 2 !== 0) {
    throw new AppError("E_INVALID_CONFIG", `${label} must be even for yuv420p output`);
  }
  return parsed;
}
function member(value, values, label) {
  if (typeof value !== "string" || !values.has(value)) {
    throw new AppError("E_INVALID_CONFIG", `${label} has an unsupported value`, {
      value,
      allowed: [...values]
    });
  }
  return value;
}
function rejectPresent(source, keys, label) {
  const present = keys.filter((key) => source[key] !== void 0);
  if (present.length > 0) {
    throw new AppError("E_INVALID_CONFIG", `${label} does not support ${present.join(", ")}`);
  }
}
function assertOnlyKeys(source, keys, label) {
  const allowed = new Set(keys);
  const unsupported = Object.keys(source).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new AppError("E_INVALID_CONFIG", `${label} contains unsupported fields: ${unsupported.join(", ")}`);
  }
}
function parseJobSpec(value) {
  const source = record(value, "JobSpec");
  const target = record(source.target, "target");
  const focus = source.focus === void 0 ? {} : record(source.focus, "focus");
  const encoding = source.encoding === void 0 ? {} : record(source.encoding, "encoding");
  const rawVersion = source.version ?? LEGACY_JOB_SPEC_VERSION;
  if (typeof rawVersion !== "number" || !SUPPORTED_JOB_SPEC_VERSION_SET.has(rawVersion)) {
    throw new AppError("E_INVALID_CONFIG", `Unsupported JobSpec version: ${String(rawVersion)}`);
  }
  const version = rawVersion;
  if (version < SOURCE_RANGE_JOB_SPEC_VERSION && source.sourceRange !== void 0) {
    throw new AppError("E_INVALID_CONFIG", `sourceRange is only supported in JobSpec v${SOURCE_RANGE_JOB_SPEC_VERSION} and newer`);
  }
  let sourceRange;
  if (version >= SOURCE_RANGE_JOB_SPEC_VERSION) {
    const range = record(source.sourceRange, "sourceRange");
    const startFrame = integerInRange(range.startFrame, "sourceRange.startFrame", 0, Number.MAX_SAFE_INTEGER);
    const endFrameExclusive = integerInRange(range.endFrameExclusive, "sourceRange.endFrameExclusive", 1, Number.MAX_SAFE_INTEGER);
    if (endFrameExclusive <= startFrame) {
      throw new AppError("E_INVALID_CONFIG", "sourceRange must contain at least one frame");
    }
    sourceRange = { startFrame, endFrameExclusive };
  }
  const isV4 = version === JOB_SPEC_VERSION;
  if (isV4) {
    rejectPresent(source, ["upscaleMode", "model", "tile", "gpuId", "aiScale", "batchSize"], `JobSpec v${JOB_SPEC_VERSION}`);
  }
  const supportsInterpolation = version >= INTERPOLATION_JOB_SPEC_VERSION;
  const interpolationSource = isV4 ? record(source.interpolation, "interpolation") : supportsInterpolation && source.interpolation !== void 0 ? record(source.interpolation, "interpolation") : {};
  let interpolationBackend = "rife-ncnn-vulkan";
  let interpolationMode;
  let interpolationFactor;
  let interpolationModel;
  let interpolationMemoryMode;
  if (isV4) {
    assertOnlyKeys(interpolationSource, ["mode", "factor", "backend", "model", "memoryMode", "sceneCutMode"], "interpolation");
    interpolationMode = member(interpolationSource.mode, INTERPOLATION_MODES, "interpolation.mode");
    interpolationFactor = integerInRange(interpolationSource.factor, "interpolation.factor", 1, 2);
    interpolationBackend = member(interpolationSource.backend, INTERPOLATION_BACKENDS, "interpolation.backend");
    interpolationModel = member(interpolationSource.model, RIFE_MODELS, "interpolation.model");
    interpolationMemoryMode = member(interpolationSource.memoryMode, RIFE_MEMORY_MODES, "interpolation.memoryMode");
    if (interpolationSource.sceneCutMode !== "hold") {
      throw new AppError("E_INVALID_CONFIG", "interpolation.sceneCutMode must be hold");
    }
    const validEngine = interpolationBackend === "rife-ncnn-vulkan" && interpolationModel === "rife-v4.6";
    if (!validEngine) {
      throw new AppError("E_INVALID_CONFIG", `interpolation backend ${interpolationBackend} does not support model ${interpolationModel}`);
    }
  } else {
    interpolationMode = supportsInterpolation ? member(interpolationSource.mode ?? "none", INTERPOLATION_MODES, "interpolation.mode") : "none";
    interpolationFactor = integerInRange(supportsInterpolation ? interpolationSource.factor ?? (interpolationMode === "rife" ? 2 : 1) : 1, "interpolation.factor", 1, 2);
    const legacyModel = interpolationSource.model ?? "rife-v4.6";
    if (legacyModel !== "rife-v4.6") {
      throw new AppError("E_INVALID_CONFIG", "interpolation.model must be rife-v4.6");
    }
    interpolationModel = "rife-v4.6";
    interpolationMemoryMode = member(interpolationSource.memoryMode ?? "auto", RIFE_MEMORY_MODES, "interpolation.memoryMode");
    const sceneCutMode = interpolationSource.sceneCutMode ?? "hold";
    if (sceneCutMode !== "hold") {
      throw new AppError("E_INVALID_CONFIG", "interpolation.sceneCutMode must be hold");
    }
  }
  if (interpolationMode === "rife" && interpolationFactor !== 2 || interpolationMode === "none" && interpolationFactor !== 1) {
    throw new AppError("E_INVALID_CONFIG", `interpolation mode ${interpolationMode} requires factor ${interpolationMode === "rife" ? 2 : 1}`);
  }
  const focusX = finiteNumber2(focus.x ?? 0.5, "focus.x");
  const focusY = finiteNumber2(focus.y ?? 0.5, "focus.y");
  if (focusX < 0 || focusX > 1 || focusY < 0 || focusY > 1) {
    throw new AppError("E_INVALID_CONFIG", "focus coordinates must be normalized to 0..1");
  }
  const sourceFpsValue = source.sourceFps ?? "auto";
  const sourceFps = sourceFpsValue === "auto" ? "auto" : finiteNumber2(sourceFpsValue, "sourceFps");
  if (sourceFps !== "auto" && (sourceFps <= 0 || sourceFps > 240)) {
    throw new AppError("E_INVALID_CONFIG", "sourceFps must be greater than 0 and at most 240");
  }
  let upscaleMode;
  let upscaleBackend;
  let model;
  let tile;
  let gpuId;
  let aiScaleValue;
  let batchSizeValue;
  const parseTile = (value2, label, fallback) => {
    const parsed = integerInRange(value2 ?? fallback, label, 0, 4096);
    if (parsed !== 0 && parsed % 32 !== 0) {
      throw new AppError("E_INVALID_CONFIG", `${label} must be 0 (automatic) or a multiple of 32`);
    }
    return parsed;
  };
  const parseGpu = (value2, label) => value2 === void 0 || value2 === null || value2 === "auto" ? "auto" : integerInRange(value2, label, 0, 31);
  const parseAiScale = (value2, label, fallback) => {
    const parsed = value2 ?? fallback;
    if (parsed !== "auto" && parsed !== 2 && parsed !== 3 && parsed !== 4) {
      throw new AppError("E_INVALID_CONFIG", `${label} must be auto, 2, 3, or 4`);
    }
    return parsed;
  };
  const parseBatchSize = (value2, label, fallback) => {
    const parsed = integerInRange(value2 ?? fallback, label, 32, 64);
    if (parsed !== 32 && parsed !== 64) {
      throw new AppError("E_INVALID_CONFIG", `${label} must be 32 or 64`);
    }
    return parsed;
  };
  if (isV4) {
    const upscale = record(source.upscale, "upscale");
    upscaleBackend = member(upscale.backend, UPSCALE_BACKENDS, "upscale.backend");
    if (upscaleBackend === "lanczos") {
      assertOnlyKeys(upscale, ["backend", "model"], "upscale");
      if (upscale.model !== "lanczos") {
        throw new AppError("E_INVALID_CONFIG", "upscale backend lanczos requires model lanczos");
      }
      upscaleMode = "lanczos";
      model = "lanczos";
      tile = 0;
      gpuId = "auto";
      aiScaleValue = "auto";
      batchSizeValue = 64;
    } else if (upscaleBackend === "realesrgan-ncnn-vulkan") {
      assertOnlyKeys(upscale, ["backend", "model", "tile", "gpuId", "aiScale", "batchSize"], "upscale");
      if (upscale.model !== "realesr-animevideov3" && upscale.model !== "realesrgan-x4plus") {
        throw new AppError("E_INVALID_CONFIG", "upscale backend realesrgan-ncnn-vulkan requires a supported Real-ESRGAN model");
      }
      upscaleMode = "realesrgan";
      model = upscale.model;
      tile = parseTile(upscale.tile, "upscale.tile", 384);
      gpuId = parseGpu(upscale.gpuId, "upscale.gpuId");
      aiScaleValue = parseAiScale(upscale.aiScale, "upscale.aiScale", "auto");
      if (model === "realesrgan-x4plus" && aiScaleValue !== "auto" && aiScaleValue !== 4) {
        throw new AppError("E_INVALID_CONFIG", "realesrgan-x4plus is only supported at x4");
      }
      batchSizeValue = parseBatchSize(upscale.batchSize, "upscale.batchSize", 64);
    } else {
      throw new AppError("E_INVALID_CONFIG", `Unsupported upscale backend: ${String(upscaleBackend)}`);
    }
  } else {
    upscaleMode = member(source.upscaleMode ?? "realesrgan", UPSCALE_MODES, "upscaleMode");
    upscaleBackend = upscaleMode === "realesrgan" ? "realesrgan-ncnn-vulkan" : "lanczos";
    tile = parseTile(source.tile, "tile", 384);
    model = stringValue(source.model ?? "realesr-animevideov3", "model");
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
      throw new AppError("E_INVALID_CONFIG", "model must be a model name, not a path or command fragment");
    }
    gpuId = parseGpu(source.gpuId, "gpuId");
    aiScaleValue = parseAiScale(source.aiScale, "aiScale", "auto");
    if (aiScaleValue !== "auto" && model !== "realesr-animevideov3" && aiScaleValue !== 4) {
      throw new AppError("E_INVALID_CONFIG", `${model} is only supported at x4`);
    }
    batchSizeValue = parseBatchSize(source.batchSize, "batchSize", 64);
  }
  const crf = integerInRange(encoding.crf ?? 17, "encoding.crf", 0, 51);
  const removeAudio = encoding.removeAudio ?? true;
  if (removeAudio !== true) {
    throw new AppError("E_INVALID_CONFIG", "v1 always removes audio");
  }
  if ((encoding.codec ?? "h264") !== "h264" || (encoding.profile ?? "high") !== "high" || (encoding.pixelFormat ?? "yuv420p") !== "yuv420p") {
    throw new AppError("E_INVALID_CONFIG", "v1 encoding is fixed to H.264 High/yuv420p");
  }
  return {
    version,
    inputPath: stringValue(source.inputPath, "inputPath"),
    outputPath: stringValue(source.outputPath, "outputPath"),
    target: {
      width: evenDimension(target.width, "target.width"),
      height: evenDimension(target.height, "target.height")
    },
    aspectMode: member(source.aspectMode ?? "cover", ASPECT_MODES, "aspectMode"),
    focus: { x: focusX, y: focusY },
    loopMode: member(source.loopMode ?? "pingpong", LOOP_MODES, "loopMode"),
    upscaleMode,
    upscaleBackend,
    model,
    tile,
    sourceFps,
    gpuId,
    aiScale: aiScaleValue,
    batchSize: batchSizeValue,
    interpolation: {
      backend: interpolationBackend,
      mode: interpolationMode,
      factor: interpolationFactor,
      model: interpolationModel,
      memoryMode: interpolationMemoryMode,
      sceneCutMode: "hold"
    },
    ...sourceRange ? { sourceRange } : {},
    encoding: {
      codec: "h264",
      encoder: member(encoding.encoder ?? "libx264", ENCODERS, "encoding.encoder"),
      profile: "high",
      crf,
      preset: member(encoding.preset ?? "slow", PRESETS, "encoding.preset"),
      pixelFormat: "yuv420p",
      removeAudio: true
    }
  };
}
function assertEncoderResolutionSupported(spec) {
  const maxDimension = 4096;
  if (spec.encoding.encoder !== "h264_nvenc" || spec.target.width <= maxDimension && spec.target.height <= maxDimension)
    return;
  const scale = Math.min(maxDimension / spec.target.width, maxDimension / spec.target.height);
  const evenFloor = (value) => Math.max(2, Math.floor(value / 2) * 2);
  throw new AppError("E_ENCODER_UNSUPPORTED_RESOLUTION", `h264_nvenc supports target dimensions up to ${maxDimension} pixels per side`, {
    encoder: "h264_nvenc",
    requested: { ...spec.target },
    maxDimension,
    suggestedTarget: {
      width: evenFloor(spec.target.width * scale),
      height: evenFloor(spec.target.height * scale)
    },
    supportedEncoder: "libx264"
  });
}
function parseVerificationExpectation(value) {
  const source = record(value, "verification expectation");
  const result = {};
  const optionalPositive = (key) => {
    if (source[key] === void 0)
      return void 0;
    const parsed = finiteNumber2(source[key], String(key));
    if (parsed < 0)
      throw new AppError("E_INVALID_CONFIG", `${String(key)} cannot be negative`);
    return parsed;
  };
  result.width = optionalPositive("width");
  result.height = optionalPositive("height");
  result.frameRate = optionalPositive("frameRate");
  result.frameCount = optionalPositive("frameCount");
  result.durationSeconds = optionalPositive("durationSeconds");
  result.durationToleranceSeconds = optionalPositive("durationToleranceSeconds");
  result.frameRateTolerance = optionalPositive("frameRateTolerance");
  if (source.sampleAspectRatio !== void 0) {
    if (source.sampleAspectRatio !== "1:1") {
      throw new AppError("E_INVALID_CONFIG", "sampleAspectRatio must be 1:1");
    }
    result.sampleAspectRatio = "1:1";
  }
  if (source.codec !== void 0) {
    if (source.codec !== "h264")
      throw new AppError("E_INVALID_CONFIG", "codec must be h264");
    result.codec = "h264";
  }
  if (source.pixelFormat !== void 0) {
    if (source.pixelFormat !== "yuv420p")
      throw new AppError("E_INVALID_CONFIG", "pixelFormat must be yuv420p");
    result.pixelFormat = "yuv420p";
  }
  if (source.colorSpace !== void 0) {
    if (source.colorSpace !== "bt709")
      throw new AppError("E_INVALID_CONFIG", "colorSpace must be bt709");
    result.colorSpace = "bt709";
  }
  if (source.colorPrimaries !== void 0) {
    if (source.colorPrimaries !== "bt709")
      throw new AppError("E_INVALID_CONFIG", "colorPrimaries must be bt709");
    result.colorPrimaries = "bt709";
  }
  if (source.colorTransfer !== void 0) {
    if (source.colorTransfer !== "bt709")
      throw new AppError("E_INVALID_CONFIG", "colorTransfer must be bt709");
    result.colorTransfer = "bt709";
  }
  if (source.colorRange !== void 0) {
    if (source.colorRange !== "tv")
      throw new AppError("E_INVALID_CONFIG", "colorRange must be tv");
    result.colorRange = "tv";
  }
  if (source.audio !== void 0) {
    if (source.audio !== "none" && source.audio !== "any") {
      throw new AppError("E_INVALID_CONFIG", "audio must be none or any");
    }
    result.audio = source.audio;
  }
  return Object.fromEntries(Object.entries(result).filter(([, item]) => item !== void 0));
}

// packages/core/dist/pipeline.js
var runtimeIdentityCache = /* @__PURE__ */ new Map();
async function runtimeFileIdentity(path, hashContents) {
  const absolute = resolve5(path);
  const info = await stat5(absolute).catch(() => null);
  if (!info?.isFile())
    return `unresolved:${absolute}`;
  if (hashContents)
    return `sha256:${await sha256File(absolute)}`;
  const identityKey = `${absolute}:${info.size}:${Math.round(info.mtimeMs)}:stat`;
  let pending = runtimeIdentityCache.get(identityKey);
  if (!pending) {
    pending = Promise.resolve(`file:${absolute}:${info.size}:${Math.round(info.mtimeMs)}`);
    runtimeIdentityCache.set(identityKey, pending);
  }
  return await pending;
}
function realesrganModelPaths(spec, binaries, actualAiScale) {
  const modelBase = spec.model === "realesr-animevideov3" ? `${spec.model}-x${actualAiScale}` : spec.model;
  return ["bin", "param"].map((extension) => join4(dirname4(binaries.realesrgan), "models", `${modelBase}.${extension}`));
}
async function frameRuntimeIdentity(spec, binaries, actualAiScale) {
  const paths = [
    { key: "tool.ffmpeg", path: binaries.ffmpeg, hashContents: false },
    { key: "tool.ffprobe", path: binaries.ffprobe, hashContents: false }
  ];
  if (spec.upscaleBackend === "realesrgan-ncnn-vulkan" && actualAiScale > 1) {
    paths.push({ key: "tool.realesrgan", path: binaries.realesrgan, hashContents: false });
    for (const modelPath of realesrganModelPaths(spec, binaries, actualAiScale)) {
      const extension = modelPath.endsWith(".bin") ? "bin" : "param";
      paths.push({ key: `model.realesrgan.${extension}`, path: modelPath, hashContents: true });
    }
  }
  if (spec.interpolation.mode === "rife" && spec.interpolation.backend === "rife-ncnn-vulkan") {
    paths.push({ key: "tool.rife", path: binaries.rife, hashContents: false });
    const modelDirectory = join4(dirname4(binaries.rife), spec.interpolation.model);
    for (const file of ["flownet.bin", "flownet.param"]) {
      paths.push({ key: `model.rife.${file}`, path: join4(modelDirectory, file), hashContents: true });
    }
  }
  return Object.fromEntries(await Promise.all(paths.map(async (entry) => [
    entry.key,
    await runtimeFileIdentity(entry.path, entry.hashContents)
  ])));
}
function defaultWorkDirectory(outputPath) {
  return join4(dirname4(resolve5(outputPath)), ".ai-video-wallpaper-work");
}
function selectPreviewFrameRange(media, preview = {}, sourceRange = { startFrame: 0, endFrameExclusive: media.video.frameCount }) {
  const sourceFps = media.video.frameRate;
  const requestedCount = Math.max(1, Math.round(preview.frameCount ?? sourceFps * 2));
  const selectedFrameCount = sourceRange.endFrameExclusive - sourceRange.startFrame;
  const frameCount = Math.min(requestedCount, selectedFrameCount);
  const defaultCenter = (sourceRange.startFrame + selectedFrameCount / 2) / sourceFps;
  const requestedCenter = preview.centerSeconds ?? defaultCenter;
  const minimumCenter = sourceRange.startFrame / sourceFps;
  const maximumCenter = sourceRange.endFrameExclusive / sourceFps;
  const center = Math.min(maximumCenter, Math.max(minimumCenter, requestedCenter));
  const startFrame = Math.max(sourceRange.startFrame, Math.min(sourceRange.endFrameExclusive - frameCount, Math.round(center * sourceFps - frameCount / 2)));
  return { startFrame, frameCount };
}
function emit(job, phase, current, total, startedAtMs, message) {
  job.options.onProgress?.(makeProgressEvent({
    jobId: job.jobId,
    phase,
    current,
    total,
    startedAtMs,
    nowMs: job.options.now?.(),
    message
  }));
}
async function requireBinaries(spec, options, cacheDirectory, requireUpscaler, actualAiScale = 1) {
  const found = await resolveBinaryPaths(cacheDirectory, options.binaries);
  const missing = ["ffmpeg", "ffprobe"].filter((name) => !found[name]);
  if (requireUpscaler && spec.upscaleBackend === "realesrgan-ncnn-vulkan" && !found.realesrgan) {
    missing.push("realesrgan");
  }
  const resolvedRealesrgan = found.realesrgan ? { ...found, ffmpeg: found.ffmpeg ?? "", ffprobe: found.ffprobe ?? "", rife: found.rife ?? "" } : null;
  const realesrganModelFiles = requireUpscaler && spec.upscaleBackend === "realesrgan-ncnn-vulkan" && resolvedRealesrgan && await access4(resolvedRealesrgan.realesrgan).then(() => true, () => false) ? realesrganModelPaths(spec, resolvedRealesrgan, actualAiScale) : [];
  const missingRealesrganModelFiles = (await Promise.all(realesrganModelFiles.map(async (path) => ({
    path,
    exists: await access4(path).then(() => true, () => false)
  })))).filter((file) => !file.exists).map((file) => file.path);
  if (missingRealesrganModelFiles.length > 0)
    missing.push("realesrgan-model");
  if (spec.interpolation.mode === "rife" && spec.interpolation.backend === "rife-ncnn-vulkan" && !found.rife) {
    missing.push("rife");
  }
  const rifeModelPath = found.rife && spec.interpolation.backend === "rife-ncnn-vulkan" ? join4(dirname4(found.rife), spec.interpolation.model) : null;
  const missingRifeModelFiles = spec.interpolation.mode === "rife" && spec.interpolation.backend === "rife-ncnn-vulkan" && rifeModelPath ? (await Promise.all(["flownet.bin", "flownet.param"].map(async (file) => ({
    path: join4(rifeModelPath, file),
    exists: await access4(join4(rifeModelPath, file)).then(() => true, () => false)
  })))).filter((file) => !file.exists).map((file) => file.path) : [];
  if (spec.interpolation.mode === "rife" && spec.interpolation.backend === "rife-ncnn-vulkan" && rifeModelPath && missingRifeModelFiles.length > 0) {
    missing.push("rife-model");
  }
  if (missing.length > 0) {
    throw new AppError("E_DEPENDENCY_MISSING", `Required tools are missing: ${missing.join(", ")}`, {
      missing,
      ...missing.includes("rife-model") ? {
        model: spec.interpolation.model,
        expectedPath: rifeModelPath,
        missingFiles: missingRifeModelFiles
      } : {},
      ...missing.includes("realesrgan-model") ? {
        model: spec.model,
        missingFiles: missingRealesrganModelFiles
      } : {}
    });
  }
  return {
    ffmpeg: found.ffmpeg,
    ffprobe: found.ffprobe,
    realesrgan: found.realesrgan ?? "realesrgan-ncnn-vulkan",
    rife: found.rife ?? "rife-ncnn-vulkan"
  };
}
async function prepareJob(spec, options, identity) {
  const cacheDirectory = resolve5(options.cacheDirectory ?? defaultCacheDirectory());
  const workDirectory = resolve5(options.workDirectory ?? defaultWorkDirectory(spec.outputPath));
  const runner = options.runner ?? runCommand;
  let binaries = await requireBinaries(spec, options, cacheDirectory, false);
  const input = identity?.input ?? await fingerprintInput(spec.inputPath);
  const jobId = identity?.jobId ?? createJobId(spec, input);
  const jobDirectory = identity?.jobDirectory ?? join4(workDirectory, "jobs", jobId);
  await mkdir4(jobDirectory, { recursive: true });
  await clearCancellation(jobDirectory);
  const startedAt = options.now?.() ?? Date.now();
  emit({ jobId, options }, "inspect", 0, 1, startedAt, "Inspecting source video");
  const media = await inspectMedia(spec.inputPath, { ffprobePath: binaries.ffprobe, runner, signal: options.signal });
  const sourceRange = spec.sourceRange ?? { startFrame: 0, endFrameExclusive: media.video.frameCount };
  if (sourceRange.startFrame >= media.video.frameCount || sourceRange.endFrameExclusive > media.video.frameCount) {
    throw new AppError("E_INVALID_CONFIG", "sourceRange is outside the source video", {
      sourceRange,
      sourceFrameCount: media.video.frameCount
    });
  }
  if (spec.sourceRange && media.video.frameRateMode !== "constant") {
    throw new AppError("E_UNSUPPORTED_MEDIA", "Frame-accurate source ranges require a confirmed constant-frame-rate video; convert this source to CFR first", { frameRateMode: media.video.frameRateMode, sourceRange });
  }
  const selectedSourceFrameCount = sourceRange.endFrameExclusive - sourceRange.startFrame;
  const sourceFps = spec.sourceFps === "auto" ? media.video.frameRate : spec.sourceFps;
  const fps = sourceFps * spec.interpolation.factor;
  let actualAiScale = 1;
  if (spec.upscaleMode === "realesrgan") {
    try {
      actualAiScale = selectAiScale({ width: media.video.width, height: media.video.height }, spec.target, spec.aspectMode, spec.model, spec.aiScale);
    } catch (error) {
      throw new AppError("E_INVALID_CONFIG", error instanceof Error ? error.message : String(error), void 0, { cause: error });
    }
  }
  if (actualAiScale > 1) {
    binaries = await requireBinaries(spec, options, cacheDirectory, true, actualAiScale);
  }
  const runtimeIdentity = await frameRuntimeIdentity(spec, binaries, actualAiScale);
  const sharedFrameCacheKey = frameCacheKey({
    input,
    sourceFps,
    upscaleMode: spec.upscaleMode,
    model: spec.model,
    actualScale: actualAiScale,
    interpolation: spec.interpolation,
    sourceRange,
    upscaleBackend: spec.upscaleBackend,
    requestedTile: spec.tile,
    sceneDetectorRevision: detectorRevision,
    runtimeIdentity
  });
  const sharedFrameDirectory = join4(workDirectory, "frame-cache", sharedFrameCacheKey);
  const specHash = cacheKey(jobSpecIdentity(spec));
  const existing = await loadJobState(jobDirectory);
  if (existing && (existing.specHash !== specHash || existing.input.size !== input.size || existing.input.modifiedMs !== input.modifiedMs)) {
    throw new AppError("E_JOB_STATE", "Cached task state does not match this input and configuration", { jobId });
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const state = existing ?? {
    schemaVersion: 1,
    jobId,
    specHash,
    input,
    phase: "prepare",
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceFrameCount: selectedSourceFrameCount,
    completedUpscaleFrames: [],
    selectedTile: null,
    completedInterpolationFrames: [],
    detectedSceneCuts: [],
    outputFrameCount: interpolatedOutputFrameCount(selectedSourceFrameCount, spec.loopMode, spec.interpolation.factor),
    outputPath: resolve5(spec.outputPath),
    spec,
    frameCacheKey: sharedFrameCacheKey,
    actualAiScale,
    lastError: null
  };
  if (existing && existing.frameCacheKey !== sharedFrameCacheKey) {
    await clearJobSequenceCaches(jobDirectory);
    state.phase = "prepare";
    state.completedUpscaleFrames = [];
    state.selectedTile = null;
    state.completedInterpolationFrames = [];
    state.detectedSceneCuts = [];
    state.frameRiskAnalysis = void 0;
    state.frameRiskRange = void 0;
    state.spaceBudget = void 0;
    state.verifiedOutput = void 0;
  }
  state.sourceFrameCount = selectedSourceFrameCount;
  state.completedInterpolationFrames ??= [];
  state.detectedSceneCuts ??= [];
  state.outputFrameCount = interpolatedOutputFrameCount(selectedSourceFrameCount, spec.loopMode, spec.interpolation.factor);
  state.spec = spec;
  state.frameCacheKey = sharedFrameCacheKey;
  state.actualAiScale = actualAiScale;
  state.lastError = null;
  await saveJobState(jobDirectory, state);
  emit({ jobId, options }, "inspect", 1, 1, startedAt, "Source video inspected");
  return {
    spec,
    media,
    sourceFps,
    fps,
    jobId,
    jobDirectory,
    workDirectory,
    frameCacheKey: sharedFrameCacheKey,
    actualAiScale,
    sourceRange,
    sourceDirectory: join4(sharedFrameDirectory, "source-frames"),
    interpolatedDirectory: join4(sharedFrameDirectory, "interpolated-frames"),
    enhancedDirectory: join4(sharedFrameDirectory, "enhanced-frames"),
    sequenceDirectory: join4(jobDirectory, "sequence"),
    binaries,
    state,
    resumed: existing !== null,
    preserveCompletedPhase: false,
    runner,
    options
  };
}
async function beginPreparedJobFromSpec(spec, options) {
  assertEncoderResolutionSupported(spec);
  const workDirectory = resolve5(options.workDirectory ?? defaultWorkDirectory(spec.outputPath));
  await runCacheMaintenance(workDirectory, {
    policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
    limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
    now: options.now?.()
  });
  const input = await fingerprintInput(spec.inputPath);
  const jobId = createJobId(spec, input);
  const jobDirectory = join4(workDirectory, "jobs", jobId);
  await mkdir4(jobDirectory, { recursive: true });
  const lock = await acquireJobLock(jobDirectory, jobId);
  try {
    const job = await prepareJob(spec, { ...options, workDirectory }, { input, jobId, jobDirectory });
    await registerFrameCacheUse({
      workDirectory: job.workDirectory,
      frameCacheKey: job.frameCacheKey,
      jobId: job.jobId,
      inputFingerprint: job.state.input,
      now: options.now?.()
    });
    return { job, lock };
  } catch (error) {
    await lock.release();
    throw error;
  }
}
async function beginPreparedJob(rawSpec, options) {
  return await beginPreparedJobFromSpec(parseJobSpec(rawSpec), options);
}
async function finishPreparedJob(active, outcome) {
  const { job, lock } = active;
  await releaseFrameCacheUse({
    workDirectory: job.workDirectory,
    frameCacheKey: job.frameCacheKey,
    jobId: job.jobId,
    inputFingerprint: job.state.input,
    outcome,
    now: job.options.now?.()
  }).catch(() => void 0);
  await lock.release();
}
async function savePhase(job, phase) {
  if (!job.preserveCompletedPhase)
    job.state.phase = phase;
  await saveJobState(job.jobDirectory, job.state);
}
async function countFrames(directory) {
  return await readdir3(directory).then((entries) => entries.filter((entry) => /^frame_\d{8}\.png$/i.test(entry)).length, () => 0);
}
async function selectedFrameSizes(directory, indices, expected) {
  const sizes = [];
  for (const index of indices) {
    const path = join4(directory, frameFileName(index));
    if (!await validatePng(path, expected)) {
      await rm3(path, { force: true }).catch(() => void 0);
      continue;
    }
    const size = await stat5(path).then((info) => info.size, () => null);
    if (size !== null)
      sizes.push(size);
  }
  return sizes;
}
async function clearJobSequenceCaches(jobDirectory) {
  const entries = await readdir3(jobDirectory, { withFileTypes: true }).catch(() => []);
  const sequenceNames = entries.map((entry) => entry.name).filter((name) => name === "sequence" || name.startsWith("preview-sequence-") || name.startsWith("preview-boundary-sequence-"));
  await Promise.all(sequenceNames.map(async (name) => {
    await rm3(join4(jobDirectory, name), { recursive: true, force: true });
  }));
}
async function withFrameCacheWriteLock(job, operation) {
  const lock = await acquireFrameCacheWriteLock({
    workDirectory: job.workDirectory,
    frameCacheKey: job.frameCacheKey,
    jobId: job.jobId,
    signal: job.options.signal,
    assertNotCancelled: async () => await assertNotCancelled(job.jobDirectory, job.options.signal)
  });
  try {
    await assertNotCancelled(job.jobDirectory, job.options.signal);
    return await operation();
  } finally {
    await lock.release();
  }
}
function enhancedDirectoryForTile(job, tile = job.state.selectedTile ?? job.spec.tile) {
  return join4(job.enhancedDirectory, `tile-${tile === 0 ? "auto" : tile}`);
}
async function createSpaceBudget(job, sourceIndices, processingIndices, sequenceDirectory, sequenceFrameCount, outputPath, loopMode) {
  const usesAiUpscale = job.spec.upscaleMode === "realesrgan" && job.actualAiScale > 1;
  const estimate = estimateDiskUsage({
    sourceWidth: job.media.video.width,
    sourceHeight: job.media.video.height,
    targetWidth: job.spec.target.width,
    targetHeight: job.spec.target.height,
    sourceFrameCount: sourceIndices.length,
    loopMode,
    upscaleMode: usesAiUpscale ? "realesrgan" : "lanczos",
    upscaleFactor: job.actualAiScale,
    interpolationFactor: job.spec.interpolation.factor
  });
  const sourceDimensions = { width: job.media.video.width, height: job.media.video.height };
  const enhancedDimensions = {
    width: job.media.video.width * job.actualAiScale,
    height: job.media.video.height * job.actualAiScale
  };
  const sourceSizes = await selectedFrameSizes(job.sourceDirectory, sourceIndices, sourceDimensions);
  const interpolatedSizes = job.spec.interpolation.mode === "rife" ? await selectedFrameSizes(job.interpolatedDirectory, processingIndices, sourceDimensions) : [];
  const enhancedSizes = usesAiUpscale ? await selectedFrameSizes(enhancedDirectoryForTile(job), processingIndices, enhancedDimensions) : [];
  const source = projectFrameStorage(sourceSizes, sourceIndices.length, estimate.sourceFramesBytes);
  const interpolated = job.spec.interpolation.mode === "rife" ? projectFrameStorage(interpolatedSizes, processingIndices.length, estimate.interpolatedFramesBytes) : projectFrameStorage([], 0, 0);
  const enhanced = usesAiUpscale ? projectFrameStorage(enhancedSizes, processingIndices.length, estimate.enhancedFramesBytes) : projectFrameStorage([], 0, 0);
  const existingSequenceFrames = Math.min(sequenceFrameCount, await countFrames(sequenceDirectory));
  const sequenceRemainingBytes = Math.max(0, sequenceFrameCount - existingSequenceFrames) * 4096;
  const batchOverheadBytes = usesAiUpscale && enhanced.frameCount < processingIndices.length ? job.spec.batchSize * 8192 : 0;
  const workRequiredBytes = source.remainingBytes + interpolated.remainingBytes + enhanced.remainingBytes + sequenceRemainingBytes + batchOverheadBytes;
  const outputRequiredBytes = Math.ceil(job.spec.target.width * job.spec.target.height * 1.5 * sequenceFrameCount * 0.18 * 1.15);
  const outputDirectory = dirname4(resolve5(outputPath));
  await Promise.all([
    mkdir4(job.workDirectory, { recursive: true }),
    mkdir4(outputDirectory, { recursive: true })
  ]);
  const sameVolume = await sameFilesystem(job.workDirectory, outputDirectory);
  return {
    workDirectory: job.workDirectory,
    outputDirectory,
    sameVolume,
    source,
    interpolated,
    enhanced,
    sequenceRemainingBytes,
    batchOverheadBytes,
    workRequiredBytes,
    outputRequiredBytes,
    combinedRequiredBytes: workRequiredBytes + outputRequiredBytes
  };
}
async function checkSpaceBudget(job, budget) {
  job.state.spaceBudget = budget;
  await saveJobState(job.jobDirectory, job.state);
  const required = budget.sameVolume ? budget.combinedRequiredBytes : budget.workRequiredBytes;
  emit(job, "prepare", 0, 1, job.options.now?.() ?? Date.now(), `Checking ${required} bytes of remaining space`);
  if (budget.sameVolume) {
    await ensureDiskSpace(budget.workDirectory, budget.combinedRequiredBytes, "combined");
  } else {
    await ensureDiskSpace(budget.workDirectory, budget.workRequiredBytes, "work");
    await ensureDiskSpace(budget.outputDirectory, budget.outputRequiredBytes, "output");
  }
}
async function recordJobError(job, error) {
  job.state.lastError = toAppError(error).toJSON();
  await saveJobState(job.jobDirectory, job.state).catch(() => void 0);
}
async function runFfmpegWithProgress(job, args, phase, totalFrames, message, progress = { offset: 0, overallTotal: totalFrames }) {
  const startedAt = job.options.now?.() ?? Date.now();
  const lines = new LineAccumulator();
  let lastFrame = 0;
  emit(job, phase, progress.offset, progress.overallTotal, startedAt, message);
  const consume = (line) => {
    const match = /^frame=(\d+)$/.exec(line.trim());
    if (!match)
      return;
    const parsed = Number(match[1]);
    if (parsed > lastFrame) {
      lastFrame = parsed;
      emit(job, phase, progress.offset + Math.min(parsed, totalFrames), progress.overallTotal, startedAt, message);
    }
  };
  await job.runner({ executable: job.binaries.ffmpeg, args }, {
    signal: job.options.signal,
    onStdout: (chunk) => lines.push(chunk).forEach(consume)
  });
  const remainder = lines.flush();
  if (remainder)
    consume(remainder);
  emit(job, phase, progress.offset + totalFrames, progress.overallTotal, startedAt, message);
}
async function presentSourceFrameIndices(directory, totalFrames, expected) {
  const entries = await readdir3(directory, { withFileTypes: true }).catch(() => []);
  const present = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (!entry.isFile())
      continue;
    const match = /^frame_(\d{8})\.png$/i.exec(entry.name);
    if (!match)
      continue;
    const index = Number(match[1]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= totalFrames)
      continue;
    const path = join4(directory, entry.name);
    if (await validatePng(path, expected))
      present.add(index);
    else
      await rm3(path, { force: true }).catch(() => void 0);
  }
  return present;
}
function mergeSourceRanges(ranges) {
  const sorted = ranges.filter((range) => range.endFrameExclusive > range.startFrame).map((range) => ({ ...range })).sort((left, right) => left.startFrame - right.startFrame);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.startFrame > previous.endFrameExclusive)
      merged.push(range);
    else
      previous.endFrameExclusive = Math.max(previous.endFrameExclusive, range.endFrameExclusive);
  }
  return merged;
}
function missingRequestedFrameRanges(ranges, present) {
  const missing = [];
  for (const range of mergeSourceRanges(ranges)) {
    let start = null;
    for (let index = range.startFrame; index < range.endFrameExclusive; index += 1) {
      if (!present.has(index) && start === null)
        start = index;
      const closes = start !== null && (present.has(index) || index === range.endFrameExclusive - 1);
      if (!closes)
        continue;
      const endFrame = present.has(index) ? index - 1 : index;
      missing.push({ startFrame: start, endFrame, frameCount: endFrame - start + 1 });
      start = null;
    }
  }
  return missing;
}
async function extractSourceRanges(job, requestedRanges) {
  await assertNotCancelled(job.jobDirectory, job.options.signal);
  await mkdir4(job.sourceDirectory, { recursive: true });
  const totalFrames = job.media.video.frameCount;
  const ranges = mergeSourceRanges(requestedRanges);
  if (ranges.length === 0 || ranges.some((range) => range.startFrame < 0 || range.endFrameExclusive > totalFrames)) {
    throw new AppError("E_INVALID_CONFIG", "Requested source frame range is outside the source video", {
      requestedRanges,
      sourceFrameCount: totalFrames
    });
  }
  const requestedFrameCount = ranges.reduce((sum, range) => sum + range.endFrameExclusive - range.startFrame, 0);
  const expected = { width: job.media.video.width, height: job.media.video.height };
  let present = await presentSourceFrameIndices(job.sourceDirectory, totalFrames, expected);
  const missingRanges = missingRequestedFrameRanges(ranges, present);
  if (missingRanges.length === 0)
    return;
  await savePhase(job, "extract");
  let completed = requestedFrameCount - missingRanges.reduce((sum, range) => sum + range.frameCount, 0);
  for (const range of missingRanges) {
    await assertNotCancelled(job.jobDirectory, job.options.signal);
    await runFfmpegWithProgress(job, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-progress",
      "pipe:1",
      "-nostats",
      "-y",
      "-i",
      job.spec.inputPath,
      "-map",
      "0:v:0",
      "-vf",
      `select=between(n\\,${range.startFrame}\\,${range.endFrame})`,
      "-vsync",
      "0",
      "-start_number",
      String(range.startFrame + 1),
      join4(job.sourceDirectory, "frame_%08d.png")
    ], "extract", range.frameCount, "Extracting missing source frames", {
      offset: completed,
      overallTotal: requestedFrameCount
    });
    completed += range.frameCount;
  }
  present = await presentSourceFrameIndices(job.sourceDirectory, totalFrames, expected);
  const missing = missingRequestedFrameRanges(ranges, present);
  if (missing.length > 0) {
    throw new AppError("E_PROCESS_FAILED", "FFmpeg did not produce the requested source frame range", {
      expected: requestedFrameCount,
      actual: requestedFrameCount - missing.reduce((sum, range) => sum + range.frameCount, 0),
      missing
    });
  }
}
async function detectFrameRisks(job, sourceIndices) {
  if (sourceIndices.length < 2) {
    const analysis2 = analyzeFrameRisks(sourceIndices.map((frame) => ({
      frame,
      ptsTime: frame / job.media.video.frameRate
    })));
    job.state.detectedSceneCuts = [];
    job.state.frameRiskAnalysis = analysis2;
    job.state.frameRiskRange = sourceIndices.length === 0 ? { startFrame: 0, endFrameExclusive: 0 } : { startFrame: sourceIndices[0], endFrameExclusive: sourceIndices[0] + 1 };
    await saveJobState(job.jobDirectory, job.state);
    return { sceneCutsAfter: /* @__PURE__ */ new Set(), holdBoundariesAfter: /* @__PURE__ */ new Set(), analysis: analysis2 };
  }
  const first = sourceIndices[0];
  const last = sourceIndices.at(-1);
  const result = await job.runner({
    executable: job.binaries.ffmpeg,
    args: [
      "-hide_banner",
      "-loglevel",
      "info",
      "-i",
      job.spec.inputPath,
      "-map",
      "0:v:0",
      "-vf",
      `trim=start_frame=${first}:end_frame=${last + 1},signalstats,scdet=threshold=10,blackframe=amount=90:threshold=32,metadata=print`,
      "-frames:v",
      String(sourceIndices.length),
      "-an",
      "-f",
      "framemd5",
      "-"
    ]
  }, {
    signal: job.options.signal,
    maxCaptureBytes: frameRiskCaptureBytes(sourceIndices.length)
  });
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new AppError("E_PROCESS_FAILED", "Frame risk scan output exceeded its bounded capture budget", {
      frameCount: sourceIndices.length,
      maxCaptureBytes: frameRiskCaptureBytes(sourceIndices.length),
      stdoutTruncated: result.stdoutTruncated === true,
      stderrTruncated: result.stderrTruncated === true
    });
  }
  const parsed = parseFfmpegFrameMetadata({
    signalstats: result.stderr,
    scdet: result.stderr,
    blackframe: result.stderr,
    framemd5: result.stdout
  }).map((frame) => ({ ...frame, frame: frame.frame + first }));
  const analysis = analyzeFrameRisks(parsed);
  const detected = new Set(analysis.hardCuts.map((risk) => risk.startFrame));
  const exactHolds = new Set(analysis.exactDuplicateIntervals.flatMap((risk) => risk.holdBoundariesAfter));
  const previous = new Set(job.state.detectedSceneCuts ?? []);
  for (let index = first; index < last; index += 1)
    previous.delete(index);
  for (const index of detected)
    previous.add(index);
  job.state.detectedSceneCuts = [...previous].sort((left, right) => left - right);
  job.state.frameRiskAnalysis = analysis;
  job.state.frameRiskRange = { startFrame: first, endFrameExclusive: last + 1 };
  await saveJobState(job.jobDirectory, job.state);
  return { sceneCutsAfter: detected, holdBoundariesAfter: exactHolds, analysis };
}
async function ensureFrameRiskAnalysis(job) {
  const expectedRange = job.sourceRange;
  const cachedRange = job.state.frameRiskRange;
  const cached = job.state.frameRiskAnalysis;
  if (cached?.detectorRevision === detectorRevision && cached.frameCount === expectedRange.endFrameExclusive - expectedRange.startFrame && cachedRange?.startFrame === expectedRange.startFrame && cachedRange.endFrameExclusive === expectedRange.endFrameExclusive) {
    return {
      sceneCutsAfter: new Set(job.state.detectedSceneCuts ?? []),
      holdBoundariesAfter: new Set(cached.exactDuplicateIntervals.flatMap((risk) => risk.holdBoundariesAfter)),
      analysis: cached
    };
  }
  const sourceIndices = Array.from({ length: expectedRange.endFrameExclusive - expectedRange.startFrame }, (_, offset) => expectedRange.startFrame + offset);
  return await detectFrameRisks(job, sourceIndices);
}
async function publishExactFrame(source, destination, expected) {
  await rm3(destination, { force: true }).catch(() => void 0);
  await linkOrCopy(source, destination);
  if (!await validatePng(destination, expected)) {
    await rm3(destination, { force: true }).catch(() => void 0);
    throw new AppError("E_PROCESS_FAILED", "Could not publish an exact source frame for interpolation");
  }
}
function contiguousChunks(indices, maximumLength) {
  const chunks = [];
  for (const index of indices) {
    const current = chunks.at(-1);
    if (!current || current.length >= maximumLength || index !== current.at(-1) + 1)
      chunks.push([index]);
    else
      current.push(index);
  }
  return chunks;
}
async function interpolateFrames(job, sourceIndices, includeTail) {
  if (job.spec.interpolation.mode === "none")
    return job.sourceDirectory;
  const interpolation = job.spec.interpolation;
  await assertNotCancelled(job.jobDirectory, job.options.signal);
  await savePhase(job, "interpolate");
  await mkdir4(job.interpolatedDirectory, { recursive: true });
  const expected = { width: job.media.video.width, height: job.media.video.height };
  const startedAt = job.options.now?.() ?? Date.now();
  emit(job, "interpolate", 0, Math.max(1, sourceIndices.length * 2 - (includeTail ? 0 : 1)), startedAt, "Detecting scene changes");
  const risks = await ensureFrameRiskAnalysis(job);
  const mapping = interpolationFrameMap(sourceIndices, {
    includeTail,
    sceneCutsAfter: risks.sceneCutsAfter,
    holdBoundariesAfter: risks.holdBoundariesAfter
  });
  const completed = new Set(job.state.completedInterpolationFrames ?? []);
  const missingIntervals = [];
  for (const frame of mapping) {
    const destination = join4(job.interpolatedDirectory, frameFileName(frame.outputIndex));
    if (frame.kind === "source" || frame.kind === "hold") {
      await publishExactFrame(join4(job.sourceDirectory, frameFileName(frame.sourceIndex)), destination, expected);
      completed.add(frame.outputIndex);
    } else if (await validatePng(destination, expected)) {
      completed.add(frame.outputIndex);
    } else {
      completed.delete(frame.outputIndex);
      await rm3(destination, { force: true }).catch(() => void 0);
      missingIntervals.push(frame.sourceIndex);
    }
  }
  job.state.completedInterpolationFrames = [...completed].sort((left, right) => left - right);
  await saveJobState(job.jobDirectory, job.state);
  let completedForRequest = mapping.filter((frame) => completed.has(frame.outputIndex)).length;
  emit(job, "interpolate", completedForRequest, mapping.length, startedAt, "Interpolating frames with RIFE");
  for (const chunk of contiguousChunks(missingIntervals, 64)) {
    await assertNotCancelled(job.jobDirectory, job.options.signal);
    const first = chunk[0];
    const last = chunk.at(-1);
    const blockDirectory = join4(job.jobDirectory, "rife-batches", `${String(first + 1).padStart(8, "0")}-${String(last + 2).padStart(8, "0")}`);
    const inputDirectory = join4(blockDirectory, "input");
    const outputDirectory = join4(blockDirectory, "output");
    await rm3(blockDirectory, { recursive: true, force: true });
    await Promise.all([mkdir4(inputDirectory, { recursive: true }), mkdir4(outputDirectory, { recursive: true })]);
    try {
      for (let sourceIndex = first; sourceIndex <= last + 1; sourceIndex += 1) {
        await linkOrCopy(join4(job.sourceDirectory, frameFileName(sourceIndex)), join4(inputDirectory, frameFileName(sourceIndex - first)));
      }
      const inputFrameCount = last - first + 2;
      await job.runner({
        executable: job.binaries.rife,
        args: rifeDirectoryArguments({
          inputDirectory,
          outputDirectory,
          inputFrameCount,
          interpolation,
          source: expected,
          gpuId: job.spec.gpuId
        }),
        cwd: dirname4(job.binaries.rife)
      }, { signal: job.options.signal });
      const outputs = (await readdir3(outputDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^\d{8}\.png$/i.test(entry.name)).map((entry) => entry.name).sort();
      if (outputs.length !== inputFrameCount * 2) {
        throw new AppError("E_PROCESS_FAILED", "RIFE produced an unexpected frame count", {
          expected: inputFrameCount * 2,
          actual: outputs.length
        });
      }
      for (const name of outputs) {
        if (!await validatePng(join4(outputDirectory, name), expected)) {
          throw new AppError("E_PROCESS_FAILED", "RIFE produced a missing or invalid PNG frame", { name });
        }
      }
      for (const sourceIndex of chunk) {
        const localOutput = outputs[(sourceIndex - first) * 2 + 1];
        const destination = join4(job.interpolatedDirectory, frameFileName(sourceIndex * 2 + 1));
        await rm3(destination, { force: true }).catch(() => void 0);
        await rename3(join4(outputDirectory, localOutput), destination);
        if (!await validatePng(destination, expected)) {
          await rm3(destination, { force: true }).catch(() => void 0);
          throw new AppError("E_PROCESS_FAILED", "Published RIFE frame failed validation", { sourceIndex });
        }
        completed.add(sourceIndex * 2 + 1);
      }
      completedForRequest += chunk.length;
      job.state.completedInterpolationFrames = [...completed].sort((left, right) => left - right);
      await saveJobState(job.jobDirectory, job.state);
      emit(job, "interpolate", completedForRequest, mapping.length, startedAt, "Interpolating frames with RIFE");
    } finally {
      await rm3(blockDirectory, { recursive: true, force: true }).catch(() => void 0);
    }
  }
  for (const frame of mapping) {
    if (!await validatePng(join4(job.interpolatedDirectory, frameFileName(frame.outputIndex)), expected)) {
      throw new AppError("E_PROCESS_FAILED", "RIFE cache is incomplete after interpolation", { outputIndex: frame.outputIndex });
    }
  }
  emit(job, "interpolate", mapping.length, mapping.length, startedAt, "RIFE interpolation complete");
  return job.interpolatedDirectory;
}
function isGpuMemoryError(error) {
  const text = error instanceof AppError ? `${error.message} ${JSON.stringify(error.details)}` : error instanceof Error ? error.message : String(error);
  return /out of (device )?memory|vk_error_out_of_device_memory|vkallocatememory|failed to allocate|insufficient.*memory/i.test(text);
}
function realesrganArguments(job, inputDirectory, outputDirectory, tile) {
  return [
    "-i",
    inputDirectory,
    "-o",
    outputDirectory,
    "-n",
    job.spec.model,
    "-s",
    String(job.actualAiScale),
    "-t",
    String(tile),
    "-j",
    "1:2:2",
    "-f",
    "png",
    "-v",
    ...job.spec.gpuId === "auto" ? [] : ["-g", String(job.spec.gpuId)]
  ];
}
async function selectUpscaleTile(job, indices, inputFrameDirectory, expected, startedAt) {
  if (job.state.selectedTile !== null)
    return job.state.selectedTile;
  const representative = indices[Math.floor(indices.length / 2)];
  if (representative === void 0) {
    throw new AppError("E_PROCESS_FAILED", "Cannot select a Real-ESRGAN tile without a representative frame");
  }
  const probeRoot = join4(job.jobDirectory, "tile-probe");
  const probeName = frameFileName(representative);
  await rm3(probeRoot, { recursive: true, force: true });
  try {
    const tiles = tileFallbackOrder(job.spec.tile);
    for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
      const tile = tiles[tileIndex];
      if (tile === void 0)
        continue;
      await assertNotCancelled(job.jobDirectory, job.options.signal);
      const probeDirectory = join4(probeRoot, `tile-${tile}`);
      const inputDirectory = join4(probeDirectory, "input");
      const outputDirectory = join4(probeDirectory, "output");
      await Promise.all([mkdir4(inputDirectory, { recursive: true }), mkdir4(outputDirectory, { recursive: true })]);
      await linkOrCopy(join4(inputFrameDirectory, probeName), join4(inputDirectory, probeName));
      emit(job, "upscale", 0, indices.length, startedAt, `Testing representative frame with tile ${tile}`);
      try {
        await job.runner({
          executable: job.binaries.realesrgan,
          args: realesrganArguments(job, inputDirectory, outputDirectory, tile),
          cwd: dirname4(job.binaries.realesrgan)
        }, { signal: job.options.signal });
      } catch (error) {
        await rm3(enhancedDirectoryForTile(job, tile), { recursive: true, force: true }).catch(() => void 0);
        if (!isGpuMemoryError(error) || tileIndex === tiles.length - 1)
          throw error;
        continue;
      }
      if (!await validatePng(join4(outputDirectory, probeName), expected)) {
        throw new AppError("E_PROCESS_FAILED", "Real-ESRGAN tile probe produced a missing or invalid PNG frame", {
          representative,
          tile
        });
      }
      await clearJobSequenceCaches(job.jobDirectory);
      job.state.selectedTile = tile;
      job.state.completedUpscaleFrames = [];
      await saveJobState(job.jobDirectory, job.state);
      return tile;
    }
  } finally {
    await rm3(probeRoot, { recursive: true, force: true }).catch(() => void 0);
  }
  throw new AppError("E_PROCESS_FAILED", "Real-ESRGAN could not select a supported tile size");
}
async function upscaleFrames(job, indices, inputFrameDirectory) {
  if (job.spec.upscaleMode === "lanczos" || job.actualAiScale === 1)
    return inputFrameDirectory;
  await savePhase(job, "upscale");
  const expected = {
    width: job.media.video.width * job.actualAiScale,
    height: job.media.video.height * job.actualAiScale
  };
  const startedAt = job.options.now?.() ?? Date.now();
  const selectedTile = await selectUpscaleTile(job, indices, inputFrameDirectory, expected, startedAt);
  const tiles = tileFallbackOrder(selectedTile);
  for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
    const tile = tiles[tileIndex];
    if (tile === void 0)
      continue;
    const enhancedDirectory = enhancedDirectoryForTile(job, tile);
    await mkdir4(enhancedDirectory, { recursive: true });
    if (job.state.selectedTile !== tile) {
      await clearJobSequenceCaches(job.jobDirectory);
      job.state.selectedTile = tile;
      job.state.completedUpscaleFrames = [];
      await saveJobState(job.jobDirectory, job.state);
    }
    const completed = /* @__PURE__ */ new Set();
    const missing = [];
    for (const index of indices) {
      const output = join4(enhancedDirectory, frameFileName(index));
      if (await validatePng(output, expected)) {
        completed.add(index);
      } else {
        await rm3(output, { force: true }).catch(() => void 0);
        missing.push(index);
      }
    }
    job.state.completedUpscaleFrames = [...completed].sort((left, right) => left - right);
    await saveJobState(job.jobDirectory, job.state);
    emit(job, "upscale", completed.size, indices.length, startedAt, `Upscaling frames with tile ${tile}`);
    let retryWithSmallerTile = false;
    for (let offset = 0; offset < missing.length; offset += job.spec.batchSize) {
      await assertNotCancelled(job.jobDirectory, job.options.signal);
      const block = missing.slice(offset, offset + job.spec.batchSize);
      const first = block[0];
      const last = block.at(-1);
      if (first === void 0 || last === void 0)
        continue;
      const blockDirectory = join4(job.jobDirectory, "batches", `${String(first + 1).padStart(8, "0")}-${String(last + 1).padStart(8, "0")}`);
      const inputDirectory = join4(blockDirectory, "input");
      const outputDirectory = join4(blockDirectory, "output");
      await rm3(blockDirectory, { recursive: true, force: true });
      await Promise.all([mkdir4(inputDirectory, { recursive: true }), mkdir4(outputDirectory, { recursive: true })]);
      try {
        for (const index of block) {
          await linkOrCopy(join4(inputFrameDirectory, frameFileName(index)), join4(inputDirectory, frameFileName(index)));
        }
        try {
          await job.runner({
            executable: job.binaries.realesrgan,
            args: realesrganArguments(job, inputDirectory, outputDirectory, tile),
            cwd: dirname4(job.binaries.realesrgan)
          }, { signal: job.options.signal });
        } catch (error) {
          if (!isGpuMemoryError(error) || tileIndex === tiles.length - 1)
            throw error;
          retryWithSmallerTile = true;
          await clearJobSequenceCaches(job.jobDirectory);
          await rm3(enhancedDirectory, { recursive: true, force: true }).catch(() => void 0);
          job.state.completedUpscaleFrames = [];
          job.state.selectedTile = tiles[tileIndex + 1] ?? null;
          await saveJobState(job.jobDirectory, job.state);
          emit(job, "upscale", 0, indices.length, startedAt, "GPU memory limit reached; rebuilding all frames with a smaller tile");
          break;
        }
        const invalid = [];
        for (const index of block) {
          if (!await validatePng(join4(outputDirectory, frameFileName(index)), expected))
            invalid.push(index);
        }
        if (invalid.length > 0) {
          throw new AppError("E_PROCESS_FAILED", "Real-ESRGAN batch produced missing or invalid PNG frames", { invalid });
        }
        for (const index of block) {
          const staged = join4(outputDirectory, frameFileName(index));
          const published = join4(enhancedDirectory, frameFileName(index));
          await rm3(published, { force: true }).catch(() => void 0);
          await rename3(staged, published);
          completed.add(index);
        }
        job.state.completedUpscaleFrames = [...completed].sort((left, right) => left - right);
        await saveJobState(job.jobDirectory, job.state);
        emit(job, "upscale", completed.size, indices.length, startedAt, `Upscaling frames with tile ${tile}`);
      } finally {
        await rm3(blockDirectory, { recursive: true, force: true }).catch(() => void 0);
      }
      if (retryWithSmallerTile)
        break;
    }
    if (retryWithSmallerTile)
      continue;
    return enhancedDirectory;
  }
  throw new AppError("E_PROCESS_FAILED", "Real-ESRGAN could not complete with any supported tile size");
}
async function sequenceFrames(job, sourceDirectory, indices, destination = job.sequenceDirectory) {
  await assertNotCancelled(job.jobDirectory, job.options.signal);
  await savePhase(job, "sequence");
  const startedAt = job.options.now?.() ?? Date.now();
  emit(job, "sequence", 0, indices.length, startedAt, "Building output sequence");
  await buildFrameSequence(sourceDirectory, destination, indices, (current, total) => {
    emit(job, "sequence", current, total, startedAt, "Building output sequence");
  });
}
function temporaryOutputPath(outputPath, jobId) {
  const extension = extname(outputPath) || ".mp4";
  const base = outputPath.slice(0, outputPath.length - extname(outputPath).length);
  return `${base}.${jobId}.partial${extension}`;
}
function encodeArguments(job, sequenceDirectory, frameCount, outputPath) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
    "-nostats",
    "-y",
    "-framerate",
    String(job.fps),
    "-start_number",
    "1",
    "-i",
    join4(sequenceDirectory, "frame_%08d.png"),
    "-frames:v",
    String(frameCount),
    "-vf",
    buildFfmpegVideoFilter(job.spec.aspectMode, job.spec.target, job.spec.focus),
    ...videoEncoderArguments(job.spec.encoding),
    "-pix_fmt",
    job.spec.encoding.pixelFormat,
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-r",
    String(job.fps),
    "-an",
    "-movflags",
    "+faststart",
    outputPath
  ];
}
async function encode(job, sequenceDirectory, frameCount, outputPath) {
  await assertNotCancelled(job.jobDirectory, job.options.signal);
  await mkdir4(dirname4(outputPath), { recursive: true });
  await savePhase(job, "encode");
  await runFfmpegWithProgress(job, encodeArguments(job, sequenceDirectory, frameCount, outputPath), "encode", frameCount, "Encoding H.264 wallpaper");
}
function expectedOutput(job, frameCount) {
  return {
    width: job.spec.target.width,
    height: job.spec.target.height,
    sampleAspectRatio: "1:1",
    frameRate: job.fps,
    frameRateTolerance: 0.01,
    frameCount,
    durationSeconds: durationForFrames(frameCount, job.fps),
    durationToleranceSeconds: Math.max(0.05, 1 / job.fps),
    codec: "h264",
    pixelFormat: "yuv420p",
    colorSpace: "bt709",
    colorPrimaries: "bt709",
    colorTransfer: "bt709",
    colorRange: "tv",
    audio: "none"
  };
}
async function verifyEncodedOutput(job, inputPath, frameCount, referenceSourceRanges) {
  await assertNotCancelled(job.jobDirectory, job.options.signal);
  await savePhase(job, "verify");
  const startedAt = job.options.now?.() ?? Date.now();
  emit(job, "verify", 0, 1, startedAt, "Verifying encoded wallpaper");
  const verification = await verifyMedia(inputPath, expectedOutput(job, frameCount), {
    ffmpegPath: job.binaries.ffmpeg,
    ffprobePath: job.binaries.ffprobe,
    runner: job.runner,
    signal: job.options.signal,
    throwOnFailure: true,
    fullDecode: {
      reference: {
        inputPath: job.spec.inputPath,
        media: job.media,
        ...referenceSourceRanges ? { sourceRanges: referenceSourceRanges } : { sourceRange: job.sourceRange }
      }
    }
  });
  emit(job, "verify", 1, 1, startedAt, "Encoded wallpaper verified");
  return verification;
}
async function sha256File(path) {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash2("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
async function matchesVerifiedOutput(outputPath, marker, frameCount) {
  if (!marker || resolve5(marker.outputPath) !== outputPath || marker.frameCount !== frameCount || !/^[a-f0-9]{64}$/.test(marker.sha256))
    return false;
  const info = await stat5(outputPath).catch(() => null);
  if (!info?.isFile() || info.size !== marker.size || Math.round(info.mtimeMs) !== marker.modifiedMs)
    return false;
  return await sha256File(outputPath).then((hash) => hash === marker.sha256, () => false);
}
async function processVideo(rawSpec, options = {}) {
  const active = await beginPreparedJob(rawSpec, options);
  const { job } = active;
  const outputPath = resolve5(job.spec.outputPath);
  const partialOutput = temporaryOutputPath(outputPath, job.jobId);
  let outcome = "recoverable";
  let result = null;
  try {
    if (resolve5(job.spec.inputPath).toLowerCase() === outputPath.toLowerCase()) {
      throw new AppError("E_INVALID_CONFIG", "Input and output paths must be different");
    }
    const selectedSourceFrameCount = job.sourceRange.endFrameExclusive - job.sourceRange.startFrame;
    const sourceIndices = Array.from({ length: selectedSourceFrameCount }, (_, offset) => job.sourceRange.startFrame + offset);
    const forwardFrameCount = interpolatedForwardFrameCount(selectedSourceFrameCount, job.spec.interpolation.factor);
    const processingStartFrame = job.spec.interpolation.mode === "rife" ? job.sourceRange.startFrame * 2 : job.sourceRange.startFrame;
    const processingFrameCount = job.spec.interpolation.mode === "rife" && job.spec.loopMode === "none" ? selectedSourceFrameCount * 2 : forwardFrameCount;
    const processingIndices = Array.from({ length: processingFrameCount }, (_, offset) => processingStartFrame + offset);
    const singleFrameRifePingPong = job.spec.interpolation.mode === "rife" && job.spec.loopMode === "pingpong" && selectedSourceFrameCount === 1;
    const sequenceIndices = job.spec.loopMode === "pingpong" ? singleFrameRifePingPong ? [processingStartFrame, processingStartFrame] : pingPongIndices(forwardFrameCount).map((index) => processingStartFrame + index) : processingIndices;
    const existingOutput = await access4(outputPath).then(() => true, () => false);
    if (existingOutput) {
      const recoverablePublish = job.resumed && job.state.phase !== "complete" && await matchesVerifiedOutput(outputPath, job.state.verifiedOutput, sequenceIndices.length);
      if (!job.resumed || job.state.phase !== "complete" && !recoverablePublish) {
        throw new AppError("E_OUTPUT_EXISTS", `Output file already exists: ${outputPath}`);
      }
      const verification = await verifyEncodedOutput(job, outputPath, sequenceIndices.length);
      job.state.phase = "complete";
      job.state.outputPath = outputPath;
      job.state.outputFrameCount = sequenceIndices.length;
      job.state.lastError = null;
      await saveJobState(job.jobDirectory, job.state);
      await rm3(job.sequenceDirectory, { recursive: true, force: true });
      result = {
        jobId: job.jobId,
        outputPath,
        media: verification.media,
        verification,
        resumed: true,
        workDirectory: job.workDirectory,
        frameCacheKey: job.frameCacheKey,
        actualAiScale: job.actualAiScale,
        sourceRange: { ...job.sourceRange },
        sourceFrameCount: selectedSourceFrameCount,
        ...job.state.frameRiskAnalysis ? { frameRiskAnalysis: job.state.frameRiskAnalysis } : {}
      };
    } else {
      await withFrameCacheWriteLock(job, async () => {
        const budget = await createSpaceBudget(job, sourceIndices, processingIndices, job.sequenceDirectory, sequenceIndices.length, outputPath, job.spec.loopMode);
        await checkSpaceBudget(job, budget);
        await extractSourceRanges(job, [job.sourceRange]);
        const interpolatedDirectory = await interpolateFrames(job, sourceIndices, job.spec.interpolation.mode === "rife" && job.spec.loopMode === "none");
        const frameDirectory = await upscaleFrames(job, processingIndices, interpolatedDirectory);
        await sequenceFrames(job, frameDirectory, sequenceIndices);
      });
      job.state.verifiedOutput = void 0;
      await encode(job, job.sequenceDirectory, sequenceIndices.length, partialOutput);
      const verification = await verifyEncodedOutput(job, partialOutput, sequenceIndices.length);
      await assertNotCancelled(job.jobDirectory, job.options.signal);
      const verifiedSha256 = await sha256File(partialOutput);
      const verifiedInfo = await stat5(partialOutput);
      job.state.outputPath = outputPath;
      job.state.outputFrameCount = sequenceIndices.length;
      job.state.lastError = null;
      job.state.verifiedOutput = {
        outputPath,
        size: verifiedInfo.size,
        modifiedMs: Math.round(verifiedInfo.mtimeMs),
        frameCount: sequenceIndices.length,
        sha256: verifiedSha256
      };
      await saveJobState(job.jobDirectory, job.state);
      await assertNotCancelled(job.jobDirectory, job.options.signal);
      await rename3(partialOutput, outputPath);
      verification.media.path = outputPath;
      await savePhase(job, "complete");
      await rm3(job.sequenceDirectory, { recursive: true, force: true });
      emit(job, "complete", 1, 1, options.now?.() ?? Date.now(), "Wallpaper video complete");
      result = {
        jobId: job.jobId,
        outputPath,
        media: verification.media,
        verification,
        resumed: job.resumed,
        workDirectory: job.workDirectory,
        frameCacheKey: job.frameCacheKey,
        actualAiScale: job.actualAiScale,
        sourceRange: { ...job.sourceRange },
        sourceFrameCount: selectedSourceFrameCount,
        ...job.state.frameRiskAnalysis ? { frameRiskAnalysis: job.state.frameRiskAnalysis } : {}
      };
    }
    outcome = "complete";
  } catch (error) {
    await rm3(partialOutput, { force: true }).catch(() => void 0);
    await recordJobError(job, error);
    throw error;
  } finally {
    await finishPreparedJob(active, outcome);
  }
  if (!result)
    throw new AppError("E_JOB_STATE", "Completed process did not produce a result");
  result.cacheMaintenance = await runCacheMaintenance(job.workDirectory, {
    policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
    limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
    now: options.now?.()
  }).catch((error) => ({
    workDirectory: job.workDirectory,
    cacheDirectory: join4(job.workDirectory, "frame-cache"),
    policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
    limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
    totalBytes: 0,
    releasedBytes: 0,
    remainingBytes: 0,
    removedKeys: [],
    legacyCount: 0,
    entries: [],
    errors: [error instanceof Error ? error.message : String(error)]
  }));
  return result;
}
function previewOutputPath(spec, override) {
  if (override)
    return resolve5(override);
  const extension = extname(spec.outputPath) || ".mp4";
  const base = spec.outputPath.slice(0, spec.outputPath.length - extname(spec.outputPath).length);
  return resolve5(`${base}.preview${extension}`);
}
function normalizedPreviewMode(job, preview) {
  const previewMode = preview.previewMode ?? "segment";
  if (previewMode !== "segment" && previewMode !== "loop-boundary") {
    throw new AppError("E_INVALID_ARGUMENT", `Unsupported preview mode: ${String(previewMode)}`);
  }
  if (preview.frameCount !== void 0 && (!Number.isInteger(preview.frameCount) || preview.frameCount < 1)) {
    throw new AppError("E_INVALID_ARGUMENT", "Preview frameCount must be a positive integer");
  }
  if (previewMode === "segment") {
    if (preview.turn !== void 0) {
      throw new AppError("E_INVALID_ARGUMENT", "turn is only valid for a ping-pong loop-boundary preview");
    }
    return { previewMode };
  }
  if (preview.centerSeconds !== void 0) {
    throw new AppError("E_INVALID_ARGUMENT", "centerSeconds cannot be used with a loop-boundary preview");
  }
  if (job.spec.loopMode === "none") {
    if (preview.turn !== void 0) {
      throw new AppError("E_INVALID_ARGUMENT", "turn is not valid for a direct loop seam");
    }
    return { previewMode };
  }
  const turn = preview.turn ?? "end";
  if (turn !== "start" && turn !== "end") {
    throw new AppError("E_INVALID_ARGUMENT", `Unsupported ping-pong turn: ${String(turn)}`);
  }
  return { previewMode, turn };
}
function sourceRangesForProcessingIndices(job, processingIndices) {
  const sourceIndices = /* @__PURE__ */ new Set();
  for (const processingIndex of processingIndices) {
    if (job.spec.interpolation.mode === "none") {
      sourceIndices.add(processingIndex);
      continue;
    }
    const sourceIndex = Math.floor(processingIndex / 2);
    sourceIndices.add(sourceIndex);
    if (processingIndex % 2 === 1 && sourceIndex + 1 < job.sourceRange.endFrameExclusive) {
      sourceIndices.add(sourceIndex + 1);
    }
  }
  return mergeSourceRanges([...sourceIndices].sort((left, right) => left - right).map((index) => ({ startFrame: index, endFrameExclusive: index + 1 })));
}
function periodicWindow(cycle, frameCount, anchorCycleIndex, anchorOutputFrame) {
  if (cycle.length === 0)
    throw new AppError("E_JOB_STATE", "Loop preview cycle cannot be empty");
  return Array.from({ length: frameCount }, (_, outputFrame) => {
    const relative = anchorCycleIndex + outputFrame - anchorOutputFrame;
    const cycleIndex = (relative % cycle.length + cycle.length) % cycle.length;
    return cycle[cycleIndex];
  });
}
function createPreviewFramePlan(job, preview) {
  const mode = normalizedPreviewMode(job, preview);
  const factor = job.spec.interpolation.factor;
  if (mode.previewMode === "segment") {
    const { startFrame, frameCount } = selectPreviewFrameRange(job.media, preview, job.sourceRange);
    const processingStart2 = job.spec.interpolation.mode === "rife" ? startFrame * 2 : startFrame;
    const processingFrameCount = frameCount * factor;
    const processingIndices2 = Array.from({ length: processingFrameCount }, (_, offset) => processingStart2 + offset);
    return {
      previewMode: mode.previewMode,
      startFrame,
      sourceFrameCount: frameCount,
      sourceRanges: sourceRangesForProcessingIndices(job, processingIndices2),
      processingIndices: processingIndices2,
      sequenceIndices: processingIndices2
    };
  }
  const selectedSourceFrameCount = job.sourceRange.endFrameExclusive - job.sourceRange.startFrame;
  const requestedSourceFrames = Math.max(1, Math.round(preview.frameCount ?? job.media.video.frameRate * 2));
  const outputFrameCount2 = requestedSourceFrames * factor;
  const processingStart = job.spec.interpolation.mode === "rife" ? job.sourceRange.startFrame * 2 : job.sourceRange.startFrame;
  const forwardFrameCount = interpolatedForwardFrameCount(selectedSourceFrameCount, factor);
  let cycle;
  let anchorCycleIndex;
  let boundaryType;
  if (selectedSourceFrameCount === 1) {
    cycle = [processingStart];
    anchorCycleIndex = 0;
    boundaryType = job.spec.loopMode === "pingpong" ? mode.turn === "start" ? "pingpong-start" : "pingpong-end" : "direct-seam";
  } else if (job.spec.loopMode === "pingpong") {
    cycle = pingPongIndices(forwardFrameCount).map((index) => processingStart + index);
    anchorCycleIndex = mode.turn === "start" ? 0 : forwardFrameCount - 1;
    boundaryType = mode.turn === "start" ? "pingpong-start" : "pingpong-end";
  } else {
    const directFrameCount = factor === 2 ? selectedSourceFrameCount * 2 : selectedSourceFrameCount;
    cycle = Array.from({ length: directFrameCount }, (_, offset) => processingStart + offset);
    anchorCycleIndex = 0;
    boundaryType = "direct-seam";
  }
  const boundaryOutputFrame = Math.floor(outputFrameCount2 / 2);
  const sequenceIndices = periodicWindow(cycle, outputFrameCount2, anchorCycleIndex, boundaryOutputFrame);
  const processingIndices = [...new Set(sequenceIndices)].sort((left, right) => left - right);
  const sourceRanges = sourceRangesForProcessingIndices(job, processingIndices);
  return {
    previewMode: mode.previewMode,
    ...mode.turn ? { turn: mode.turn } : {},
    startFrame: sourceRanges[0]?.startFrame ?? job.sourceRange.startFrame,
    sourceFrameCount: sourceRanges.reduce((sum, range) => sum + range.endFrameExclusive - range.startFrame, 0),
    sourceRanges,
    processingIndices,
    sequenceIndices,
    boundary: { type: boundaryType, outputFrame: boundaryOutputFrame }
  };
}
async function interpolatePreviewFrames(job, plan) {
  if (job.spec.interpolation.mode === "none")
    return job.sourceDirectory;
  const requested = new Set(plan.processingIndices);
  for (const range of plan.sourceRanges) {
    const sourceIndices = Array.from({ length: range.endFrameExclusive - range.startFrame }, (_, offset) => range.startFrame + offset);
    const lastSourceFrame = range.endFrameExclusive - 1;
    const includeTail = lastSourceFrame === job.sourceRange.endFrameExclusive - 1 && requested.has(lastSourceFrame * 2 + 1);
    await interpolateFrames(job, sourceIndices, includeTail);
  }
  return job.interpolatedDirectory;
}
async function previewNormalizedVideo(spec, preview = {}, options = {}, internal = {}) {
  const active = await beginPreparedJobFromSpec(spec, options);
  const { job } = active;
  job.preserveCompletedPhase = job.state.phase === "complete";
  let partialOutput = null;
  try {
    const mode = normalizedPreviewMode(job, preview);
    let selectedRiskPreview;
    if (internal.autoLocateRisk) {
      const risks = await ensureFrameRiskAnalysis(job);
      if (mode.previewMode === "segment" && preview.centerSeconds === void 0) {
        selectedRiskPreview = selectDiagnosticRiskPreview(risks.analysis);
      }
    }
    const effectivePreview = selectedRiskPreview ? { ...preview, centerSeconds: selectedRiskPreview.ptsTime ?? selectedRiskPreview.frame / job.sourceFps } : preview;
    const plan = createPreviewFramePlan(job, effectivePreview);
    const previewSequence = plan.previewMode === "segment" ? join4(job.jobDirectory, `preview-sequence-${plan.startFrame}-${plan.sequenceIndices.length}`) : join4(job.jobDirectory, `preview-boundary-sequence-${cacheKey({
      previewMode: plan.previewMode,
      turn: plan.turn,
      sequenceIndices: plan.sequenceIndices
    }).slice(0, 16)}`);
    const outputPath = previewOutputPath(job.spec, preview.outputPath);
    partialOutput = temporaryOutputPath(outputPath, job.jobId);
    if (await access4(outputPath).then(() => true, () => false)) {
      throw new AppError("E_OUTPUT_EXISTS", `Preview file already exists: ${outputPath}`);
    }
    await withFrameCacheWriteLock(job, async () => {
      const budget = await createSpaceBudget(job, plan.sourceRanges.flatMap((range) => Array.from({ length: range.endFrameExclusive - range.startFrame }, (_, offset) => range.startFrame + offset)), plan.processingIndices, previewSequence, plan.sequenceIndices.length, outputPath, "none");
      await checkSpaceBudget(job, budget);
      await extractSourceRanges(job, plan.sourceRanges);
      const interpolatedDirectory = await interpolatePreviewFrames(job, plan);
      const frameDirectory = await upscaleFrames(job, plan.processingIndices, interpolatedDirectory);
      await sequenceFrames(job, frameDirectory, plan.sequenceIndices, previewSequence);
    });
    await encode(job, previewSequence, plan.sequenceIndices.length, partialOutput);
    const verification = await verifyEncodedOutput(job, partialOutput, plan.sequenceIndices.length, plan.sourceRanges);
    await assertNotCancelled(job.jobDirectory, job.options.signal);
    await rename3(partialOutput, outputPath);
    verification.media.path = outputPath;
    job.state.lastError = null;
    await saveJobState(job.jobDirectory, job.state);
    await rm3(previewSequence, { recursive: true, force: true });
    return {
      jobId: job.jobId,
      outputPath,
      startFrame: plan.startFrame,
      frameCount: plan.sequenceIndices.length,
      sourceFrameCount: plan.sourceFrameCount,
      media: verification.media,
      verification,
      workDirectory: job.workDirectory,
      frameCacheKey: job.frameCacheKey,
      actualAiScale: job.actualAiScale,
      previewMode: plan.previewMode,
      ...plan.turn ? { turn: plan.turn } : {},
      sourceRanges: plan.sourceRanges.map((range) => ({ ...range })),
      ...plan.boundary ? { boundary: { ...plan.boundary } } : {},
      ...job.state.frameRiskAnalysis ? { frameRiskAnalysis: job.state.frameRiskAnalysis } : {},
      ...selectedRiskPreview ? { selectedRiskPreview } : {}
    };
  } catch (error) {
    if (partialOutput)
      await rm3(partialOutput, { force: true }).catch(() => void 0);
    await recordJobError(job, error);
    throw error;
  } finally {
    await finishPreparedJob(active, "recoverable");
    await runCacheMaintenance(job.workDirectory, {
      policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
      limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
      now: options.now?.()
    }).catch(() => void 0);
  }
}
async function previewVideo(rawSpec, preview = {}, options = {}) {
  return await previewNormalizedVideo(parseJobSpec(rawSpec), preview, options);
}
async function diagnosticPreviewVideo(rawSpec, preview, options = {}) {
  const base = parseJobSpec(rawSpec);
  const outputDirectory = resolve5(preview.outputDirectory);
  await mkdir4(outputDirectory, { recursive: true });
  const none = {
    mode: "none",
    factor: 1,
    model: "rife-v4.6",
    memoryMode: "auto",
    sceneCutMode: "hold",
    backend: "rife-ncnn-vulkan"
  };
  const rife = { ...none, mode: "rife", factor: 2 };
  const variants = [
    {
      id: "A",
      label: "Lanczos",
      description: "\u65E0 RIFE\uFF0C\u4EC5 Lanczos",
      spec: { ...base, upscaleMode: "lanczos", upscaleBackend: "lanczos", aiScale: "auto", interpolation: none }
    },
    {
      id: "B",
      label: "AI 2x",
      description: "\u65E0 RIFE\uFF0CAI 2x + Lanczos",
      spec: { ...base, upscaleMode: "realesrgan", upscaleBackend: "realesrgan-ncnn-vulkan", model: "realesr-animevideov3", aiScale: 2, interpolation: none }
    },
    {
      id: "C",
      label: "AI 3x",
      description: "\u65E0 RIFE\uFF0CAI 3x + \u7F29\u5C0F",
      spec: { ...base, upscaleMode: "realesrgan", upscaleBackend: "realesrgan-ncnn-vulkan", model: "realesr-animevideov3", aiScale: 3, interpolation: none }
    },
    {
      id: "D",
      label: "RIFE + AI 2x",
      description: "RIFE 2x\uFF0CAI 2x + Lanczos",
      spec: { ...base, upscaleMode: "realesrgan", upscaleBackend: "realesrgan-ncnn-vulkan", model: "realesr-animevideov3", aiScale: 2, interpolation: rife }
    }
  ];
  const started = options.now?.() ?? Date.now();
  const results = [];
  let sourceFrameCount = 0;
  let previewMode = preview.previewMode ?? "segment";
  let turn;
  let sourceRanges = [];
  let boundary;
  let frameRiskAnalysis;
  let selectedRiskPreview;
  let resolvedCenterSeconds = preview.centerSeconds;
  for (const variant of variants) {
    const variantStarted = options.now?.() ?? Date.now();
    const result = await previewNormalizedVideo(variant.spec, {
      centerSeconds: resolvedCenterSeconds,
      frameCount: preview.frameCount,
      previewMode: preview.previewMode,
      turn: preview.turn,
      outputPath: join4(outputDirectory, `${variant.id.toLowerCase()}-${variant.label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.mp4`)
    }, options, { autoLocateRisk: results.length === 0 });
    const overview = await inspectCache(result.workDirectory, {
      policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
      limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
      now: options.now?.()
    });
    const entry = overview.entries.find((item) => item.frameCacheKey === result.frameCacheKey);
    if (results.length === 0) {
      sourceFrameCount = result.sourceFrameCount;
      previewMode = result.previewMode;
      turn = result.turn;
      sourceRanges = result.sourceRanges.map((range) => ({ ...range }));
      boundary = result.boundary ? { ...result.boundary } : void 0;
      frameRiskAnalysis = result.frameRiskAnalysis;
      selectedRiskPreview = result.selectedRiskPreview;
      if (selectedRiskPreview && resolvedCenterSeconds === void 0) {
        resolvedCenterSeconds = selectedRiskPreview.ptsTime ?? selectedRiskPreview.frame / result.media.video.frameRate;
      }
    }
    results.push({
      id: variant.id,
      label: variant.label,
      description: variant.description,
      outputPath: result.outputPath,
      durationMs: Math.max(0, (options.now?.() ?? Date.now()) - variantStarted),
      cacheSizeBytes: entry?.sizeBytes ?? 0,
      frameCacheKey: result.frameCacheKey,
      actualAiScale: result.actualAiScale,
      media: result.media,
      verification: result.verification
    });
  }
  const workDirectory = resolve5(options.workDirectory ?? defaultWorkDirectory(base.outputPath));
  const cache = await inspectCache(workDirectory, {
    policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
    limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
    now: options.now?.()
  });
  return {
    workDirectory,
    outputDirectory,
    sourceFrameCount,
    totalDurationMs: Math.max(0, (options.now?.() ?? Date.now()) - started),
    variants: results,
    cache,
    previewMode,
    ...turn ? { turn } : {},
    sourceRanges,
    ...boundary ? { boundary } : {},
    ...frameRiskAnalysis ? { frameRiskAnalysis } : {},
    ...selectedRiskPreview ? { selectedRiskPreview } : {}
  };
}
function loopPreviewTarget(target) {
  const scale = Math.min(1, 960 / Math.max(target.width, target.height));
  const even = (value) => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(target.width), height: even(target.height) };
}
async function loopPreviewVideo(rawSpec, preview, options = {}) {
  const base = parseJobSpec(rawSpec);
  const outputDirectory = resolve5(preview.outputDirectory);
  await mkdir4(outputDirectory, { recursive: true });
  const target = loopPreviewTarget(base.target);
  const interpolation = {
    mode: "none",
    factor: 1,
    backend: "rife-ncnn-vulkan",
    model: "rife-v4.6",
    memoryMode: "auto",
    sceneCutMode: "hold"
  };
  const encoding = {
    codec: "h264",
    encoder: "libx264",
    profile: "high",
    crf: 23,
    preset: "medium",
    pixelFormat: "yuv420p",
    removeAudio: true
  };
  const lightweight = {
    ...base,
    target,
    upscaleMode: "lanczos",
    upscaleBackend: "lanczos",
    model: "lanczos",
    tile: 0,
    gpuId: "auto",
    aiScale: "auto",
    batchSize: 64,
    interpolation,
    encoding
  };
  const definitions = [
    { id: "pingpong-end", label: "\u4E52\u4E53\u5FAA\u73AF \xB7 \u7247\u5C3E\u6298\u8FD4", description: "\u4E52\u4E53\u5FAA\u73AF\u5FC5\u987B\u68C0\u67E5\u7684\u7B2C 1 \u4E2A\u6298\u8FD4\u70B9", loopMode: "pingpong", turn: "end" },
    { id: "pingpong-start", label: "\u4E52\u4E53\u5FAA\u73AF \xB7 \u7247\u5934\u6298\u8FD4", description: "\u4E52\u4E53\u5FAA\u73AF\u5FC5\u987B\u68C0\u67E5\u7684\u7B2C 2 \u4E2A\u6298\u8FD4\u70B9", loopMode: "pingpong", turn: "start" },
    { id: "direct-seam", label: "\u76F4\u63A5\u5FAA\u73AF \xB7 \u5C3E\u9996\u8854\u63A5", description: "\u7247\u5C3E\u76F4\u63A5\u8DF3\u56DE\u7247\u5934\u65F6\u7684\u63A5\u7F1D", loopMode: "none" }
  ];
  const started = options.now?.() ?? Date.now();
  const variants = [];
  let sourceFrameCount = 0;
  for (const definition of definitions) {
    const variantStarted = options.now?.() ?? Date.now();
    const result = await previewNormalizedVideo({ ...lightweight, loopMode: definition.loopMode }, {
      previewMode: "loop-boundary",
      ...definition.turn ? { turn: definition.turn } : {},
      ...preview.frameCount === void 0 ? {} : { frameCount: preview.frameCount },
      outputPath: join4(outputDirectory, `${definition.id}.mp4`)
    }, options);
    if (!result.boundary)
      throw new AppError("E_JOB_STATE", "Loop preview did not report its boundary");
    sourceFrameCount = Math.max(sourceFrameCount, result.sourceFrameCount);
    variants.push({
      ...definition,
      outputPath: result.outputPath,
      durationMs: Math.max(0, (options.now?.() ?? Date.now()) - variantStarted),
      media: result.media,
      verification: result.verification,
      sourceRanges: result.sourceRanges,
      boundary: result.boundary
    });
  }
  const workDirectory = resolve5(options.workDirectory ?? defaultWorkDirectory(base.outputPath));
  const cache = await inspectCache(workDirectory, {
    policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
    limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
    now: options.now?.()
  });
  return {
    workDirectory,
    outputDirectory,
    sourceFrameCount,
    totalDurationMs: Math.max(0, (options.now?.() ?? Date.now()) - started),
    target,
    variants,
    cache
  };
}
async function cleanupFrameCache(frameCacheKey2, workDirectory) {
  await cleanupOneFrameCache(frameCacheKey2, workDirectory);
}

// apps/cli/src/arguments.ts
function parseArguments(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
  const flags = /* @__PURE__ */ new Map();
  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) throw new AppError("E_INVALID_ARGUMENT", `Unexpected argument: ${String(token)}`);
    const equals = token.indexOf("=");
    if (equals > 2) {
      flags.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== void 0 && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}
function requiredFlag(flags, name) {
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("E_INVALID_ARGUMENT", `--${name} is required`);
  }
  return value;
}
function optionalStringFlag(flags, name) {
  const value = flags.get(name);
  if (value === void 0) return void 0;
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("E_INVALID_ARGUMENT", `--${name} requires a value`);
  }
  return value;
}
function optionalNumberFlag(flags, name) {
  const value = flags.get(name);
  if (value === void 0) return void 0;
  if (typeof value !== "string") throw new AppError("E_INVALID_ARGUMENT", `--${name} requires a value`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new AppError("E_INVALID_ARGUMENT", `--${name} must be a number`);
  return parsed;
}
function previewOptionsFromFlags(flags, loopMode) {
  const rawPreviewMode = optionalStringFlag(flags, "preview-mode");
  if (rawPreviewMode !== void 0 && rawPreviewMode !== "segment" && rawPreviewMode !== "loop-boundary") {
    throw new AppError("E_INVALID_ARGUMENT", "--preview-mode must be segment or loop-boundary");
  }
  const rawTurn = optionalStringFlag(flags, "turn");
  if (rawTurn !== void 0 && rawTurn !== "start" && rawTurn !== "end") {
    throw new AppError("E_INVALID_ARGUMENT", "--turn must be start or end");
  }
  const centerSeconds = optionalNumberFlag(flags, "center");
  const frameCount = optionalNumberFlag(flags, "frames");
  const previewMode = rawPreviewMode ?? "segment";
  if (previewMode === "loop-boundary" && centerSeconds !== void 0) {
    throw new AppError("E_INVALID_ARGUMENT", "--center cannot be used with --preview-mode loop-boundary");
  }
  if (rawTurn !== void 0 && (previewMode !== "loop-boundary" || loopMode !== "pingpong")) {
    throw new AppError(
      "E_INVALID_ARGUMENT",
      "--turn requires --preview-mode loop-boundary with a pingpong job"
    );
  }
  return {
    ...centerSeconds === void 0 ? {} : { centerSeconds },
    ...frameCount === void 0 ? {} : { frameCount },
    ...rawPreviewMode === void 0 ? {} : { previewMode: rawPreviewMode },
    ...rawTurn === void 0 ? {} : { turn: rawTurn }
  };
}

// apps/cli/src/index.ts
var HELP = `AI Video Wallpaper CLI

Usage:
  wallpaper-video doctor [--json] [--cache PATH]
  wallpaper-video inspect --input VIDEO [--json] [--ffprobe PATH]
  wallpaper-video preview --config JOB.json [--preview-mode segment|loop-boundary] [--turn start|end] [--center SEC] [--frames N] [--output VIDEO] [--work-dir PATH] [--json]
  wallpaper-video diagnostic-preview --config JOB.json --output-dir PATH [--preview-mode segment|loop-boundary] [--turn start|end] [--center SEC] [--frames N] [--work-dir PATH] [--json]
  wallpaper-video loop-preview --config JOB.json --output-dir PATH [--frames N] [--work-dir PATH] [--json]
  wallpaper-video process --config JOB.json [--work-dir PATH] [--json]
  wallpaper-video verify --input VIDEO --expected JSON_OR_PATH [--json]
  wallpaper-video cache-status --work-dir PATH [--cache-policy POLICY] [--cache-limit-bytes N] [--json]
  wallpaper-video cache-cleanup --work-dir PATH [--cache-policy POLICY] [--cache-limit-bytes N] [--force] [--json]
  wallpaper-video cache-delete --work-dir PATH --frame-cache-key KEY [--json]

Shared tool flags: --ffmpeg PATH --ffprobe PATH --realesrgan PATH --rife PATH --cache PATH
Processing flags: --work-dir PATH --cache-policy cleanup-on-success|keep-24-hours|keep-all --cache-limit-bytes N
`;
var DEFAULT_CLI_DEPENDENCIES = {
  doctor,
  resolveBinaryPaths,
  inspectMedia,
  verifyMedia,
  inspectCache,
  runCacheMaintenance,
  cleanupFrameCache,
  previewVideo,
  diagnosticPreviewVideo,
  loopPreviewVideo,
  processVideo,
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  }
};
var PROCESS_PREVIEW_ONLY_FLAGS = ["preview-mode", "turn", "center", "frames", "output", "output-dir"];
function writer(json, dependencies) {
  return {
    json,
    value(value) {
      dependencies.writeStdout(`${JSON.stringify(value, null, json ? 0 : 2)}
`);
    },
    progress(event) {
      if (json) dependencies.writeStdout(`${JSON.stringify(event)}
`);
      else dependencies.writeStderr(`\r${event.phase.padEnd(10)} ${event.percent.toFixed(1).padStart(6)}% ${event.message}`);
    }
  };
}
async function readJson(path) {
  try {
    return JSON.parse(await readFile3(path, "utf8"));
  } catch (error) {
    throw new AppError("E_INVALID_CONFIG", `Could not read JSON: ${path}`, void 0, { cause: error });
  }
}
async function loadJobSpec(configPath) {
  const absoluteConfig = resolve6(configPath);
  const raw = await readJson(absoluteConfig);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { rawSpec: raw, normalizedSpec: parseJobSpec(raw) };
  }
  const value = { ...raw };
  const directory = dirname5(absoluteConfig);
  if (typeof value.inputPath === "string" && !isAbsolute(value.inputPath)) value.inputPath = resolve6(directory, value.inputPath);
  if (typeof value.outputPath === "string" && !isAbsolute(value.outputPath)) value.outputPath = resolve6(directory, value.outputPath);
  return { rawSpec: value, normalizedSpec: parseJobSpec(value) };
}
function binariesFromFlags(flags) {
  const result = {};
  for (const name of ["ffmpeg", "ffprobe", "realesrgan", "rife"]) {
    const value = flags.get(name);
    if (typeof value === "string") result[name] = resolve6(value);
  }
  return result;
}
function cacheFromFlags(flags) {
  const value = flags.get("cache");
  return typeof value === "string" ? resolve6(value) : defaultCacheDirectory();
}
function cachePolicyFromFlags(flags) {
  const value = optionalStringFlag(flags, "cache-policy");
  if (value === void 0) return void 0;
  if (value !== "cleanup-on-success" && value !== "keep-24-hours" && value !== "keep-all") {
    throw new AppError("E_INVALID_ARGUMENT", "--cache-policy must be cleanup-on-success, keep-24-hours, or keep-all");
  }
  return value;
}
async function expectedFromFlag(value) {
  if (value.trimStart().startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new AppError("E_INVALID_CONFIG", "--expected contains invalid JSON", void 0, { cause: error });
    }
  }
  return await readJson(resolve6(value));
}
function exitCode(error) {
  if (error.code === "E_CANCELLED") return 130;
  if (error.code === "E_INVALID_ARGUMENT" || error.code === "E_INVALID_CONFIG") return 2;
  if (error.code === "E_DEPENDENCY_MISSING") return 3;
  if (error.code === "E_VERIFICATION_FAILED") return 4;
  return 1;
}
async function runCli(argv = process.argv.slice(2), overrides = {}) {
  const dependencies = { ...DEFAULT_CLI_DEPENDENCIES, ...overrides };
  let output = writer(false, dependencies);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    const { command, flags } = parseArguments(argv);
    output = writer(flags.has("json"), dependencies);
    if (!command || command === "help" || flags.has("help")) {
      dependencies.writeStdout(HELP);
      return 0;
    }
    const cacheDirectory = cacheFromFlags(flags);
    const binaryOverrides = binariesFromFlags(flags);
    const cachePolicy = cachePolicyFromFlags(flags);
    const cacheLimitBytes = optionalNumberFlag(flags, "cache-limit-bytes");
    if (command === "doctor") {
      const report = await dependencies.doctor({ cacheDirectory, binaries: binaryOverrides });
      output.value(report);
      return 0;
    }
    if (command === "inspect") {
      const paths = await dependencies.resolveBinaryPaths(cacheDirectory, binaryOverrides);
      output.value(await dependencies.inspectMedia(requiredFlag(flags, "input"), {
        ffprobePath: paths.ffprobe,
        signal: controller.signal
      }));
      return 0;
    }
    if (command === "verify") {
      const paths = await dependencies.resolveBinaryPaths(cacheDirectory, binaryOverrides);
      const expectation = parseVerificationExpectation(await expectedFromFlag(requiredFlag(flags, "expected")));
      const result = await dependencies.verifyMedia(requiredFlag(flags, "input"), expectation, {
        ffmpegPath: paths.ffmpeg ?? "ffmpeg",
        ffprobePath: paths.ffprobe,
        signal: controller.signal,
        fullDecode: true
      });
      output.value(result);
      return result.passed ? 0 : 4;
    }
    if (command === "cache-status" || command === "cache-cleanup") {
      const workDirectory = resolve6(requiredFlag(flags, "work-dir"));
      const cacheOptions = { cachePolicy, cacheLimitBytes };
      const result = command === "cache-status" ? await dependencies.inspectCache(workDirectory, { policy: cacheOptions.cachePolicy, limitBytes: cacheOptions.cacheLimitBytes }) : await dependencies.runCacheMaintenance(workDirectory, {
        policy: cacheOptions.cachePolicy,
        limitBytes: cacheOptions.cacheLimitBytes,
        force: flags.has("force")
      });
      output.value(result);
      return 0;
    }
    if (command === "cache-delete") {
      const workDirectory = resolve6(requiredFlag(flags, "work-dir"));
      await dependencies.cleanupFrameCache(requiredFlag(flags, "frame-cache-key"), workDirectory);
      output.value(await dependencies.inspectCache(workDirectory, { policy: cachePolicy, limitBytes: cacheLimitBytes }));
      return 0;
    }
    if (command === "preview" || command === "diagnostic-preview" || command === "loop-preview" || command === "process") {
      const invalidProcessFlags = command === "process" ? PROCESS_PREVIEW_ONLY_FLAGS.filter((name) => flags.has(name)) : [];
      if (invalidProcessFlags.length > 0) {
        throw new AppError(
          "E_INVALID_ARGUMENT",
          `${invalidProcessFlags.map((name) => `--${name}`).join(", ")} ${invalidProcessFlags.length === 1 ? "is" : "are"} only supported by preview commands`
        );
      }
      if (command === "loop-preview" && (flags.has("preview-mode") || flags.has("turn") || flags.has("center"))) {
        throw new AppError("E_INVALID_ARGUMENT", "loop-preview always generates all loop boundaries; only --frames is supported");
      }
      const { rawSpec, normalizedSpec } = await loadJobSpec(requiredFlag(flags, "config"));
      const previewOptions = command === "process" || command === "loop-preview" ? void 0 : previewOptionsFromFlags(flags, normalizedSpec.loopMode);
      const workDirectory = optionalStringFlag(flags, "work-dir");
      const options = {
        cacheDirectory,
        workDirectory: workDirectory === void 0 ? void 0 : resolve6(workDirectory),
        binaries: binaryOverrides,
        signal: controller.signal,
        onProgress: (event) => output.progress(event),
        cachePolicy,
        cacheLimitBytes
      };
      const result = command === "preview" ? await dependencies.previewVideo(rawSpec, {
        ...previewOptions,
        outputPath: typeof flags.get("output") === "string" ? String(flags.get("output")) : void 0
      }, options) : command === "diagnostic-preview" ? await dependencies.diagnosticPreviewVideo(rawSpec, {
        ...previewOptions,
        outputDirectory: requiredFlag(flags, "output-dir")
      }, options) : command === "loop-preview" ? await dependencies.loopPreviewVideo(rawSpec, {
        outputDirectory: requiredFlag(flags, "output-dir"),
        frameCount: optionalNumberFlag(flags, "frames")
      }, options) : await dependencies.processVideo(rawSpec, options);
      if (!output.json) dependencies.writeStderr("\n");
      output.value(result);
      return 0;
    }
    throw new AppError("E_INVALID_ARGUMENT", `Unknown command: ${command}`);
  } catch (error) {
    const appError = toAppError(error);
    if (!output.json) dependencies.writeStderr("\n");
    dependencies.writeStderr(`${JSON.stringify(appError.toJSON(), null, output.json ? 0 : 2)}
`);
    return exitCode(appError);
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}
async function main(argv = process.argv.slice(2)) {
  return await runCli(argv);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve6(process.argv[1])).href) {
  process.exitCode = await main();
}
export {
  loadJobSpec,
  main,
  runCli
};
