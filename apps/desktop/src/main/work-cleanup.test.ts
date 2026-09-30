// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cancellationMarkerPath } from "./cleanup-paths";
import { writeCancellationMarker } from "./work-cleanup";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "desktop-work-cleanup-"));
  roots.push(value);
  return value;
}

async function job(work: string, jobId: string, state: unknown): Promise<string> {
  const directory = join(work, "jobs", jobId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "job-state.json"), typeof state === "string" ? state : JSON.stringify(state), "utf8");
  return directory;
}

describe("graceful cancellation marker", () => {
  it("writes only the marker inside the validated bound job", async () => {
    const work = await root();
    const jobId = "a".repeat(20);
    await job(work, jobId, { jobId });
    expect(await writeCancellationMarker(work, jobId)).toBe(cancellationMarkerPath(work, jobId));
    expect(await readFile(cancellationMarkerPath(work, jobId), "utf8")).toBe("");
  });

  it("rejects malformed jobs and does not create paths", async () => {
    const work = await root();
    await expect(writeCancellationMarker(work, "../outside")).rejects.toThrow("任务 ID 无效");
    await expect(writeCancellationMarker(work, "b".repeat(20))).rejects.toThrow("任务目录不存在");
  });
});
