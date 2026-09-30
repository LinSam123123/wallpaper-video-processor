import type { CurrentTaskBinding } from "./cleanup-binding.js";

interface CancellationOptions {
  taskId: string;
  binding: CurrentTaskBinding | null;
  writeMarker: (workDirectory: string, jobId: string) => Promise<unknown>;
  terminate: (taskId: string) => void | Promise<void>;
}

function hasBoundJob(binding: CurrentTaskBinding | null, taskId: string): binding is CurrentTaskBinding & { jobId: string } {
  return binding?.taskId === taskId && typeof binding.jobId === "string" && /^[a-f0-9]{20}$/.test(binding.jobId);
}

export async function cancelBoundTask(options: CancellationOptions): Promise<void> {
  let markerError: unknown;
  if (hasBoundJob(options.binding, options.taskId)) {
    try {
      await options.writeMarker(options.binding.workDirectory, options.binding.jobId);
    } catch (error) {
      markerError = error;
    }
  }

  await options.terminate(options.taskId);
  if (markerError !== undefined) throw markerError;
}
