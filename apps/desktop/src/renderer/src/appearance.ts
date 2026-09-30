export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemeMode, "system">;
export type AccentPreset = "orange" | "green" | "blue" | "purple" | "rose" | "custom";
export type TypographyPreset = "standard-clear" | "humanist" | "warm-editorial" | "custom";
export type TypographyTitleScope = "product-only" | "product-and-major" | "all-titles";
export type IconPreset = "fine-outline" | "soft-outline" | "custom";

export interface TypographySettings {
  preset: TypographyPreset;
  titleScope: TypographyTitleScope;
  uiFontId: string | null;
  displayFontId: string | null;
}

export interface IconSettings {
  preset: IconPreset;
  packId: string | null;
  overrides: Partial<Record<SemanticIconName, string>>;
}

export interface AppearanceSettings {
  version: 2;
  themeMode: ThemeMode;
  accent: AccentPreset;
  customAccent: string;
  typography: TypographySettings;
  icons: IconSettings;
}

interface LegacyAppearanceSettings {
  version: 1;
  themeMode: ThemeMode;
  accent: AccentPreset;
  customAccent: string;
}

export interface AccentColors {
  primary: string;
  hover: string;
  pressed: string;
  soft: string;
  focus: string;
  foreground: "#ffffff" | "#171614";
}

type AppearanceStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>;

export const APPEARANCE_STORAGE_KEY = "wallpaper.appearance.v2";
export const LEGACY_APPEARANCE_STORAGE_KEY = "wallpaper.appearance.v1";
export const APPEARANCE_BACKUP_PREFIX = "wallpaper.appearance.backup.";

export const DEFAULT_TYPOGRAPHY: TypographySettings = {
  preset: "standard-clear",
  titleScope: "product-and-major",
  uiFontId: null,
  displayFontId: null,
};

export const DEFAULT_ICONS: IconSettings = {
  preset: "fine-outline",
  packId: null,
  overrides: {},
};

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  version: 2,
  themeMode: "system",
  accent: "orange",
  customAccent: "#d97757",
  typography: { ...DEFAULT_TYPOGRAPHY },
  icons: { ...DEFAULT_ICONS, overrides: {} },
};

export const TYPOGRAPHY_PRESETS: Record<Exclude<TypographyPreset, "custom">, { label: string; description: string }> = {
  "standard-clear": { label: "标准清晰", description: "延续当前界面的清晰系统字体" },
  humanist: { label: "温润人文", description: "柔和的无衬线正文与克制标题" },
  "warm-editorial": { label: "温暖编辑感", description: "编辑式衬线标题与稳定无衬线控件" },
};

export const ACCENT_PRESETS: Record<Exclude<AccentPreset, "custom">, { label: string; light: string; dark: string }> = {
  orange: { label: "暖橙", light: "#d97757", dark: "#e58a68" },
  green: { label: "青绿", light: "#477a70", dark: "#6fa89c" },
  blue: { label: "海蓝", light: "#4f78b8", dark: "#78a0d8" },
  purple: { label: "紫色", light: "#7b67b2", dark: "#a18ddb" },
  rose: { label: "玫红", light: "#b85f78", dark: "#db839b" },
};

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
const RESOURCE_ID_PATTERN = /^(?:font|icon-pack|icon)-[a-f0-9]{32}$/;
const THEMES: ThemeMode[] = ["system", "light", "dark"];
const ACCENTS: AccentPreset[] = ["orange", "green", "blue", "purple", "rose", "custom"];
const TYPOGRAPHY: TypographyPreset[] = ["standard-clear", "humanist", "warm-editorial", "custom"];
const TITLE_SCOPES: TypographyTitleScope[] = ["product-only", "product-and-major", "all-titles"];
const ICONS: IconPreset[] = ["fine-outline", "soft-outline", "custom"];

function copyDefault(): AppearanceSettings {
  return {
    ...DEFAULT_APPEARANCE,
    typography: { ...DEFAULT_TYPOGRAPHY },
    icons: { ...DEFAULT_ICONS, overrides: {} },
  };
}

function resourceId(value: unknown): string | null {
  return typeof value === "string" && RESOURCE_ID_PATTERN.test(value) ? value : null;
}

function parseV2(value: unknown): AppearanceSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 2 || !THEMES.includes(candidate.themeMode as ThemeMode) || !ACCENTS.includes(candidate.accent as AccentPreset)) return null;
  const typography = candidate.typography as Record<string, unknown> | null;
  const icons = candidate.icons as Record<string, unknown> | null;
  if (!typography || Array.isArray(typography) || !TYPOGRAPHY.includes(typography.preset as TypographyPreset) ||
      !icons || Array.isArray(icons) || !ICONS.includes(icons.preset as IconPreset)) return null;
  const overrides = icons.overrides && typeof icons.overrides === "object" && !Array.isArray(icons.overrides)
    ? Object.fromEntries(Object.entries(icons.overrides).filter(([key, entry]) => isSemanticIconName(key) && resourceId(entry))) as Partial<Record<SemanticIconName, string>>
    : {};
  return {
    version: 2,
    themeMode: candidate.themeMode as ThemeMode,
    accent: candidate.accent as AccentPreset,
    customAccent: typeof candidate.customAccent === "string" && HEX_PATTERN.test(candidate.customAccent)
      ? candidate.customAccent.toLowerCase()
      : DEFAULT_APPEARANCE.customAccent,
    typography: {
      preset: typography.preset as TypographyPreset,
      titleScope: TITLE_SCOPES.includes(typography.titleScope as TypographyTitleScope)
        ? typography.titleScope as TypographyTitleScope
        : DEFAULT_TYPOGRAPHY.titleScope,
      uiFontId: resourceId(typography.uiFontId),
      displayFontId: resourceId(typography.displayFontId),
    },
    icons: {
      preset: icons.preset as IconPreset,
      packId: resourceId(icons.packId),
      overrides,
    },
  };
}

function parseLegacy(value: unknown): LegacyAppearanceSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<LegacyAppearanceSettings>;
  if (candidate.version !== 1 || !THEMES.includes(candidate.themeMode as ThemeMode) || !ACCENTS.includes(candidate.accent as AccentPreset)) return null;
  return {
    version: 1,
    themeMode: candidate.themeMode as ThemeMode,
    accent: candidate.accent as AccentPreset,
    customAccent: typeof candidate.customAccent === "string" && HEX_PATTERN.test(candidate.customAccent)
      ? candidate.customAccent.toLowerCase()
      : DEFAULT_APPEARANCE.customAccent,
  };
}

function migrateLegacy(value: LegacyAppearanceSettings): AppearanceSettings {
  return {
    ...copyDefault(),
    themeMode: value.themeMode,
    accent: value.accent,
    customAccent: value.customAccent,
  };
}

export function parseAppearance(value: unknown): AppearanceSettings {
  const legacy = parseLegacy(value);
  return parseV2(value) ?? (legacy ? migrateLegacy(legacy) : copyDefault());
}

function backupInvalid(storage: AppearanceStorage, raw: string): void {
  if (!storage.setItem) return;
  try {
    storage.setItem(`${APPEARANCE_BACKUP_PREFIX}${Date.now()}`, raw.slice(0, 65_536));
  } catch {
    // A full localStorage must not prevent the app from starting.
  }
}

export function loadAppearance(storage: AppearanceStorage = window.localStorage): AppearanceSettings {
  const current = storage.getItem(APPEARANCE_STORAGE_KEY);
  if (current !== null) {
    try {
      const parsed = parseV2(JSON.parse(current) as unknown);
      if (parsed) return parsed;
    } catch {
      // Back up below.
    }
    backupInvalid(storage, current);
    return copyDefault();
  }
  const legacy = storage.getItem(LEGACY_APPEARANCE_STORAGE_KEY);
  if (legacy === null) return copyDefault();
  try {
    const parsed = parseLegacy(JSON.parse(legacy) as unknown);
    if (!parsed) throw new Error("Unsupported legacy appearance settings");
    const migrated = migrateLegacy(parsed);
    storage.setItem?.(APPEARANCE_STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    backupInvalid(storage, legacy);
    return copyDefault();
  }
}

export function saveAppearance(settings: AppearanceSettings, storage: Pick<Storage, "setItem"> = window.localStorage): void {
  storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(parseAppearance(settings)));
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function toHex(value: number): string {
  return Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0");
}

export function mixHex(a: string, b: string, amount: number): string {
  const [fromR, fromG, fromB] = rgb(a);
  const [toR, toG, toB] = rgb(b);
  const ratio = Math.max(0, Math.min(1, amount));
  return `#${[
    toHex(fromR + (toR - fromR) * ratio),
    toHex(fromG + (toG - fromG) * ratio),
    toHex(fromB + (toB - fromB) * ratio),
  ].join("")}`;
}

function luminance(hex: string): number {
  const [red, green, blue] = rgb(hex).map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

export function contrastRatio(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function customAccentError(hex: string, theme: ResolvedTheme): string | null {
  if (!HEX_PATTERN.test(hex)) return "请输入完整的 6 位 HEX 色值，例如 #D97757。";
  const normalized = hex.toLowerCase();
  const surface = theme === "dark" ? "#282521" : "#ffffff";
  if (contrastRatio(normalized, surface) < 3) return "该颜色与当前界面的对比度不足，请选择更清晰的颜色。";
  return null;
}

export function accentColors(settings: AppearanceSettings, theme: ResolvedTheme): AccentColors {
  const base = settings.accent === "custom" ? settings.customAccent.toLowerCase() : ACCENT_PRESETS[settings.accent][theme];
  const foreground = contrastRatio(base, "#ffffff") >= 4.5 ? "#ffffff" : "#171614";
  const toward = theme === "dark" ? "#ffffff" : "#171614";
  return {
    primary: base,
    hover: mixHex(base, toward, theme === "dark" ? 0.1 : 0.09),
    pressed: mixHex(base, toward, theme === "dark" ? 0.12 : 0.18),
    soft: mixHex(base, theme === "dark" ? "#201e1b" : "#ffffff", theme === "dark" ? 0.75 : 0.78),
    focus: `${base}57`,
    foreground,
  };
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

export function applyAppearance(settings: AppearanceSettings, systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches): ResolvedTheme {
  const theme = resolveTheme(settings.themeMode, systemDark);
  const colors = accentColors(settings, theme);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = settings.accent;
  root.dataset.typography = settings.typography.preset;
  root.dataset.titleScope = settings.typography.titleScope;
  root.dataset.iconStyle = settings.icons.preset;
  root.style.setProperty("--primary", colors.primary);
  root.style.setProperty("--primary-hover", colors.hover);
  root.style.setProperty("--primary-pressed", colors.pressed);
  root.style.setProperty("--primary-soft", colors.soft);
  root.style.setProperty("--focus-ring", colors.focus);
  root.style.setProperty("--on-primary", colors.foreground);
  return theme;
}

export function initializeAppearance(): AppearanceSettings {
  const settings = loadAppearance();
  applyAppearance(settings);
  return settings;
}
import { isSemanticIconName, type SemanticIconName } from "../../shared/appearance-icons";
