import { lstat, writeFile } from "node:fs/promises";
import { cancellationMarkerPath, jobCleanupDirectory } from "./cleanup-paths.js";

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function realDirectory(path: string): Promise<boolean> {
  return await lstat(path).then((info) => info.isDirectory() && !info.isSymbolicLink(), () => false);
}

export async function writeCancellationMarker(workDirectory: string, jobId: string): Promise<string> {
  const jobDirectory = jobCleanupDirectory(workDirectory, jobId);
  if (!await realDirectory(jobDirectory)) throw failure("E_JOB_STATE", "当前任务目录不存在或不是普通目录");
  const marker = cancellationMarkerPath(workDirectory, jobId);
  await writeFile(marker, "", { encoding: "utf8", flag: "w" });
  return marker;
}
