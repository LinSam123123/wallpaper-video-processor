import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CleanupStatus, TaskEvent } from "../shared/contracts.js";
import { frameCacheCleanupDirectory, jobCleanupDirectory } from "./cleanup-paths.js";

export interface CurrentTaskBinding {
  taskId: string | null;
  workDirectory: string;
  jobId: string | null;
  frameCacheKey: string | null;
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function validJobId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{20}$/.test(value);
}

function validFrameCacheKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function directoryExists(path: string): Promise<boolean> {
  return await stat(path).then((info) => info.isDirectory(), () => false);
}

export function createTaskBinding(workDirectory: string): CurrentTaskBinding {
  return { taskId: null, workDirectory: resolve(workDirectory), jobId: null, frameCacheKey: null };
}

export function bindTaskEvent(binding: CurrentTaskBinding, event: TaskEvent): CurrentTaskBinding {
  if (binding.taskId !== null && binding.taskId !== event.taskId) return binding;
  let next: CurrentTaskBinding = { ...binding, taskId: event.taskId };
  if (event.type === "progress" && validJobId(event.progress.jobId)) {
    if (next.jobId !== null && next.jobId !== event.progress.jobId) return binding;
    next = { ...next, jobId: event.progress.jobId };
  }
  if (event.type === "complete") {
    const resultJobId = event.result.jobId;
    const resultWorkDirectory = event.result.workDirectory;
    const resultFrameCacheKey = event.result.frameCacheKey;
    if (!validJobId(resultJobId) || typeof resultWorkDirectory !== "string" ||
        resolve(resultWorkDirectory) !== next.workDirectory || !validFrameCacheKey(resultFrameCacheKey) ||
        (next.jobId !== null && next.jobId !== resultJobId)) return next;
    next = { ...next, jobId: resultJobId, frameCacheKey: resultFrameCacheKey };
  }
  return next;
}

export function assertCurrentTask(
  binding: CurrentTaskBinding | null,
  taskId: string,
  jobId: string,
): CurrentTaskBinding {
  if (!binding || binding.taskId !== taskId || binding.jobId !== jobId || !validJobId(jobId)) {
    throw failure("E_INVALID_ARGUMENT", "清理请求与当前任务不匹配");
  }
  return binding;
}

export async function resolveCleanupStatus(
  binding: CurrentTaskBinding,
): Promise<{ binding: CurrentTaskBinding; status: CleanupStatus }> {
  if (!binding.jobId) throw failure("E_JOB_STATE", "当前任务尚未建立可清理状态");
  const jobDirectory = jobCleanupDirectory(binding.workDirectory, binding.jobId);
  const jobFilesAvailable = await directoryExists(jobDirectory);
  let frameCacheKey = binding.frameCacheKey;

  if (jobFilesAvailable) {
    let state: unknown;
    try {
      state = JSON.parse(await readFile(join(jobDirectory, "job-state.json"), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw failure("E_JOB_STATE", "无法读取当前任务状态文件");
      }
    }
    if (state !== undefined) {
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw failure("E_JOB_STATE", "当前任务状态文件格式无效");
      }
      const record = state as Record<string, unknown>;
      if (record.jobId !== binding.jobId) throw failure("E_JOB_STATE", "任务状态标识不匹配");
      if (record.frameCacheKey !== undefined && !validFrameCacheKey(record.frameCacheKey)) {
        throw failure("E_JOB_STATE", "任务状态包含无效的共享缓存标识");
      }
      if (validFrameCacheKey(record.frameCacheKey)) {
        if (frameCacheKey !== null && frameCacheKey !== record.frameCacheKey) {
          throw failure("E_JOB_STATE", "任务结果与状态文件的共享缓存标识不匹配");
        }
        frameCacheKey = record.frameCacheKey;
      }
    }
  }

  const frameCacheAvailable = frameCacheKey !== null &&
    await directoryExists(frameCacheCleanupDirectory(binding.workDirectory, frameCacheKey));
  const next = { ...binding, frameCacheKey };
  return {
    binding: next,
    status: {
      workDirectory: next.workDirectory,
      jobFilesAvailable,
      frameCacheAvailable,
      frameCacheReference: frameCacheKey ? `${frameCacheKey.slice(0, 12)}...` : null,
    },
  };
}
