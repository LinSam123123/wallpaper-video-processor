import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import * as fontkit from "fontkit";
import type { Font, FontCollection } from "fontkit";
import type {
  AppearanceResourceCatalog,
  FontImportPreview,
  FontResourceFormat,
  FontResourceMetadata,
  IconPackImportPreview,
  IconPackMetadata,
  IconOverrideImportPreview,
  IconOverrideMetadata,
  IconOverrideResource,
  SafeVectorIcon,
  SanitizedIconPack,
} from "../shared/contracts.js";
import { inspectIconPack, sanitizeSvg, validateSanitizedIconPack } from "./icon-pack.js";
import { isSemanticIconName, type SemanticIconName } from "../shared/appearance-icons.js";

const CATALOG_VERSION = 1;
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const MAX_ICON_PACK_BYTES = 8 * 1024 * 1024;
const MAX_PNG_BYTES = 1024 * 1024;
const FONT_ID_PATTERN = /^font-[a-f0-9]{32}$/;
const ICON_PACK_ID_PATTERN = /^icon-pack-[a-f0-9]{32}$/;
const ICON_ID_PATTERN = /^icon-[a-f0-9]{32}$/;
const CHINESE_PROBE = "视频处理清晰度输出缓存设置文件画面循环";

interface StoredFont extends FontResourceMetadata {
  fileName: string;
}

interface StoredIconPack extends IconPackMetadata {
  fileName: string;
}

interface StoredIconOverride extends IconOverrideMetadata {
  fileName: string;
}

interface ResourceIndex {
  schemaVersion: 1;
  fonts: StoredFont[];
  iconPacks: StoredIconPack[];
  iconOverrides: StoredIconOverride[];
}

interface PendingFont {
  buffer: Buffer;
  extension: FontResourceFormat;
  metadata: Omit<FontResourceMetadata, "id">;
}

interface StagedFont extends Omit<PendingFont, "buffer"> {
  temporaryPath: string;
}

interface PendingIconPack {
  pack: SanitizedIconPack;
  metadata: Omit<IconPackMetadata, "id">;
  temporaryPath: string;
}

type PendingIconOverride =
  | { semanticName: SemanticIconName; kind: "vector"; icon: SafeVectorIcon; temporaryPath: string; sizeBytes: number; warnings: string[] }
  | { semanticName: "appLogo" | "emptyState"; kind: "png"; temporaryPath: string; sizeBytes: number; width: number; height: number; warnings: string[] };

export interface ResourceImportOptions {
  importId?: string;
  signal?: AbortSignal;
  onProgress?(stage: "reading" | "validating" | "sanitizing" | "ready", percent: number, message: string): void;
}

function resourceError(code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

function throwIfCancelled(options?: ResourceImportOptions): void {
  if (options?.signal?.aborted) throw resourceError("E_IMPORT_CANCELLED", "外观资源导入已取消");
}

function importProgress(options: ResourceImportOptions | undefined, stage: "reading" | "validating" | "sanitizing" | "ready", percent: number, message: string): void {
  throwIfCancelled(options);
  options?.onProgress?.(stage, percent, message);
}

function fontFormat(path: string, buffer: Buffer): FontResourceFormat {
  const extension = extname(path).slice(1).toLowerCase();
  const signature = buffer.subarray(0, 4).toString("ascii");
  const ttf = buffer.length >= 4 && (buffer.readUInt32BE(0) === 0x00010000 || signature === "true");
  if (extension === "ttf" && ttf) return "ttf";
  if (extension === "otf" && signature === "OTTO") return "otf";
  if (extension === "woff2" && signature === "wOF2") return "woff2";
  throw resourceError("E_FONT_FORMAT", "字体扩展名与文件签名不匹配，仅支持 TTF、OTF 和 WOFF2");
}

function isCollection(value: Font | FontCollection): value is FontCollection {
  return "fonts" in value;
}

export function inspectFontBuffer(path: string, buffer: Buffer): PendingFont {
  if (buffer.length === 0 || buffer.length > MAX_FONT_BYTES) {
    throw resourceError("E_FONT_SIZE", `字体文件必须小于或等于 ${MAX_FONT_BYTES / 1024 / 1024} MiB`);
  }
  const extension = fontFormat(path, buffer);
  let parsed: Font | FontCollection;
  try {
    parsed = fontkit.create(buffer);
  } catch (error) {
    throw resourceError("E_FONT_PARSE", "无法解析字体文件", { cause: error instanceof Error ? error.message : String(error) });
  }
  if (isCollection(parsed)) throw resourceError("E_FONT_FORMAT", "暂不支持字体集合，请选择单个 TTF、OTF 或 WOFF2 字体");
  const familyName = parsed.familyName?.trim().slice(0, 120);
  const fullName = parsed.fullName?.trim().slice(0, 160) || familyName;
  if (!familyName) throw resourceError("E_FONT_PARSE", "字体缺少可识别的家族名称");
  const missing = [...CHINESE_PROBE].filter((character) => !parsed.hasGlyphForCodePoint(character.codePointAt(0)!));
  const warnings = missing.length > 0 ? ["该字体缺少部分中文字符，将使用中文回退字体。"] : [];
  return {
    buffer,
    extension,
    metadata: {
      familyName,
      fullName,
      format: extension,
      sizeBytes: buffer.length,
      hasChineseCoverage: missing.length === 0,
      warnings,
    },
  };
}

function validStoredFont(value: unknown): value is StoredFont {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const font = value as Record<string, unknown>;
  return typeof font.id === "string" && FONT_ID_PATTERN.test(font.id) &&
    typeof font.fileName === "string" && font.fileName === `${font.id}.${String(font.format)}` &&
    typeof font.familyName === "string" && font.familyName.length > 0 && font.familyName.length <= 120 &&
    typeof font.fullName === "string" && font.fullName.length > 0 && font.fullName.length <= 160 &&
    ["ttf", "otf", "woff2"].includes(String(font.format)) &&
    typeof font.sizeBytes === "number" && font.sizeBytes > 0 && font.sizeBytes <= MAX_FONT_BYTES &&
    typeof font.hasChineseCoverage === "boolean" && Array.isArray(font.warnings) && font.warnings.every((entry) => typeof entry === "string");
}

function validStoredIconPack(value: unknown): value is StoredIconPack {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pack = value as Record<string, unknown>;
  return typeof pack.id === "string" && ICON_PACK_ID_PATTERN.test(pack.id) && pack.fileName === `${pack.id}.json` &&
    typeof pack.name === "string" && pack.name.length > 0 && pack.name.length <= 80 &&
    typeof pack.version === "string" && pack.version.length > 0 && pack.version.length <= 32 &&
    typeof pack.defaultSize === "number" && Number.isInteger(pack.defaultSize) && pack.defaultSize >= 16 && pack.defaultSize <= 24 &&
    Array.isArray(pack.iconNames) && pack.iconNames.length > 0 && pack.iconNames.every(isSemanticIconName) &&
    Array.isArray(pack.warnings) && pack.warnings.every((warning) => typeof warning === "string");
}

function validStoredIconOverride(value: unknown): value is StoredIconOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const icon = value as Record<string, unknown>;
  const kind = icon.kind === "vector" || icon.kind === "png" ? icon.kind : null;
  const semanticName = isSemanticIconName(icon.semanticName) ? icon.semanticName : null;
  return typeof icon.id === "string" && ICON_ID_PATTERN.test(icon.id) && kind !== null && semanticName !== null &&
    icon.fileName === `${icon.id}.${kind === "vector" ? "json" : "png"}` &&
    typeof icon.sizeBytes === "number" && icon.sizeBytes > 0 && icon.sizeBytes <= (kind === "png" ? MAX_PNG_BYTES : 128 * 1024) &&
    (kind !== "png" || ((semanticName === "appLogo" || semanticName === "emptyState") && Number.isInteger(icon.width) && Number(icon.width) >= 16 && Number(icon.width) <= 512 && Number.isInteger(icon.height) && Number(icon.height) >= 16 && Number(icon.height) <= 512)) &&
    Array.isArray(icon.warnings) && icon.warnings.every((warning) => typeof warning === "string");
}

function inspectPng(buffer: Buffer): { width: number; height: number; warnings: string[] } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || buffer.length > MAX_PNG_BYTES || !buffer.subarray(0, 8).equals(signature) || buffer.readUInt32BE(8) !== 13 || buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw resourceError("E_ICON_PNG", "PNG 文件签名或 IHDR 结构无效");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 16 || width > 512 || height < 16 || height > 512) throw resourceError("E_ICON_PNG", "PNG 尺寸必须位于 16–512px");
  const warnings: string[] = [];
  if (width !== height) warnings.push("PNG 不是正方形，将在固定图标视口中等比缩放。");
  return { width, height, warnings };
}

export class AppearanceResourceStore {
  readonly #root: string;
  readonly #fontsDirectory: string;
  readonly #iconPacksDirectory: string;
  readonly #iconOverridesDirectory: string;
  readonly #temporaryDirectory: string;
  readonly #indexPath: string;
  readonly #pendingFonts = new Map<string, StagedFont>();
  readonly #pendingIconPacks = new Map<string, PendingIconPack>();
  readonly #pendingIconOverrides = new Map<string, PendingIconOverride>();
  #index: ResourceIndex = { schemaVersion: CATALOG_VERSION, fonts: [], iconPacks: [], iconOverrides: [] };

  constructor(root: string) {
    this.#root = root;
    this.#fontsDirectory = join(root, "fonts");
    this.#iconPacksDirectory = join(root, "icon-packs");
    this.#iconOverridesDirectory = join(root, "icon-overrides");
    this.#temporaryDirectory = join(root, "temp");
    this.#indexPath = join(root, "resources.json");
  }

  async initialize(): Promise<void> {
    await rm(this.#temporaryDirectory, { recursive: true, force: true });
    await Promise.all([mkdir(this.#fontsDirectory, { recursive: true }), mkdir(this.#iconPacksDirectory, { recursive: true }), mkdir(this.#iconOverridesDirectory, { recursive: true }), mkdir(this.#temporaryDirectory, { recursive: true })]);
    try {
      const raw = await readFile(this.#indexPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const parsedIconPacks = parsed.iconPacks === undefined ? [] : parsed.iconPacks;
      const parsedIconOverrides = parsed.iconOverrides === undefined ? [] : parsed.iconOverrides;
      if (parsed.schemaVersion !== CATALOG_VERSION || !Array.isArray(parsed.fonts) || !parsed.fonts.every(validStoredFont) || !Array.isArray(parsedIconPacks) || !parsedIconPacks.every(validStoredIconPack) || !Array.isArray(parsedIconOverrides) || !parsedIconOverrides.every(validStoredIconOverride)) {
        throw new Error("Unsupported appearance resource index");
      }
      const fonts = await Promise.all(parsed.fonts.map(async (font) => await access(join(this.#fontsDirectory, font.fileName)).then(() => font, () => null)));
      const iconPacks = await Promise.all(parsedIconPacks.map(async (pack) => await access(join(this.#iconPacksDirectory, pack.fileName)).then(() => pack, () => null)));
      const iconOverrides = await Promise.all(parsedIconOverrides.map(async (icon) => await access(join(this.#iconOverridesDirectory, icon.fileName)).then(() => icon, () => null)));
      this.#index = {
        schemaVersion: CATALOG_VERSION,
        fonts: fonts.filter((font): font is StoredFont => font !== null),
        iconPacks: iconPacks.filter((pack): pack is StoredIconPack => pack !== null),
        iconOverrides: iconOverrides.filter((icon): icon is StoredIconOverride => icon !== null),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await rename(this.#indexPath, `${this.#indexPath}.corrupt-${Date.now()}`).catch(() => undefined);
      }
      this.#index = { schemaVersion: CATALOG_VERSION, fonts: [], iconPacks: [], iconOverrides: [] };
      await this.#save();
    }
  }

  catalog(): AppearanceResourceCatalog {
    return {
      fonts: this.#index.fonts.map(({ fileName: _fileName, ...font }) => ({ ...font, warnings: [...font.warnings] })),
      iconPacks: this.#index.iconPacks.map(({ fileName: _fileName, ...pack }) => ({ ...pack, iconNames: [...pack.iconNames], warnings: [...pack.warnings] })),
      iconOverrides: this.#index.iconOverrides.map(({ fileName: _fileName, ...icon }) => ({ ...icon, warnings: [...icon.warnings] })),
    };
  }

  async previewFont(path: string, options?: ResourceImportOptions): Promise<FontImportPreview> {
    importProgress(options, "reading", 10, "正在读取字体文件");
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size <= 0 || info.size > MAX_FONT_BYTES) throw resourceError("E_FONT_SIZE", "字体文件不存在或超过 32 MiB");
    const buffer = await readFile(path, { signal: options?.signal });
    importProgress(options, "validating", 55, "正在验证字体签名和字形覆盖");
    const inspected = inspectFontBuffer(path, buffer);
    const importId = options?.importId ?? randomUUID();
    const temporaryPath = join(this.#temporaryDirectory, `${importId}.font`);
    try { await writeFile(temporaryPath, inspected.buffer, { flag: "wx", signal: options?.signal }); } catch (error) { await rm(temporaryPath, { force: true }); throw error; }
    this.#pendingFonts.set(importId, { temporaryPath, extension: inspected.extension, metadata: inspected.metadata });
    importProgress(options, "ready", 100, "字体预览已就绪");
    return { importId, ...inspected.metadata, previewData: new Uint8Array(inspected.buffer) };
  }

  async commitFont(importId: string): Promise<FontResourceMetadata> {
    const pending = this.#pendingFonts.get(importId);
    if (!pending) throw resourceError("E_INVALID_ARGUMENT", "字体导入预览已失效，请重新选择文件");
    const buffer = await readFile(pending.temporaryPath);
    const digest = createHash("sha256").update(buffer).digest("hex");
    const id = `font-${digest.slice(0, 32)}`;
    const existing = this.#index.fonts.find((font) => font.id === id);
    if (existing) {
      this.#pendingFonts.delete(importId);
      await rm(pending.temporaryPath, { force: true });
      const { fileName: _fileName, ...metadata } = existing;
      return metadata;
    }
    const fileName = `${id}.${pending.extension}`;
    const destination = join(this.#fontsDirectory, fileName);
    try {
      await rename(pending.temporaryPath, destination);
      const stored: StoredFont = { id, fileName, ...pending.metadata };
      const previousIndex = this.#index;
      this.#index = { ...this.#index, fonts: [...this.#index.fonts, stored] };
      try {
        await this.#save();
      } catch (error) {
        this.#index = previousIndex;
        throw error;
      }
      this.#pendingFonts.delete(importId);
      const { fileName: _fileName, ...metadata } = stored;
      return metadata;
    } catch (error) {
      this.#pendingFonts.delete(importId);
      await rm(pending.temporaryPath, { force: true }).catch(() => undefined);
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async cancelImport(importId: string): Promise<void> {
    if (typeof importId !== "string" || importId.length > 128) {
      throw resourceError("E_INVALID_ARGUMENT", "导入 ID 无效");
    }
    const paths = [this.#pendingFonts.get(importId)?.temporaryPath, this.#pendingIconPacks.get(importId)?.temporaryPath, this.#pendingIconOverrides.get(importId)?.temporaryPath].filter((path): path is string => Boolean(path));
    this.#pendingFonts.delete(importId);
    this.#pendingIconPacks.delete(importId);
    this.#pendingIconOverrides.delete(importId);
    await Promise.all(paths.map(async (path) => await rm(path, { force: true })));
  }

  async previewIconPack(path: string, options?: ResourceImportOptions): Promise<IconPackImportPreview> {
    importProgress(options, "reading", 5, "正在读取图标包目录");
    const inspected = await inspectIconPack(path, options);
    const importId = options?.importId ?? randomUUID();
    const iconNames = Object.keys(inspected.pack.icons) as IconPackMetadata["iconNames"];
    const metadata = {
      name: inspected.pack.name,
      version: inspected.pack.version,
      defaultSize: inspected.pack.defaultSize,
      iconNames,
      warnings: [...inspected.pack.warnings],
    };
    const temporaryPath = join(this.#temporaryDirectory, `${importId}.icon-pack.json`);
    try { await writeFile(temporaryPath, `${JSON.stringify(inspected.pack, null, 2)}\n`, { encoding: "utf8", flag: "wx", signal: options?.signal }); } catch (error) { await rm(temporaryPath, { force: true }); throw error; }
    this.#pendingIconPacks.set(importId, { pack: inspected.pack, metadata, temporaryPath });
    importProgress(options, "ready", 100, "图标包预览已就绪");
    return { importId, ...metadata, pack: inspected.pack };
  }

  async commitIconPack(importId: string): Promise<IconPackMetadata> {
    const pending = this.#pendingIconPacks.get(importId);
    if (!pending) throw resourceError("E_INVALID_ARGUMENT", "图标包导入预览已失效，请重新选择文件");
    const serialized = await readFile(pending.temporaryPath);
    const digest = createHash("sha256").update(serialized).digest("hex");
    const id = `icon-pack-${digest.slice(0, 32)}`;
    const existing = this.#index.iconPacks.find((pack) => pack.id === id);
    if (existing) {
      this.#pendingIconPacks.delete(importId);
      await rm(pending.temporaryPath, { force: true });
      const { fileName: _fileName, ...metadata } = existing;
      return metadata;
    }
    const fileName = `${id}.json`;
    const destination = join(this.#iconPacksDirectory, fileName);
    try {
      await rename(pending.temporaryPath, destination);
      const stored: StoredIconPack = { id, fileName, ...pending.metadata };
      const previousIndex = this.#index;
      this.#index = { ...this.#index, iconPacks: [...this.#index.iconPacks, stored] };
      try {
        await this.#save();
      } catch (error) {
        this.#index = previousIndex;
        throw error;
      }
      this.#pendingIconPacks.delete(importId);
      const { fileName: _fileName, ...metadata } = stored;
      return metadata;
    } catch (error) {
      this.#pendingIconPacks.delete(importId);
      await rm(pending.temporaryPath, { force: true }).catch(() => undefined);
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async previewIconOverride(path: string, semanticName: SemanticIconName, options?: ResourceImportOptions): Promise<IconOverrideImportPreview> {
    if (!isSemanticIconName(semanticName)) throw resourceError("E_INVALID_ARGUMENT", "语义图标名称无效");
    importProgress(options, "reading", 15, "正在读取单图标文件");
    const extension = extname(path).toLowerCase();
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size <= 0) throw resourceError("E_INPUT_NOT_FOUND", "图标文件不存在");
    const buffer = await readFile(path, { signal: options?.signal });
    const importId = options?.importId ?? randomUUID();
    const temporaryPath = join(this.#temporaryDirectory, `${importId}.icon-override`);
    if (extension === ".png") {
      if (semanticName !== "appLogo" && semanticName !== "emptyState") throw resourceError("E_ICON_PNG", "PNG 仅可用于应用标志和空状态图标");
      importProgress(options, "validating", 60, "正在验证 PNG 签名和尺寸");
      const inspected = inspectPng(buffer);
      try { await writeFile(temporaryPath, buffer, { flag: "wx", signal: options?.signal }); } catch (error) { await rm(temporaryPath, { force: true }); throw error; }
      const pending: PendingIconOverride = { semanticName, kind: "png", temporaryPath, sizeBytes: buffer.length, ...inspected };
      this.#pendingIconOverrides.set(importId, pending);
      importProgress(options, "ready", 100, "PNG 图标预览已就绪");
      return { importId, semanticName, kind: "png", sizeBytes: buffer.length, width: inspected.width, height: inspected.height, warnings: inspected.warnings, previewData: new Uint8Array(buffer) };
    }
    if (extension !== ".svg" || info.size > 128 * 1024) throw resourceError("E_ICON_SIZE", "单图标覆盖必须是小于或等于 128 KiB 的 SVG");
    importProgress(options, "sanitizing", 55, "正在清理 SVG 节点");
    const icon = sanitizeSvg(buffer.toString("utf8"));
    try { await writeFile(temporaryPath, `${JSON.stringify(icon, null, 2)}\n`, { encoding: "utf8", flag: "wx", signal: options?.signal }); } catch (error) { await rm(temporaryPath, { force: true }); throw error; }
    this.#pendingIconOverrides.set(importId, { semanticName, kind: "vector", icon, temporaryPath, sizeBytes: buffer.length, warnings: icon.warnings });
    importProgress(options, "ready", 100, "SVG 图标预览已就绪");
    return { importId, semanticName, kind: "vector", sizeBytes: buffer.length, warnings: icon.warnings, icon };
  }

  async commitIconOverride(importId: string): Promise<IconOverrideMetadata> {
    const pending = this.#pendingIconOverrides.get(importId);
    if (!pending) throw resourceError("E_INVALID_ARGUMENT", "单图标导入预览已失效，请重新选择文件");
    const content = await readFile(pending.temporaryPath);
    const digest = createHash("sha256").update(pending.semanticName).update("\0").update(pending.kind).update("\0").update(content).digest("hex");
    const id = `icon-${digest.slice(0, 32)}`;
    const existing = this.#index.iconOverrides.find((icon) => icon.id === id);
    if (existing) {
      this.#pendingIconOverrides.delete(importId);
      await rm(pending.temporaryPath, { force: true });
      const { fileName: _fileName, ...metadata } = existing;
      return metadata;
    }
    const fileName = `${id}.${pending.kind === "vector" ? "json" : "png"}`;
    const destination = join(this.#iconOverridesDirectory, fileName);
    try {
      await rename(pending.temporaryPath, destination);
      const stored: StoredIconOverride = {
        id,
        fileName,
        semanticName: pending.semanticName,
        kind: pending.kind,
        sizeBytes: pending.sizeBytes,
        ...(pending.kind === "png" ? { width: pending.width, height: pending.height } : {}),
        warnings: [...pending.warnings],
      };
      const previousIndex = this.#index;
      this.#index = { ...this.#index, iconOverrides: [...this.#index.iconOverrides, stored] };
      try {
        await this.#save();
      } catch (error) {
        this.#index = previousIndex;
        throw error;
      }
      this.#pendingIconOverrides.delete(importId);
      const { fileName: _fileName, ...metadata } = stored;
      return metadata;
    } catch (error) {
      this.#pendingIconOverrides.delete(importId);
      await rm(pending.temporaryPath, { force: true }).catch(() => undefined);
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readFont(id: string): Promise<Uint8Array> {
    if (!FONT_ID_PATTERN.test(id)) throw resourceError("E_INVALID_ARGUMENT", "字体资源 ID 无效");
    const font = this.#index.fonts.find((entry) => entry.id === id);
    if (!font) throw resourceError("E_INPUT_NOT_FOUND", "字体资源不存在");
    return new Uint8Array(await readFile(join(this.#fontsDirectory, font.fileName)));
  }

  async readIconPack(id: string): Promise<SanitizedIconPack> {
    if (!ICON_PACK_ID_PATTERN.test(id)) throw resourceError("E_INVALID_ARGUMENT", "图标包资源 ID 无效");
    const pack = this.#index.iconPacks.find((entry) => entry.id === id);
    if (!pack) throw resourceError("E_INPUT_NOT_FOUND", "图标包资源不存在");
    const raw = await readFile(join(this.#iconPacksDirectory, pack.fileName), "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_ICON_PACK_BYTES) throw resourceError("E_ICON_SIZE", "图标包资源异常过大");
    try {
      return validateSanitizedIconPack(JSON.parse(raw) as unknown);
    } catch (error) {
      throw resourceError("E_ICON_RESOURCE", "已保存的图标包资源损坏", { cause: error instanceof Error ? error.message : String(error) });
    }
  }

  async readIconOverride(id: string): Promise<IconOverrideResource> {
    if (!ICON_ID_PATTERN.test(id)) throw resourceError("E_INVALID_ARGUMENT", "单图标资源 ID 无效");
    const metadata = this.#index.iconOverrides.find((entry) => entry.id === id);
    if (!metadata) throw resourceError("E_INPUT_NOT_FOUND", "单图标资源不存在");
    const buffer = await readFile(join(this.#iconOverridesDirectory, metadata.fileName));
    if (metadata.kind === "png") {
      const inspected = inspectPng(buffer);
      if (inspected.width !== metadata.width || inspected.height !== metadata.height) throw resourceError("E_ICON_RESOURCE", "PNG 图标尺寸与资源索引不一致");
      return { kind: "png", data: new Uint8Array(buffer), width: inspected.width, height: inspected.height };
    }
    if (buffer.length > 256 * 1024) throw resourceError("E_ICON_SIZE", "单图标资源异常过大");
    try {
      const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
      const pack = validateSanitizedIconPack({ schemaVersion: 1, name: "Stored Override", version: "1", defaultSize: 20, icons: { [metadata.semanticName]: parsed }, warnings: [] });
      return { kind: "vector", icon: pack.icons[metadata.semanticName]! };
    } catch (error) {
      throw resourceError("E_ICON_RESOURCE", "已保存的单图标资源损坏", { cause: error instanceof Error ? error.message : String(error) });
    }
  }

  async deleteFont(id: string): Promise<void> {
    if (!FONT_ID_PATTERN.test(id)) throw resourceError("E_INVALID_ARGUMENT", "字体资源 ID 无效");
    const font = this.#index.fonts.find((entry) => entry.id === id);
    if (!font) return;
    const previousIndex = this.#index;
    this.#index = { ...this.#index, fonts: this.#index.fonts.filter((entry) => entry.id !== id) };
    try {
      await this.#save();
    } catch (error) {
      this.#index = previousIndex;
      throw error;
    }
    await rm(join(this.#fontsDirectory, font.fileName), { force: true });
  }

  async deleteIconPack(id: string): Promise<void> {
    if (!ICON_PACK_ID_PATTERN.test(id)) throw resourceError("E_INVALID_ARGUMENT", "图标包资源 ID 无效");
    const pack = this.#index.iconPacks.find((entry) => entry.id === id);
    if (!pack) return;
    const previousIndex = this.#index;
    this.#index = { ...this.#index, iconPacks: this.#index.iconPacks.filter((entry) => entry.id !== id) };
    try { await this.#save(); } catch (error) { this.#index = previousIndex; throw error; }
    await rm(join(this.#iconPacksDirectory, pack.fileName), { force: true });
  }

  async deleteIconOverride(id: string): Promise<void> {
    if (!ICON_ID_PATTERN.test(id)) throw resourceError("E_INVALID_ARGUMENT", "单图标资源 ID 无效");
    const icon = this.#index.iconOverrides.find((entry) => entry.id === id);
    if (!icon) return;
    const previousIndex = this.#index;
    this.#index = { ...this.#index, iconOverrides: this.#index.iconOverrides.filter((entry) => entry.id !== id) };
    try { await this.#save(); } catch (error) { this.#index = previousIndex; throw error; }
    await rm(join(this.#iconOverridesDirectory, icon.fileName), { force: true });
  }

  async #save(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const temporary = `${this.#indexPath}.${randomUUID()}.partial`;
    const backup = `${this.#indexPath}.${randomUUID()}.backup`;
    await writeFile(temporary, `${JSON.stringify(this.#index, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    let hadPrevious = false;
    try {
      await rename(this.#indexPath, backup);
      hadPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    try {
      await rename(temporary, this.#indexPath);
      if (hadPrevious) await rm(backup, { force: true }).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (hadPrevious) await rename(backup, this.#indexPath).catch(() => undefined);
      throw error;
    }
  }
}
