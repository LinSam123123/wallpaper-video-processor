// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { cancelBoundTask } from "./task-cancellation";

const binding = {
  taskId: "task-1",
  workDirectory: "D:\\wallpaper-work",
  jobId: "0123456789abcdefabcd",
  frameCacheKey: null,
};

describe("cancelBoundTask", () => {
  it("writes the resumable cancellation marker and then terminates the active CLI", async () => {
    const order: string[] = [];
    const writeMarker = vi.fn(async () => { order.push("marker"); });
    const terminate = vi.fn(() => { order.push("terminate"); });

    await cancelBoundTask({ taskId: "task-1", binding, writeMarker, terminate });

    expect(writeMarker).toHaveBeenCalledWith(binding.workDirectory, binding.jobId);
    expect(terminate).toHaveBeenCalledWith("task-1");
    expect(order).toEqual(["marker", "terminate"]);
  });

  it("still terminates the CLI when writing the marker fails", async () => {
    const markerError = Object.assign(new Error("marker failed"), { code: "E_JOB_STATE" });
    const terminate = vi.fn();

    await expect(cancelBoundTask({
      taskId: "task-1",
      binding,
      writeMarker: vi.fn().mockRejectedValue(markerError),
      terminate,
    })).rejects.toBe(markerError);

    expect(terminate).toHaveBeenCalledWith("task-1");
  });

  it("terminates an early task before its job id is known", async () => {
    const writeMarker = vi.fn();
    const terminate = vi.fn();

    await cancelBoundTask({
      taskId: "task-1",
      binding: { ...binding, jobId: null },
      writeMarker,
      terminate,
    });

    expect(writeMarker).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledWith("task-1");
  });
});
