import { dirname, join, resolve } from "node:path";

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "E_INVALID_ARGUMENT" });
}

function checkedChild(root: string, name: string): string {
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, name);
  if (dirname(target) !== normalizedRoot) throw invalid("清理路径超出工作目录");
  return target;
}

export function jobCleanupDirectory(workDirectory: string, jobId: string): string {
  if (!/^[a-f0-9]{20}$/.test(jobId)) throw invalid("任务 ID 无效");
  return checkedChild(resolve(workDirectory, "jobs"), jobId);
}

export function frameCacheCleanupDirectory(workDirectory: string, frameCacheKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(frameCacheKey)) throw invalid("AI 帧缓存标识无效");
  return checkedChild(resolve(workDirectory, "frame-cache"), frameCacheKey);
}

export function cancellationMarkerPath(workDirectory: string, jobId: string): string {
  return join(jobCleanupDirectory(workDirectory, jobId), ".cancel");
}
