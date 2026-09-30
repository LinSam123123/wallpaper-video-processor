import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select } from "./Select";

const options = [
  { value: "first", label: "第一项" },
  { value: "disabled", label: "不可用", disabled: true },
  { value: "last", label: "最后一项" },
];

describe("Select", () => {
  afterEach(cleanup);

  it("selects an option and restores focus", async () => {
    const onChange = vi.fn();
    render(<><label htmlFor="sample">选项</label><Select id="sample" value="first" options={options} onChange={onChange} /></>);
    const trigger = screen.getByRole("button", { name: "选项" });

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("option", { name: "最后一项" }));
    expect(onChange).toHaveBeenCalledWith("last");
    expect(trigger).toHaveFocus();
  });

  it("supports keyboard navigation and skips disabled options", () => {
    const onChange = vi.fn();
    render(<Select id="keyboard" ariaLabel="键盘选择" value="first" options={options} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "键盘选择" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("last");
  });

  it("supports Home, End, Escape and outside dismissal", async () => {
    render(<div><Select id="dismiss" ariaLabel="关闭测试" value="last" options={options} onChange={() => undefined} /><button type="button">外部</button></div>);
    const trigger = screen.getByRole("button", { name: "关闭测试" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Home" });
    expect(screen.getByRole("option", { name: "第一项" })).toHaveClass("is-active");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "End" });
    expect(screen.getByRole("option", { name: "最后一项" })).toHaveClass("is-active");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "外部" }));
    expect(trigger).toHaveFocus();
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
  });

  it("does not open when disabled", () => {
    render(<Select id="disabled" ariaLabel="已禁用" value="first" options={options} disabled onChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "已禁用" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
