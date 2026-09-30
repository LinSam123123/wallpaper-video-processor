import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "./appearance";
import { applyCustomTypography, builtinTypographyResult } from "./font-loader";

describe("font loader presentation result", () => {
  it("reports the real bundled Latin and CJK stacks", () => {
    expect(builtinTypographyResult("warm-editorial")).toMatchObject({
      uiFamilies: "Source Sans 3 / Noto Sans SC",
      displayFamilies: "Newsreader / Noto Serif SC",
    });
  });

  it("reports actual fallbacks when custom resources are not selected", async () => {
    const result = await applyCustomTypography({
      ...DEFAULT_APPEARANCE,
      typography: { ...DEFAULT_APPEARANCE.typography, preset: "custom", uiFontId: null, displayFontId: null },
    }, { fonts: [], iconPacks: [], iconOverrides: [] });
    expect(result).toEqual({ warnings: [], uiFamilies: "Noto Sans SC", displayFamilies: "Noto Serif SC" });
  });
});
