import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheOverview } from "../../../shared/contracts";
import { CacheControls, cacheUsageState } from "./CacheControls";

const GIB = 1024 ** 3;

afterEach(cleanup);

function overview(remainingBytes: number): CacheOverview {
  return {
    workDirectory: "D:\\work",
    cacheDirectory: "D:\\work\\frame-cache",
    policy: "cleanup-on-success",
    limitBytes: 50 * GIB,
    totalBytes: remainingBytes,
    releasedBytes: 0,
    remainingBytes,
    removedKeys: [],
    legacyCount: 0,
    entries: [],
    errors: [],
  };
}

function props(remainingBytes = 1.4 * GIB) {
  return {
    overview: overview(remainingBytes),
    policy: "cleanup-on-success" as const,
    limitGiB: 50,
    workDirectory: "D:\\work",
    lastReleasedBytes: 0,
    disabled: false,
    busy: false,
    onPolicyChange: vi.fn(),
    onLimitCommit: vi.fn(),
    onCleanup: vi.fn(),
  };
}

describe("CacheControls", () => {
  it("formats a single-line current/limit summary and exposes the usage ratio", () => {
    const { container, rerender } = render(<CacheControls {...props()} />);
    expect(container.querySelector(".cache-usage-row strong")).toHaveTextContent("1.4 GB / 50 GB");
    expect(screen.getByRole("progressbar", { name: "缓存占用" })).toHaveAttribute("aria-valuenow", "3");

    rerender(<CacheControls {...props(0)} />);
    expect(container.querySelector(".cache-usage-row strong")).toHaveTextContent("0 B / 50 GB");
  });

  it("uses warning and danger thresholds without overstating disk capacity", () => {
    expect(cacheUsageState(40 * GIB, 50 * GIB)).toMatchObject({ level: "warning", label: "接近上限" });
    expect(cacheUsageState(47.5 * GIB, 50 * GIB)).toMatchObject({ level: "danger", label: "接近上限" });
    expect(cacheUsageState(51 * GIB, 50 * GIB)).toMatchObject({ level: "danger", label: "已超上限" });
  });

  it("keeps the full input contract when disabled and forwards edits and cleanup", () => {
    const handlers = props();
    const { rerender } = render(<CacheControls {...handlers} />);
    const input = screen.getByRole("spinbutton", { name: "缓存上限" });
    fireEvent.change(input, { target: { value: "64" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "清理缓存" }));
    expect(handlers.onLimitCommit).toHaveBeenCalledWith(64);
    expect(handlers.onCleanup).toHaveBeenCalledTimes(1);

    rerender(<CacheControls {...handlers} disabled />);
    expect(screen.getByRole("spinbutton", { name: "缓存上限" })).toBeDisabled();
    expect(screen.getByText("GB")).toBeVisible();
  });
});
