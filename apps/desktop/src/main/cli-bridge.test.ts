// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { buildTaskArguments, terminateProcessTree } from "./cli-bridge";

describe("buildTaskArguments", () => {
  it("passes a custom work directory to process", () => {
    expect(buildTaskArguments({
      kind: "process",
      configPath: "C:\\requests\\job.json",
      workDirectory: "D:\\wallpaper-work",
    })).toEqual([
      "process",
      "--config",
      "C:\\requests\\job.json",
      "--json",
      "--work-dir",
      resolve("D:\\wallpaper-work"),
    ]);
  });

  it("keeps preview controls while adding the work directory", () => {
    expect(buildTaskArguments({
      kind: "preview",
      configPath: "job.json",
      previewOutputPath: "preview.mp4",
      centerSeconds: 12.5,
      previewMode: "segment",
      workDirectory: "work",
    })).toEqual([
      "preview", "--config", "job.json", "--json",
      "--work-dir", resolve("work"),
      "--output", "preview.mp4",
      "--preview-mode", "segment",
      "--center", "12.5",
    ]);
  });

  it("passes diagnostic output and cache lifecycle settings", () => {
    expect(buildTaskArguments({
      kind: "diagnostic-preview",
      configPath: "job.json",
      diagnosticOutputDirectory: "D:\\diagnostics",
      previewMode: "loop-boundary",
      turn: "end",
      workDirectory: "D:\\work",
      cachePolicy: "cleanup-on-success",
      cacheLimitBytes: 50 * 1024 ** 3,
    })).toEqual([
      "diagnostic-preview", "--config", "job.json", "--json",
      "--work-dir", resolve("D:\\work"),
      "--cache-policy", "cleanup-on-success",
      "--cache-limit-bytes", String(50 * 1024 ** 3),
      "--output-dir", "D:\\diagnostics",
      "--preview-mode", "loop-boundary",
      "--turn", "end",
    ]);
  });

  it("lets Core choose the default two-second preview frame count", () => {
    const args = buildTaskArguments({
      kind: "preview",
      configPath: "job.json",
      previewOutputPath: "preview.mp4",
    });
    expect(args).not.toContain("--frames");
    expect(args).toEqual([
      "preview", "--config", "job.json", "--json",
      "--output", "preview.mp4",
    ]);
  });

  it("passes the dedicated output directory to a loop preview", () => {
    expect(buildTaskArguments({
      kind: "loop-preview",
      configPath: "job.json",
      loopPreviewOutputDirectory: "D:\\loop-previews",
    })).toEqual([
      "loop-preview", "--config", "job.json", "--json",
      "--output-dir", "D:\\loop-previews",
    ]);
  });
});

describe("terminateProcessTree", () => {
  it("uses the fixed Windows taskkill executable and terminates the full child tree", () => {
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawnProcess = vi.fn(() => killer) as unknown as typeof import("node:child_process").spawn;
    const child = { pid: 4242, kill: vi.fn() };

    terminateProcessTree(child as never, {
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "4242", "/t", "/f"],
      { windowsHide: true, stdio: "ignore" },
    );
    expect(killer.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to terminating the CLI when taskkill cannot be launched", () => {
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawnProcess = vi.fn(() => killer) as unknown as typeof import("node:child_process").spawn;
    const child = { pid: 4242, kill: vi.fn() };

    terminateProcessTree(child as never, { platform: "win32", spawnProcess });
    killer.emit("error", new Error("taskkill missing"));

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses SIGTERM directly outside Windows", () => {
    const child = { pid: 4242, kill: vi.fn() };

    terminateProcessTree(child as never, { platform: "linux" });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
