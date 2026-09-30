import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AppearanceResourceStore, inspectFontBuffer } from "./appearance-resources";
import { createTestPng, writeTestZip } from "./zip-test-utils";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../../node_modules/@fontsource");
const latinFont = join(fixtures, "source-sans-3/files/source-sans-3-latin-400-normal.woff2");
const chineseFont = join(fixtures, "noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff2");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "wallpaper-appearance-"));
  temporaryDirectories.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("appearance font resources", () => {
  it("validates signatures, parses names, and reports Chinese coverage", async () => {
    const latin = inspectFontBuffer(latinFont, await readFile(latinFont));
    expect(latin.metadata.familyName).toMatch(/Source Sans 3/i);
    expect(latin.metadata.format).toBe("woff2");
    expect(latin.metadata.hasChineseCoverage).toBe(false);
    expect(latin.metadata.warnings).toHaveLength(1);

    const chinese = inspectFontBuffer(chineseFont, await readFile(chineseFont));
    expect(chinese.metadata.familyName).toMatch(/Noto Sans SC/i);
    expect(chinese.metadata.hasChineseCoverage).toBe(true);
  });

  it("rejects mismatched signatures, malformed fonts, and oversized input", async () => {
    expect(() => inspectFontBuffer("invalid.ttf", Buffer.from("OTTOinvalid"))).toThrowError(expect.objectContaining({ code: "E_FONT_FORMAT" }));
    expect(() => inspectFontBuffer("invalid.woff2", Buffer.from("wOF2invalid"))).toThrowError(expect.objectContaining({ code: "E_FONT_PARSE" }));
    expect(() => inspectFontBuffer("large.ttf", Buffer.alloc(32 * 1024 * 1024 + 1))).toThrowError(expect.objectContaining({ code: "E_FONT_SIZE" }));
  });

  it("previews, commits, reads, deduplicates, cancels, and deletes fonts", async () => {
    const root = await temporaryDirectory();
    const store = new AppearanceResourceStore(root);
    await store.initialize();

    const firstPreview = await store.previewFont(latinFont);
    expect(firstPreview.previewData.byteLength).toBeGreaterThan(0);
    const committed = await store.commitFont(firstPreview.importId);
    expect(committed.id).toMatch(/^font-[a-f0-9]{32}$/);
    expect(store.catalog().fonts).toEqual([committed]);
    expect(await store.readFont(committed.id)).toEqual(new Uint8Array(await readFile(latinFont)));

    const duplicatePreview = await store.previewFont(latinFont);
    expect(await store.commitFont(duplicatePreview.importId)).toEqual(committed);
    expect(store.catalog().fonts).toHaveLength(1);

    const cancelledPreview = await store.previewFont(latinFont);
    await store.cancelImport(cancelledPreview.importId);
    await expect(store.commitFont(cancelledPreview.importId)).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });

    await store.deleteFont(committed.id);
    expect(store.catalog().fonts).toEqual([]);
    await expect(store.readFont(committed.id)).rejects.toMatchObject({ code: "E_INPUT_NOT_FOUND" });
  });

  it("backs up a corrupt catalog and rebuilds an empty index", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "resources.json"), "{not-json", "utf8").catch(async () => {
      const store = new AppearanceResourceStore(root);
      await store.initialize();
      await writeFile(join(root, "resources.json"), "{not-json", "utf8");
    });
    const store = new AppearanceResourceStore(root);
    await store.initialize();

    expect(store.catalog()).toEqual({ fonts: [], iconPacks: [], iconOverrides: [] });
    const entries = await readdir(root);
    expect(entries.some((entry) => entry.startsWith("resources.json.corrupt-"))).toBe(true);
    expect(JSON.parse(await readFile(join(root, "resources.json"), "utf8"))).toEqual({ schemaVersion: 1, fonts: [], iconPacks: [], iconOverrides: [] });
  });

  it("commits only sanitized icon-pack JSON and revalidates it on read", async () => {
    const root = await temporaryDirectory();
    const archive = join(root, "safe-icons.zip");
    await writeTestZip(archive, [
      { path: "manifest.json", data: JSON.stringify({ schemaVersion: 1, name: "Safe Outline", version: "1.0.0", style: "outline", defaultSize: 20, icons: { settings: "icons/settings.svg" } }) },
      { path: "icons/settings.svg", data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="6"/></svg>' },
    ]);
    const store = new AppearanceResourceStore(join(root, "resources"));
    await store.initialize();
    const preview = await store.previewIconPack(archive);
    expect(preview.pack.icons.settings?.nodes[0]).toMatchObject({ tag: "circle", attributes: { r: 6 } });
    const committed = await store.commitIconPack(preview.importId);
    expect(committed.id).toMatch(/^icon-pack-[a-f0-9]{32}$/);
    expect(store.catalog().iconPacks).toEqual([committed]);
    const restored = await store.readIconPack(committed.id);
    expect(restored).toEqual(preview.pack);
    const stored = await readFile(join(root, "resources", "icon-packs", `${committed.id}.json`), "utf8");
    expect(stored).not.toContain("<svg");
    expect(stored).toContain('"tag": "circle"');
    await store.deleteIconPack(committed.id);
    expect(store.catalog().iconPacks).toEqual([]);
    await expect(store.readIconPack(committed.id)).rejects.toMatchObject({ code: "E_INPUT_NOT_FOUND" });
  });

  it("manages sanitized SVG overrides and validated PNG overrides", async () => {
    const root = await temporaryDirectory();
    const resourceRoot = join(root, "resources");
    const svgPath = join(root, "settings.svg");
    const pngPath = join(root, "logo.png");
    await writeFile(svgPath, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 12h16"/></svg>');
    await writeFile(pngPath, createTestPng(32, 24));
    const store = new AppearanceResourceStore(resourceRoot);
    await store.initialize();

    const svgPreview = await store.previewIconOverride(svgPath, "settings");
    expect(svgPreview.kind).toBe("vector");
    const svgMetadata = await store.commitIconOverride(svgPreview.importId);
    expect(svgMetadata.id).toMatch(/^icon-[a-f0-9]{32}$/);
    expect(await store.readIconOverride(svgMetadata.id)).toMatchObject({ kind: "vector", icon: { nodes: [{ tag: "path" }] } });

    await expect(store.previewIconOverride(pngPath, "settings")).rejects.toMatchObject({ code: "E_ICON_PNG" });
    const pngPreview = await store.previewIconOverride(pngPath, "appLogo");
    expect(pngPreview).toMatchObject({ kind: "png", width: 32, height: 24 });
    const pngMetadata = await store.commitIconOverride(pngPreview.importId);
    const pngResource = await store.readIconOverride(pngMetadata.id);
    expect(pngResource).toMatchObject({ kind: "png", width: 32, height: 24 });
    expect(store.catalog().iconOverrides).toHaveLength(2);

    await store.deleteIconOverride(svgMetadata.id);
    expect(store.catalog().iconOverrides).toEqual([pngMetadata]);
    await expect(store.readIconOverride(svgMetadata.id)).rejects.toMatchObject({ code: "E_INPUT_NOT_FOUND" });
  });

  it("cleans stale staged imports on startup and reports progress", async () => {
    const root = await temporaryDirectory();
    const resourceRoot = join(root, "resources");
    const first = new AppearanceResourceStore(resourceRoot);
    await first.initialize();
    const progress: number[] = [];
    await first.previewFont(latinFont, { onProgress: (_stage, percent) => progress.push(percent) });
    expect(progress).toEqual([10, 55, 100]);
    expect((await readdir(join(resourceRoot, "temp"))).length).toBe(1);

    const restarted = new AppearanceResourceStore(resourceRoot);
    await restarted.initialize();
    expect(await readdir(join(resourceRoot, "temp"))).toEqual([]);
  });
});
