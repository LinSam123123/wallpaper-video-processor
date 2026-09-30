import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TypographyPreview } from "./TypographyPreview";

describe("TypographyPreview", () => {
  it("renders every semantic text level and the effective font families", () => {
    const { container, rerender } = render(<TypographyPreview titleScope="product-and-major" uiFamilies="Source Sans 3 / Noto Sans SC" displayFamilies="Newsreader / Noto Serif SC" />);
    const preview = screen.getByLabelText("排版预览");
    expect(preview).toHaveAttribute("data-preview-title-scope", "product-and-major");
    expect(container.querySelector(".display-title")).toHaveTextContent("AI 视频壁纸处理器");
    expect(container.querySelector(".major-section-title")).toHaveTextContent("清晰度与循环");
    expect(container.querySelector(".minor-section-title")).toHaveTextContent("工作文件与缓存");
    expect(container.querySelector(".numeric-data")).toHaveTextContent("2560 × 1600 · 48 fps · 1.4 GB");
    expect(screen.getByText(/展示：Newsreader \/ Noto Serif SC/)).toHaveTextContent("界面：Source Sans 3 / Noto Sans SC");

    rerender(<TypographyPreview titleScope="all-titles" uiFamilies="Noto Sans SC" displayFamilies="Noto Serif SC" />);
    expect(preview).toHaveAttribute("data-preview-title-scope", "all-titles");
  });
});
