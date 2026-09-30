import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProgressEvent } from "../../../shared/contracts";
import { TaskDock, translateTaskMessage, type TaskDockProps, type UiTask } from "./TaskDock";

function progress(percent: number, phase: ProgressEvent["phase"] = "encode"): ProgressEvent {
  return { jobId: "a".repeat(20), phase, current: percent, total: 100, percent, etaMs: 80_000, message: phase === "verify" ? "Verifying output" : "Encoding H.264 wallpaper" };
}

function task(status: UiTask["status"] = "running", percent = 50, phase: ProgressEvent["phase"] = "encode"): UiTask {
  return {
    id: "task-1",
    kind: "process",
    status,
    progress: progress(percent, phase),
    jobId: "a".repeat(20),
    logs: ["line one"],
    result: status === "complete" ? { outputPath: "D:\\output.mp4" } : null,
    error: status === "error" ? { code: "E_IO", message: "磁盘写入失败" } : null,
    workDirectory: "D:\\work",
    outputPath: "D:\\output.mp4",
    frameCacheReference: null,
    jobFilesAvailable: true,
    frameCacheAvailable: true,
    jobFilesCleaned: false,
    frameCacheCleaned: false,
  };
}

function props(value: UiTask | null): TaskDockProps {
  return {
    task: value,
    taskBusy: value?.status === "running" || value?.status === "starting",
    canStart: value?.status !== "running" && value?.status !== "starting",
    doctorError: null,
    pageError: null,
    logDetailsRef: createRef<HTMLDetailsElement>(),
    onOpenTools: vi.fn(),
    onClosePageError: vi.fn(),
    onRunTask: vi.fn(),
    onCancelTask: vi.fn(),
    onOpenCleanup: vi.fn(),
    onOpenOutput: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TaskDock", () => {
  it("uses a loop-neutral label for sequence construction", () => {
    expect(translateTaskMessage("Building output sequence")).toBe("正在构建输出序列");
  });

  it("exposes the two preview levels as direct actions", () => {
    render(<TaskDock {...props(null)} />);
    expect(screen.getByRole("button", { name: "快速检查循环" })).toBeVisible();
    expect(screen.getByRole("button", { name: "最终效果预览" })).toBeVisible();
  });

  it("uses one elastic progress state for processing and verification", () => {
    const { rerender } = render(<TaskDock {...props(task("running", 25))} />);
    expect(screen.getByRole("progressbar", { name: "任务进度" })).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("25%")).toBeVisible();
    expect(screen.getByText("剩余约 1 分 20 秒")).toBeVisible();

    const verifyingPreview = task("running", 99, "verify");
    verifyingPreview.kind = "preview";
    rerender(<TaskDock {...props(verifyingPreview)} />);
    expect(screen.getAllByText("正在验证")).toHaveLength(2);
    expect(screen.queryByText("正在生成短预览")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "任务进度" })).toHaveAttribute("aria-valuenow", "99");
    expect(screen.getAllByText("99%")).toHaveLength(1);
  });

  it("holds a full completion track for one second and then keeps only verification", () => {
    vi.useFakeTimers();
    render(<TaskDock {...props(task("complete", 100, "complete"))} />);
    const track = screen.getByRole("progressbar", { name: "任务进度" });
    expect(track).toHaveAttribute("aria-valuenow", "100");
    expect(track).toHaveClass("is-visible");
    act(() => vi.advanceTimersByTime(1_000));
    expect(track).not.toHaveClass("is-visible");
    expect(screen.getByText("已验证")).toBeVisible();
  });

  it("distinguishes failed and cancelled terminal states", () => {
    const { container, rerender } = render(<TaskDock {...props(task("error", 50))} />);
    expect(container.querySelector(".task-dock")).toHaveClass("status-error");
    expect(screen.getByText("磁盘写入失败")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "任务进度" })).toHaveClass("is-visible");
    expect(screen.getByRole("button", { name: "再次运行" })).toBeVisible();

    rerender(<TaskDock {...props(task("cancelled", 100))} />);
    expect(container.querySelector(".task-dock")).toHaveClass("status-cancelled");
    expect(screen.getByText("已取消")).toBeVisible();
    expect(container.querySelector(".progress-track")).not.toHaveClass("is-visible");
  });

  it("opens the command menu, runs an item, and restores focus with Escape", () => {
    vi.useFakeTimers();
    const callbacks = props(task("error", 50));
    render(<TaskDock {...callbacks} />);
    const trigger = screen.getByRole("button", { name: "更多任务操作" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "再次运行" }));
    expect(callbacks.onRunTask).toHaveBeenCalledWith("process");
    act(() => vi.runAllTimers());

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => vi.runAllTimers());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
