import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdvancedSection } from "./AdvancedSection";

describe("AdvancedSection", () => {
  it("starts collapsed and exposes its expanded state", () => {
    render(<AdvancedSection label="高级编码"><button type="button">内部操作</button></AdvancedSection>);
    const toggle = screen.getByRole("button", { name: "高级编码" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "内部操作" })).toBeVisible();
  });
});
