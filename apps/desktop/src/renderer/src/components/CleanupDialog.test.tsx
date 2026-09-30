import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CleanupDialog } from "./CleanupDialog";

describe("CleanupDialog", () => {
  it("distinguishes job state from shared cache and confirms destructive cache cleanup", () => {
    const cleanupJob = vi.fn();
    const cleanupCache = vi.fn();
    render(
      <CleanupDialog
        open
        workDirectory="D:\\wallpaper-work"
        jobFilesAvailable
        frameCacheAvailable
        frameCacheReference="aaaaaaaaaaaa..."
        jobFilesCleaned={false}
        frameCacheCleaned={false}
        busy={null}
        onClose={vi.fn()}
        onCleanupJob={cleanupJob}
        onCleanupFrameCache={cleanupCache}
      />,
    );

    expect(screen.getByText("任务状态文件")).toBeVisible();
    expect(screen.getByText("共享 AI 帧缓存")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清理任务状态" }));
    expect(cleanupJob).toHaveBeenCalledOnce();

    const destructive = screen.getByRole("button", { name: "删除共享 AI 帧缓存" });
    expect(destructive).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(destructive).toBeEnabled();
    fireEvent.click(destructive);
    expect(cleanupCache).toHaveBeenCalledOnce();
  });
});
