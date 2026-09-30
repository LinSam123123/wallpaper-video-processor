import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

describe("SegmentedControl", () => {
  it("exposes selection state and reports a new value", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="画幅"
        value="contain"
        options={[
          { value: "contain", label: "完整" },
          { value: "cover", label: "裁切" },
        ]}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("button", { name: "完整" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "裁切" }));
    expect(onChange).toHaveBeenCalledWith("cover");
  });
});
