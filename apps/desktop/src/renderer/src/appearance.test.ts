import { beforeEach, describe, expect, it } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  APPEARANCE_BACKUP_PREFIX,
  DEFAULT_APPEARANCE,
  LEGACY_APPEARANCE_STORAGE_KEY,
  accentColors,
  applyAppearance,
  contrastRatio,
  customAccentError,
  loadAppearance,
  mixHex,
  parseAppearance,
  saveAppearance,
  type AppearanceSettings,
} from "./appearance";

describe("appearance settings", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-typography");
    document.documentElement.removeAttribute("data-title-scope");
    document.documentElement.removeAttribute("data-icon-style");
    document.documentElement.removeAttribute("style");
  });

  it("falls back safely when persisted settings are malformed", () => {
    expect(parseAppearance({ version: 9, themeMode: "neon" })).toEqual(DEFAULT_APPEARANCE);
    localStorage.setItem(APPEARANCE_STORAGE_KEY, "not-json");
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
    expect(Object.keys(localStorage).some((key) => key.startsWith(APPEARANCE_BACKUP_PREFIX))).toBe(true);
  });

  it("persists and restores a versioned appearance", () => {
    const settings: AppearanceSettings = { ...DEFAULT_APPEARANCE, themeMode: "dark", accent: "blue", customAccent: "#123456" };
    saveAppearance(settings);
    expect(loadAppearance()).toEqual(settings);
  });

  it("adds the default title scope to older v2 data and preserves valid appearance fields", () => {
    const olderV2 = {
      ...DEFAULT_APPEARANCE,
      typography: { preset: "warm-editorial", uiFontId: null, displayFontId: null },
    };
    expect(parseAppearance(olderV2).typography.titleScope).toBe("product-and-major");
    expect(parseAppearance({
      ...DEFAULT_APPEARANCE,
      themeMode: "dark",
      typography: { ...DEFAULT_APPEARANCE.typography, titleScope: "unknown" },
    })).toMatchObject({ themeMode: "dark", typography: { titleScope: "product-and-major" } });
  });

  it("keeps only recognized semantic icon overrides", () => {
    const iconId = `icon-${"a".repeat(32)}`;
    const parsed = parseAppearance({
      ...DEFAULT_APPEARANCE,
      icons: { preset: "custom", packId: null, overrides: { settings: iconId, arbitraryMarkup: iconId } },
    });
    expect(parsed.icons.overrides).toEqual({ settings: iconId });
  });

  it("migrates v1 without changing the existing visual defaults", () => {
    localStorage.setItem(LEGACY_APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, themeMode: "dark", accent: "green", customAccent: "#123456" }));
    expect(loadAppearance()).toEqual({ ...DEFAULT_APPEARANCE, themeMode: "dark", accent: "green", customAccent: "#123456" });
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toContain('"version":2');
  });

  it("derives readable states and applies them to the root without re-rendering", () => {
    const settings: AppearanceSettings = { ...DEFAULT_APPEARANCE, themeMode: "system", accent: "rose" };
    expect(applyAppearance(settings, true)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.accent).toBe("rose");
    expect(document.documentElement.dataset.typography).toBe("standard-clear");
    expect(document.documentElement.dataset.titleScope).toBe("product-and-major");
    expect(document.documentElement.dataset.iconStyle).toBe("fine-outline");
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("#db839b");
    expect(contrastRatio(accentColors(settings, "dark").primary, accentColors(settings, "dark").foreground)).toBeGreaterThanOrEqual(4.5);
  });

  it("mixes deterministic colors and rejects low-contrast custom accents", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(customAccentError("orange", "light")).toMatch(/HEX/);
    expect(customAccentError("#ffffff", "light")).toMatch(/对比度/);
    expect(customAccentError("#b84a41", "light")).toBeNull();
  });
});
