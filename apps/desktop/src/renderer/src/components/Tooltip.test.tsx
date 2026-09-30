import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("waits before showing and cancels a quick hover", () => {
    vi.useFakeTimers();
    render(<Tooltip content="完整说明"><button type="button">目标</button></Tooltip>);
    const target = screen.getByRole("button", { name: "目标" });
    fireEvent.mouseEnter(target);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.mouseLeave(target);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows for hover and keyboard focus, then closes", () => {
    vi.useFakeTimers();
    render(<Tooltip content="完整说明"><button type="button">目标</button></Tooltip>);
    const target = screen.getByRole("button", { name: "目标" });
    fireEvent.mouseEnter(target);
    act(() => vi.advanceTimersByTime(450));
    expect(screen.getByRole("tooltip")).toHaveTextContent("完整说明");
    expect(target).toHaveAttribute("aria-describedby");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.focus(target);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole("tooltip")).toBeVisible();
    fireEvent.blur(target);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
