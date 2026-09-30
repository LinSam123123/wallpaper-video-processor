import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "./Switch";

describe("Switch", () => {
  afterEach(cleanup);

  it("toggles with pointer and keyboard while preserving switch semantics", () => {
    const onChange = vi.fn();
    render(<Switch checked label="同步播放" tooltip="同步播放四个诊断方案" onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "同步播放" });

    expect(control).toHaveAttribute("aria-checked", "true");
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(false);
    control.focus();
    fireEvent.keyDown(control, { key: " " });
    fireEvent.keyUp(control, { key: " " });
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("does not toggle when disabled", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="同步播放" disabled onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "同步播放" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
