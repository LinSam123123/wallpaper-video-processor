// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { frameCacheCleanupDirectory, jobCleanupDirectory } from "./cleanup-paths";

describe("cleanup paths", () => {
  it("targets only validated job and shared cache children", () => {
    const work = resolve("D:\\wallpaper-work");
    expect(jobCleanupDirectory(work, "a".repeat(20))).toBe(resolve(work, "jobs", "a".repeat(20)));
    expect(frameCacheCleanupDirectory(work, "b".repeat(64))).toBe(resolve(work, "frame-cache", "b".repeat(64)));
  });

  it("rejects traversal and malformed identifiers", () => {
    for (const jobId of ["../outside", "A".repeat(20), "a".repeat(19)]) {
      expect(() => jobCleanupDirectory("work", jobId)).toThrow("任务 ID 无效");
    }
    for (const key of ["../outside", "B".repeat(64), "b".repeat(63)]) {
      expect(() => frameCacheCleanupDirectory("work", key)).toThrow("AI 帧缓存标识无效");
    }
  });
});
