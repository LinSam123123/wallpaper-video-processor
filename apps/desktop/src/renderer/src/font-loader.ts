import type { AppearanceResourceCatalog, FontImportPreview, FontResourceMetadata } from "../../shared/contracts";
import type { AppearanceSettings } from "./appearance";

const loadedFaces = new Map<string, Promise<FontFace>>();
const previewFaces = new Map<string, FontFace>();
let typographyApplication = 0;

export interface AppliedTypographyResult {
  warnings: string[];
  uiFamilies: string;
  displayFamilies: string;
}

const BUILTIN_FAMILIES: Record<AppearanceSettings["typography"]["preset"], { ui: string; display: string }> = {
  "standard-clear": { ui: "Noto Sans SC", display: "Noto Serif SC" },
  humanist: { ui: "Source Sans 3 / Noto Sans SC", display: "Noto Serif SC" },
  "warm-editorial": { ui: "Source Sans 3 / Noto Sans SC", display: "Newsreader / Noto Serif SC" },
  custom: { ui: "Noto Sans SC", display: "Noto Serif SC" },
};

export function builtinTypographyResult(preset: AppearanceSettings["typography"]["preset"]): AppliedTypographyResult {
  const builtin = BUILTIN_FAMILIES[preset];
  return { warnings: [], uiFamilies: builtin.ui, displayFamilies: builtin.display };
}

function alias(id: string): string {
  return `WallpaperUserFont-${id.replace(/[^a-zA-Z0-9-]/g, "")}`;
}

async function loadFace(font: FontResourceMetadata): Promise<FontFace> {
  const cached = loadedFaces.get(font.id);
  if (cached) return await cached;
  const loading = (async () => {
    const bytes = await window.wallpaperApi.readFontResource(font.id);
    const copy = new Uint8Array(bytes).slice().buffer;
    const face = new FontFace(alias(font.id), copy, { display: "swap" });
    await face.load();
    document.fonts.add(face);
    return face;
  })();
  loadedFaces.set(font.id, loading);
  try {
    return await loading;
  } catch (error) {
    loadedFaces.delete(font.id);
    throw error;
  }
}

export async function loadPreviewFont(preview: FontImportPreview): Promise<string> {
  const existing = previewFaces.get(preview.importId);
  if (existing) return existing.family;
  const face = new FontFace(alias(`preview-${preview.importId}`), new Uint8Array(preview.previewData).slice().buffer, { display: "swap" });
  await face.load();
  document.fonts.add(face);
  previewFaces.set(preview.importId, face);
  return face.family;
}

export function releasePreviewFont(importId: string): void {
  const face = previewFaces.get(importId);
  if (face) document.fonts.delete(face);
  previewFaces.delete(importId);
}

export async function applyCustomTypography(settings: AppearanceSettings, catalog: AppearanceResourceCatalog): Promise<AppliedTypographyResult> {
  const application = ++typographyApplication;
  const root = document.documentElement;
  if (settings.typography.preset !== "custom") {
    root.style.removeProperty("--custom-font-ui");
    root.style.removeProperty("--custom-font-display");
    return builtinTypographyResult(settings.typography.preset);
  }
  const warnings: string[] = [];
  const ui = catalog.fonts.find((font) => font.id === settings.typography.uiFontId);
  const display = catalog.fonts.find((font) => font.id === settings.typography.displayFontId);
  const [uiFace, displayFace] = await Promise.all([
    ui ? loadFace(ui).catch(() => { warnings.push(`无法加载界面字体“${ui.familyName}”`); return null; }) : Promise.resolve(null),
    display ? loadFace(display).catch(() => { warnings.push(`无法加载展示字体“${display.familyName}”`); return null; }) : Promise.resolve(null),
  ]);
  if (application !== typographyApplication) {
    return {
      warnings: [],
      uiFamilies: ui?.familyName ?? BUILTIN_FAMILIES.custom.ui,
      displayFamilies: display?.familyName ?? BUILTIN_FAMILIES.custom.display,
    };
  }
  if (uiFace) root.style.setProperty("--custom-font-ui", `"${uiFace.family}"`);
  else root.style.removeProperty("--custom-font-ui");
  if (displayFace) root.style.setProperty("--custom-font-display", `"${displayFace.family}"`);
  else root.style.removeProperty("--custom-font-display");
  return {
    warnings,
    uiFamilies: uiFace && ui ? ui.familyName : BUILTIN_FAMILIES.custom.ui,
    displayFamilies: displayFace && display ? display.familyName : BUILTIN_FAMILIES.custom.display,
  };
}
