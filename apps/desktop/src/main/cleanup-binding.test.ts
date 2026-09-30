// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskEvent } from "../shared/contracts";
import { assertCurrentTask, bindTaskEvent, createTaskBinding, resolveCleanupStatus } from "./cleanup-binding";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function failedTaskFixture(terminalType: "error" | "cancelled") {
  const work = await mkdtemp(join(tmpdir(), "desktop-cleanup-binding-"));
  roots.push(work);
  const taskId = "task-current";
  const jobId = "a".repeat(20);
  const frameCacheKey = "b".repeat(64);
  const jobDirectory = join(work, "jobs", jobId);
  await mkdir(join(work, "frame-cache", frameCacheKey), { recursive: true });
  await mkdir(jobDirectory, { recursive: true });
  await writeFile(join(jobDirectory, "job-state.json"), JSON.stringify({ jobId, frameCacheKey }), "utf8");
  let binding = createTaskBinding(work);
  binding = bindTaskEvent(binding, {
    taskId,
    kind: "process",
    type: "progress",
    progress: { jobId, phase: "prepare", current: 0, total: 1, percent: 0, etaMs: null, message: "prepare" },
  });
  const terminal: TaskEvent = terminalType === "cancelled"
    ? { taskId, kind: "process", type: "cancelled" }
    : { taskId, kind: "process", type: "error", error: { code: "E_INSUFFICIENT_SPACE", message: "disk full" } };
  return { binding: bindTaskEvent(binding, terminal), taskId, jobId, frameCacheKey, work };
}

describe("current task cleanup binding", () => {
  it.each(["error", "cancelled"] as const)("resolves shared cache after a %s terminal event", async (terminalType) => {
    const fixture = await failedTaskFixture(terminalType);
    const resolved = await resolveCleanupStatus(assertCurrentTask(fixture.binding, fixture.taskId, fixture.jobId));
    expect(resolved.status).toMatchObject({ jobFilesAvailable: true, frameCacheAvailable: true });
    expect(resolved.binding.frameCacheKey).toBe(fixture.frameCacheKey);
  });

  it("keeps completed result binding available without a job state file", async () => {
    const work = await mkdtemp(join(tmpdir(), "desktop-cleanup-complete-"));
    roots.push(work);
    const jobId = "c".repeat(20);
    const frameCacheKey = "d".repeat(64);
    await mkdir(join(work, "frame-cache", frameCacheKey), { recursive: true });
    const binding = bindTaskEvent(createTaskBinding(work), {
      taskId: "task-complete",
      kind: "process",
      type: "complete",
      result: { jobId, workDirectory: work, frameCacheKey },
    });
    const resolved = await resolveCleanupStatus(binding);
    expect(resolved.status.frameCacheAvailable).toBe(true);
  });

  it("rejects task mismatches and malicious state cache keys", async () => {
    const fixture = await failedTaskFixture("error");
    expect(() => assertCurrentTask(fixture.binding, "other-task", fixture.jobId)).toThrow("当前任务不匹配");
    expect(() => assertCurrentTask(fixture.binding, fixture.taskId, "c".repeat(20))).toThrow("当前任务不匹配");
    await writeFile(
      join(fixture.work, "jobs", fixture.jobId, "job-state.json"),
      JSON.stringify({ jobId: fixture.jobId, frameCacheKey: "../outside" }),
      "utf8",
    );
    await expect(resolveCleanupStatus(fixture.binding)).rejects.toThrow("无效的共享缓存标识");
  });
});
