import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectIconPack, parseIconManifest, sanitizeSvg, validateSanitizedIconPack } from "./icon-pack";
import { writeTestZip, type TestZipEntry } from "./zip-test-utils";

const temporaryDirectories: string[] = [];

async function archive(entries: TestZipEntry[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-icon-security-"));
  temporaryDirectories.push(root);
  const path = join(root, "icons.zip");
  await writeTestZip(path, entries);
  return path;
}

afterEach(async () => await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true }))));

const manifest = (icons = '"settings":"icons/settings.svg"'): string => `{
  "schemaVersion": 1,
  "name": "Warm Outline",
  "version": "1.0.0",
  "style": "outline",
  "defaultSize": 20,
  "icons": {${icons}}
}`;

describe("safe icon pack parsing", () => {
  it("accepts a strict partial semantic manifest", () => {
    expect(parseIconManifest(manifest())).toMatchObject({
      name: "Warm Outline",
      style: "outline",
      defaultSize: 20,
      icons: { settings: "icons/settings.svg" },
    });
  });

  it("rejects duplicate keys, unknown fields, semantics, and unsafe paths", () => {
    expect(() => parseIconManifest(manifest('"settings":"icons/a.svg","settings":"icons/b.svg"'))).toThrowError(expect.objectContaining({ code: "E_ICON_MANIFEST" }));
    expect(() => parseIconManifest(manifest('"notARealSemantic":"icons/a.svg"'))).toThrowError(expect.objectContaining({ code: "E_ICON_MANIFEST" }));
    expect(() => parseIconManifest(manifest('"settings":"../a.svg"'))).toThrowError(expect.objectContaining({ code: "E_ICON_MANIFEST" }));
    expect(() => parseIconManifest(manifest().replace('"icons":', '"extra":true,"icons":'))).toThrowError(expect.objectContaining({ code: "E_ICON_MANIFEST" }));
  });

  it("turns an outline SVG into structured nodes without preserving markup", () => {
    const icon = sanitizeSvg('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M4 12h16" stroke-linecap="round"/><circle cx="12" cy="12" r="3"/></svg>');
    expect(icon.viewBox).toEqual([0, 0, 24, 24]);
    expect(icon.attributes).toEqual({ fill: "none", stroke: "currentColor", strokeWidth: 1.75 });
    expect(icon.nodes).toEqual([
      { tag: "path", attributes: { d: "M4 12h16", strokeLinecap: "round" }, children: [] },
      { tag: "circle", attributes: { cx: 12, cy: 12, r: 3 }, children: [] },
    ]);
    expect(JSON.stringify(icon)).not.toContain("<svg");
  });

  it.each([
    '<svg viewBox="0 0 24 24"><script>alert(1)</script><path d="M0 0"/></svg>',
    '<svg viewBox="0 0 24 24"><path onclick="run()" d="M0 0"/></svg>',
    '<svg viewBox="0 0 24 24"><path style="stroke:red" d="M0 0"/></svg>',
    '<svg viewBox="0 0 24 24"><path stroke="url(#paint)" d="M0 0"/></svg>',
    '<svg viewBox="0 0 24 24"><animate attributeName="opacity"/></svg>',
    '<svg viewBox="0 0 24 24"><use href="https://example.test/x.svg#x"/></svg>',
  ])("rejects active or referential SVG content", (svg) => {
    expect(() => sanitizeSvg(svg)).toThrowError(expect.objectContaining({ code: "E_ICON_SVG" }));
  });

  it("warns for fixed colors and unusual viewBoxes and rejects excessive paths", () => {
    const warned = sanitizeSvg('<svg viewBox="0 0 1000 10"><path fill="#000" stroke="#fff" d="M0 0L1 1"/></svg>');
    expect(warned.warnings.join(" ")).toMatch(/viewBox/);
    expect(warned.warnings.join(" ")).toMatch(/多种固定颜色/);
    const commands = "M0 0".repeat(1025);
    expect(() => sanitizeSvg(`<svg viewBox="0 0 24 24"><path d="${commands}"/></svg>`)).toThrowError(expect.objectContaining({ code: "E_ICON_COMPLEXITY" }));
  });

  it("revalidates structured resources before returning them to the renderer", () => {
    const icon = sanitizeSvg('<svg viewBox="0 0 24 24"><path d="M4 4L20 20"/></svg>');
    const pack = validateSanitizedIconPack({ schemaVersion: 1, name: "Safe Pack", version: "1", defaultSize: 20, icons: { settings: icon }, warnings: [] });
    expect(pack.icons.settings).toEqual(icon);
    expect(() => validateSanitizedIconPack({ ...pack, icons: { settings: { ...icon, nodes: [{ tag: "script", attributes: {}, children: [] }] } } })).toThrowError(expect.objectContaining({ code: "E_ICON_RESOURCE" }));
  });

  it.each([
    "../escape.svg",
    "/absolute.svg",
    "C:/absolute.svg",
    "icons\\backslash.svg",
    "icons/../escape.svg",
    "icons/tool.exe",
  ])("rejects unsafe or disallowed ZIP paths: %s", async (path) => {
    await expect(inspectIconPack(await archive([{ path: "manifest.json", data: manifest() }, { path, data: "x" }]))).rejects.toMatchObject({ code: "E_ICON_ZIP_PATH" });
  });

  it("rejects duplicate, encrypted, linked, special, and unsupported-compression entries", async () => {
    await expect(inspectIconPack(await archive([{ path: "manifest.json", data: manifest() }, { path: "manifest.json", data: manifest() }]))).rejects.toMatchObject({ code: "E_ICON_ZIP_PATH" });
    await expect(inspectIconPack(await archive([{ path: "manifest.json", data: manifest(), flags: 1 }]))).rejects.toMatchObject({ code: "E_ICON_ZIP" });
    await expect(inspectIconPack(await archive([{ path: "manifest.json", data: manifest(), externalFileAttributes: (0o120777 << 16) >>> 0 }]))).rejects.toMatchObject({ code: "E_ICON_ZIP" });
    await expect(inspectIconPack(await archive([{ path: "manifest.json", data: manifest(), externalFileAttributes: (0o020666 << 16) >>> 0 }]))).rejects.toMatchObject({ code: "E_ICON_ZIP" });
    await expect(inspectIconPack(await archive([{ path: "manifest.json", data: manifest(), method: 12 }]))).rejects.toMatchObject({ code: "E_ICON_ZIP" });
  });

  it("rejects entry-count, per-file, and total expanded-size bombs before extraction", async () => {
    const tooMany = Array.from({ length: 257 }, (_, index) => ({ path: index === 0 ? "manifest.json" : `icons/${index}.svg`, data: index === 0 ? manifest() : "<svg/>" }));
    await expect(inspectIconPack(await archive(tooMany))).rejects.toMatchObject({ code: "E_ICON_SIZE" });
    await expect(inspectIconPack(await archive([{ path: "manifest.json", data: manifest(), declaredUncompressedSize: 65 * 1024 }]))).rejects.toMatchObject({ code: "E_ICON_SIZE" });
    await expect(inspectIconPack(await archive([{ path: "manifest.json", data: manifest() }, { path: "icons/settings.svg", data: "x", declaredUncompressedSize: 129 * 1024 }]))).rejects.toMatchObject({ code: "E_ICON_SIZE" });
    await expect(inspectIconPack(await archive([{ path: "manifest.json", data: manifest() }, { path: "icons/settings.svg", data: "x", declaredUncompressedSize: 8 * 1024 * 1024 }]))).rejects.toMatchObject({ code: "E_ICON_SIZE" });
  });

  it("supports store and deflate only and reports cancellable sanitization progress", async () => {
    const path = await archive([
      { path: "manifest.json", data: manifest(), method: 8 },
      { path: "icons/settings.svg", data: '<svg viewBox="0 0 24 24"><path d="M1 1L2 2"/></svg>', method: 8 },
    ]);
    const progress: number[] = [];
    const result = await inspectIconPack(path, { onProgress: (_stage, percent) => progress.push(percent) });
    expect(result.pack.icons.settings).toBeDefined();
    expect(progress.length).toBeGreaterThan(3);
    const controller = new AbortController();
    controller.abort();
    await expect(inspectIconPack(path, { signal: controller.signal })).rejects.toMatchObject({ code: "E_IMPORT_CANCELLED" });
  });
});
