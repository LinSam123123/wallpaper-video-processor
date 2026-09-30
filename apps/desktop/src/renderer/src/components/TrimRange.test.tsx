import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrimRange } from "./TrimRange";

describe("TrimRange", () => {
  afterEach(cleanup);

  it("treats the selected range as half-open and reports the ping-pong result", () => {
    const onChange = vi.fn();
    render(<TrimRange
      range={{ startFrame: 10, endFrameExclusive: 20 }}
      totalFrames={100}
      frameRate={10}
      currentFrame={15}
      loopMode="pingpong"
      onChange={onChange}
      onReset={vi.fn()}
    />);

    const start = screen.getByRole("slider", { name: "片段入点" });
    const end = screen.getByRole("slider", { name: "片段出点" });
    expect(start).toHaveValue("10");
    expect(end).toHaveValue("20");
    expect(screen.getByText("10 帧片段")).toBeVisible();
    expect(screen.getByText("1.80 秒")).toBeVisible();

    fireEvent.change(start, { target: { value: "20" } });
    expect(onChange).toHaveBeenLastCalledWith({ startFrame: 19, endFrameExclusive: 20 }, 19);
    fireEvent.change(end, { target: { value: "10" } });
    expect(onChange).toHaveBeenLastCalledWith({ startFrame: 10, endFrameExclusive: 11 }, 10);
  });

  it("sets in and out points from the current frame and resets a trimmed range", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    const { rerender } = render(<TrimRange
      range={{ startFrame: 10, endFrameExclusive: 30 }}
      totalFrames={100}
      frameRate={20}
      currentFrame={25}
      loopMode="none"
      onChange={onChange}
      onReset={onReset}
    />);

    fireEvent.click(screen.getByRole("button", { name: "设为入点" }));
    expect(onChange).toHaveBeenLastCalledWith({ startFrame: 25, endFrameExclusive: 30 }, 25);
    fireEvent.click(screen.getByRole("button", { name: "设为出点" }));
    expect(onChange).toHaveBeenLastCalledWith({ startFrame: 10, endFrameExclusive: 26 }, 25);

    const reset = screen.getByRole("button", { name: "重置片段范围" });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledOnce();

    rerender(<TrimRange
      range={{ startFrame: 0, endFrameExclusive: 100 }}
      totalFrames={100}
      frameRate={20}
      currentFrame={25}
      loopMode="none"
      onChange={onChange}
      onReset={onReset}
    />);
    expect(screen.getByRole("button", { name: "重置片段范围" })).toBeDisabled();
  });
});
