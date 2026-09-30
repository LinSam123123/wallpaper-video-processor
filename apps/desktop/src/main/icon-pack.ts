import { stat } from "node:fs/promises";
import { basename, extname, posix } from "node:path";
import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { SaxesParser, type SaxesTagPlain } from "saxes";
import { Open, type File as ZipFile } from "unzipper";
import { isSemanticIconName, SEMANTIC_ICON_NAMES, type SemanticIconName } from "../shared/appearance-icons.js";
import type {
  SafeVectorAttributeName,
  SafeVectorIcon,
  SafeVectorNode,
  SafeVectorTag,
  SanitizedIconPack,
} from "../shared/contracts.js";

const MAX_ZIP_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_COUNT = 256;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SVG_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_VECTOR_NODES = 256;
const MAX_PATH_CHARACTERS = 32 * 1024;
const MAX_PATH_COMMANDS = 1024;
const SAFE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u;
const SAFE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;
const ICON_PATH = /^icons\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\.svg$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const NUMBER_LIST = /^[\s,0-9eE+.-]+$/;
const PATH_DATA = /^[\s,0-9eE+.,MmZzLlHhVvCcSsQqTtAa-]+$/;
const COLOR = /^(?:none|currentColor|black|white|#[0-9a-fA-F]{3,8})$/;
const TRANSFORM = /^(?:(?:matrix|translate|scale|rotate)\([\s,0-9eE+.-]+\)\s*)+$/;

interface IconManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  style: "outline";
  defaultSize: number;
  icons: Partial<Record<SemanticIconName, string>>;
}

export interface InspectedIconPack {
  pack: SanitizedIconPack;
  sourceSizeBytes: number;
}

export interface IconPackInspectionOptions {
  signal?: AbortSignal;
  onProgress?(stage: "reading" | "validating" | "sanitizing" | "ready", percent: number, message: string): void;
}

function inspectionProgress(options: IconPackInspectionOptions | undefined, stage: "reading" | "validating" | "sanitizing", percent: number, message: string): void {
  if (options?.signal?.aborted) throw iconError("E_IMPORT_CANCELLED", "图标包导入已取消");
  options?.onProgress?.(stage, percent, message);
}

function iconError(code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

function rejectDuplicateKeys(node: JsonNode): void {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = String(property.children?.[0]?.value ?? "");
      if (keys.has(key)) throw iconError("E_ICON_MANIFEST", `manifest 含有重复字段：${key}`);
      keys.add(key);
      const value = property.children?.[1];
      if (value) rejectDuplicateKeys(value);
    }
    return;
  }
  for (const child of node.children ?? []) rejectDuplicateKeys(child);
}

export function parseIconManifest(raw: string): IconManifest {
  const errors: ParseError[] = [];
  const root = parseTree(raw, errors, { allowTrailingComma: false, disallowComments: true });
  if (!root || errors.length > 0) throw iconError("E_ICON_MANIFEST", "manifest.json 不是严格 JSON");
  rejectDuplicateKeys(root);
  const value = getNodeValue(root) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw iconError("E_ICON_MANIFEST", "manifest.json 顶层必须是对象");
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "name", "version", "style", "defaultSize", "icons"]);
  const unknown = Object.keys(candidate).find((key) => !allowed.has(key));
  if (unknown) throw iconError("E_ICON_MANIFEST", `manifest 包含未知字段：${unknown}`);
  if (candidate.schemaVersion !== 1 || candidate.style !== "outline") throw iconError("E_ICON_MANIFEST", "仅支持 schemaVersion 1 的 outline 图标包");
  if (typeof candidate.name !== "string" || !SAFE_NAME.test(candidate.name)) throw iconError("E_ICON_MANIFEST", "图标包名称无效或超过 80 个字符");
  if (typeof candidate.version !== "string" || !SAFE_VERSION.test(candidate.version)) throw iconError("E_ICON_MANIFEST", "图标包版本无效");
  if (!Number.isInteger(candidate.defaultSize) || Number(candidate.defaultSize) < 16 || Number(candidate.defaultSize) > 24) {
    throw iconError("E_ICON_MANIFEST", "defaultSize 必须是 16–24 之间的整数");
  }
  if (!candidate.icons || typeof candidate.icons !== "object" || Array.isArray(candidate.icons)) throw iconError("E_ICON_MANIFEST", "icons 必须是语义名称到 SVG 文件的映射");
  const icons: Partial<Record<SemanticIconName, string>> = {};
  for (const [name, path] of Object.entries(candidate.icons as Record<string, unknown>)) {
    if (!isSemanticIconName(name)) throw iconError("E_ICON_MANIFEST", `未知语义图标：${name}`);
    if (typeof path !== "string" || !ICON_PATH.test(path)) throw iconError("E_ICON_MANIFEST", `${name} 的 SVG 路径无效`);
    icons[name] = path;
  }
  if (Object.keys(icons).length === 0) throw iconError("E_ICON_MANIFEST", "图标包至少需要提供一个语义图标");
  return {
    schemaVersion: 1,
    name: candidate.name,
    version: candidate.version,
    style: "outline",
    defaultSize: Number(candidate.defaultSize),
    icons,
  };
}

const COMMON_ATTRIBUTES = new Set([
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
  "fill-rule", "clip-rule", "opacity", "fill-opacity", "stroke-opacity", "transform",
]);
const ELEMENT_ATTRIBUTES: Record<SafeVectorTag, Set<string>> = {
  g: new Set(COMMON_ATTRIBUTES),
  path: new Set([...COMMON_ATTRIBUTES, "d"]),
  circle: new Set([...COMMON_ATTRIBUTES, "cx", "cy", "r"]),
  ellipse: new Set([...COMMON_ATTRIBUTES, "cx", "cy", "rx", "ry"]),
  line: new Set([...COMMON_ATTRIBUTES, "x1", "y1", "x2", "y2"]),
  polyline: new Set([...COMMON_ATTRIBUTES, "points"]),
  polygon: new Set([...COMMON_ATTRIBUTES, "points"]),
  rect: new Set([...COMMON_ATTRIBUTES, "x", "y", "width", "height", "rx", "ry"]),
};
const ATTRIBUTE_NAMES: Record<string, SafeVectorAttributeName> = {
  d: "d", cx: "cx", cy: "cy", r: "r", rx: "rx", ry: "ry", x: "x", y: "y", x1: "x1", y1: "y1", x2: "x2", y2: "y2",
  width: "width", height: "height", points: "points", fill: "fill", stroke: "stroke", "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap", "stroke-linejoin": "strokeLinejoin", "stroke-miterlimit": "strokeMiterlimit",
  "fill-rule": "fillRule", "clip-rule": "clipRule", opacity: "opacity", "fill-opacity": "fillOpacity",
  "stroke-opacity": "strokeOpacity", transform: "transform",
};

function finiteNumber(value: string, attribute: string): number {
  if (!NUMBER.test(value)) throw iconError("E_ICON_SVG", `${attribute} 必须是有限数值`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 100_000) throw iconError("E_ICON_SVG", `${attribute} 数值超出允许范围`);
  return parsed;
}

function sanitizedAttributes(tag: SafeVectorTag | "svg", attributes: Record<string, string>, fixedColors: Set<string>, complexity: { pathCharacters: number; pathCommands: number }): Partial<Record<SafeVectorAttributeName, string | number>> {
  const result: Partial<Record<SafeVectorAttributeName, string | number>> = {};
  const allowed = tag === "svg" ? COMMON_ATTRIBUTES : ELEMENT_ATTRIBUTES[tag];
  for (const [rawName, rawValue] of Object.entries(attributes)) {
    const name = rawName.toLowerCase();
    const value = rawValue.trim();
    if (tag === "svg" && ["viewbox", "width", "height", "xmlns"].includes(name)) continue;
    if (!allowed.has(name) || !ATTRIBUTE_NAMES[name]) throw iconError("E_ICON_SVG", `不允许的 SVG 属性：${rawName}`);
    const outputName = ATTRIBUTE_NAMES[name]!;
    if (["fill", "stroke"].includes(name)) {
      if (!COLOR.test(value) || /^url\s*\(/i.test(value)) throw iconError("E_ICON_SVG", `${rawName} 只能使用安全颜色或 currentColor`);
      if (!["none", "currentColor"].includes(value)) fixedColors.add(value.toLowerCase());
      result[outputName] = value;
    } else if (["stroke-linecap"].includes(name)) {
      if (!["butt", "round", "square"].includes(value)) throw iconError("E_ICON_SVG", `${rawName} 值无效`);
      result[outputName] = value;
    } else if (["stroke-linejoin"].includes(name)) {
      if (!["miter", "round", "bevel"].includes(value)) throw iconError("E_ICON_SVG", `${rawName} 值无效`);
      result[outputName] = value;
    } else if (["fill-rule", "clip-rule"].includes(name)) {
      if (!["nonzero", "evenodd"].includes(value)) throw iconError("E_ICON_SVG", `${rawName} 值无效`);
      result[outputName] = value;
    } else if (name === "transform") {
      if (value.length > 512 || !TRANSFORM.test(value)) throw iconError("E_ICON_SVG", "transform 仅允许 matrix/translate/scale/rotate");
      result[outputName] = value;
    } else if (name === "d") {
      complexity.pathCharacters += value.length;
      complexity.pathCommands += (value.match(/[MmZzLlHhVvCcSsQqTtAa]/g) ?? []).length;
      if (!PATH_DATA.test(value) || complexity.pathCharacters > MAX_PATH_CHARACTERS || complexity.pathCommands > MAX_PATH_COMMANDS) {
        throw iconError("E_ICON_COMPLEXITY", "SVG 路径过于复杂或包含非法命令");
      }
      result.d = value;
    } else if (name === "points") {
      if (value.length > 8192 || !NUMBER_LIST.test(value)) throw iconError("E_ICON_COMPLEXITY", "SVG 点列表过于复杂或无效");
      result.points = value;
    } else {
      const number = finiteNumber(value, rawName);
      if (["opacity", "fill-opacity", "stroke-opacity"].includes(name) && (number < 0 || number > 1)) throw iconError("E_ICON_SVG", `${rawName} 必须位于 0–1`);
      if (name === "stroke-width" && (number < 0 || number > 16)) throw iconError("E_ICON_SVG", "stroke-width 超出允许范围");
      result[outputName] = number;
    }
  }
  return result;
}

export function sanitizeSvg(raw: string): SafeVectorIcon {
  if (Buffer.byteLength(raw, "utf8") > MAX_SVG_BYTES) throw iconError("E_ICON_SIZE", "单个 SVG 不得超过 128 KiB");
  if (/<!DOCTYPE|<!ENTITY|<script|<style|<foreignObject|<animate|<set\b|<use\b|<image\b/i.test(raw)) {
    throw iconError("E_ICON_SVG", "SVG 包含脚本、样式、引用、动画或外部内容");
  }
  const parser = new SaxesParser({ xmlns: false });
  const roots: SafeVectorNode[] = [];
  const stack: SafeVectorNode[] = [];
  const fixedColors = new Set<string>();
  const complexity = { nodes: 0, pathCharacters: 0, pathCommands: 0 };
  let viewBox: [number, number, number, number] | null = null;
  let rootAttributes: SafeVectorIcon["attributes"] = {};
  let rootOpen = false;
  let failure: Error | null = null;
  const fail = (error: unknown): void => { failure = error instanceof Error ? error : iconError("E_ICON_SVG", String(error)); };
  parser.on("doctype", () => fail(iconError("E_ICON_SVG", "SVG 不允许 DOCTYPE")));
  parser.on("processinginstruction", () => fail(iconError("E_ICON_SVG", "SVG 不允许处理指令")));
  parser.on("cdata", () => fail(iconError("E_ICON_SVG", "SVG 不允许 CDATA")));
  parser.on("text", (text) => { if (text.trim()) fail(iconError("E_ICON_SVG", "SVG 不允许文本节点")); });
  parser.on("error", fail);
  parser.on("opentag", (opened: SaxesTagPlain) => {
    if (failure) return;
    const tagName = opened.name.toLowerCase();
    const attributes = opened.attributes;
    if (!rootOpen) {
      if (tagName !== "svg") return fail(iconError("E_ICON_SVG", "根元素必须是 svg"));
      if (attributes.xmlns && attributes.xmlns !== "http://www.w3.org/2000/svg") return fail(iconError("E_ICON_SVG", "SVG xmlns 无效"));
      const values = String(attributes.viewBox ?? attributes.viewbox ?? "").trim().split(/[\s,]+/).map(Number);
      if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || values[2]! <= 0 || values[3]! <= 0 || values.some((value) => Math.abs(value) > 100_000)) {
        return fail(iconError("E_ICON_SVG", "SVG 必须包含有效 viewBox"));
      }
      viewBox = values as [number, number, number, number];
      try { rootAttributes = sanitizedAttributes("svg", attributes, fixedColors, complexity); } catch (error) { fail(error); }
      rootOpen = true;
      return;
    }
    if (tagName === "svg" || !(tagName in ELEMENT_ATTRIBUTES)) return fail(iconError("E_ICON_SVG", `不允许的 SVG 元素：${opened.name}`));
    complexity.nodes += 1;
    if (complexity.nodes > MAX_VECTOR_NODES) return fail(iconError("E_ICON_COMPLEXITY", `SVG 元素不得超过 ${MAX_VECTOR_NODES} 个`));
    try {
      const node: SafeVectorNode = {
        tag: tagName as SafeVectorTag,
        attributes: sanitizedAttributes(tagName as SafeVectorTag, attributes, fixedColors, complexity),
        children: [],
      };
      const parent = stack.at(-1);
      if (parent) parent.children.push(node); else roots.push(node);
      stack.push(node);
    } catch (error) {
      fail(error);
    }
  });
  parser.on("closetag", (closed) => {
    if (closed.name.toLowerCase() !== "svg") stack.pop();
  });
  try {
    parser.write(raw).close();
  } catch (error) {
    fail(error);
  }
  if (failure) throw failure;
  if (!viewBox || !rootOpen || roots.length === 0 || stack.length !== 0) throw iconError("E_ICON_SVG", "SVG 结构不完整或为空");
  const warnings: string[] = [];
  const aspect = viewBox[2] / viewBox[3];
  if (aspect < 0.5 || aspect > 2 || viewBox[2] > 256 || viewBox[3] > 256) warnings.push("viewBox 比例或范围异常，预览中可能出现较大留白。");
  if (fixedColors.size === 1) warnings.push("图标使用固定黑白或固定颜色，可能无法跟随主题。");
  if (fixedColors.size > 1) warnings.push("图标包含多种固定颜色，可能无法跟随主题。");
  return { viewBox, attributes: rootAttributes, nodes: roots, warnings };
}

const SAFE_STORED_ATTRIBUTES = new Set<string>(Object.values(ATTRIBUTE_NAMES));
const SAFE_STORED_TAGS = new Set(Object.keys(ELEMENT_ATTRIBUTES));

function validateStoredNode(value: unknown, counter: { nodes: number }): asserts value is SafeVectorNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw iconError("E_ICON_RESOURCE", "图标节点结构无效");
  const node = value as Record<string, unknown>;
  if (typeof node.tag !== "string" || !SAFE_STORED_TAGS.has(node.tag)) throw iconError("E_ICON_RESOURCE", "图标节点类型无效");
  if (!node.attributes || typeof node.attributes !== "object" || Array.isArray(node.attributes)) throw iconError("E_ICON_RESOURCE", "图标节点属性无效");
  for (const [name, entry] of Object.entries(node.attributes as Record<string, unknown>)) {
    if (!SAFE_STORED_ATTRIBUTES.has(name) || (typeof entry !== "string" && typeof entry !== "number")) throw iconError("E_ICON_RESOURCE", `已保存图标包含无效属性：${name}`);
    if (typeof entry === "number" && !Number.isFinite(entry)) throw iconError("E_ICON_RESOURCE", "已保存图标包含非有限数值");
    if (typeof entry === "string" && (entry.length > MAX_PATH_CHARACTERS || /[<>"'`;{}]|url\s*\(/i.test(entry))) throw iconError("E_ICON_RESOURCE", "已保存图标包含不安全属性值");
  }
  if (!Array.isArray(node.children)) throw iconError("E_ICON_RESOURCE", "图标子节点结构无效");
  counter.nodes += 1;
  if (counter.nodes > MAX_VECTOR_NODES) throw iconError("E_ICON_COMPLEXITY", "已保存图标节点过多");
  for (const child of node.children) validateStoredNode(child, counter);
}

export function validateSanitizedIconPack(value: unknown): SanitizedIconPack {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw iconError("E_ICON_RESOURCE", "图标包资源结构无效");
  const pack = value as Record<string, unknown>;
  if (pack.schemaVersion !== 1 || typeof pack.name !== "string" || !SAFE_NAME.test(pack.name) || typeof pack.version !== "string" || !SAFE_VERSION.test(pack.version) ||
      !Number.isInteger(pack.defaultSize) || Number(pack.defaultSize) < 16 || Number(pack.defaultSize) > 24 ||
      !pack.icons || typeof pack.icons !== "object" || Array.isArray(pack.icons) || !Array.isArray(pack.warnings) || !pack.warnings.every((warning) => typeof warning === "string" && warning.length <= 300)) {
    throw iconError("E_ICON_RESOURCE", "图标包资源元数据无效");
  }
  const icons: SanitizedIconPack["icons"] = {};
  for (const [name, rawIcon] of Object.entries(pack.icons as Record<string, unknown>)) {
    if (!isSemanticIconName(name) || !rawIcon || typeof rawIcon !== "object" || Array.isArray(rawIcon)) throw iconError("E_ICON_RESOURCE", "图标包包含未知语义或无效图标");
    const icon = rawIcon as Record<string, unknown>;
    if (!Array.isArray(icon.viewBox) || icon.viewBox.length !== 4 || !icon.viewBox.every((entry) => typeof entry === "number" && Number.isFinite(entry)) || Number(icon.viewBox[2]) <= 0 || Number(icon.viewBox[3]) <= 0 ||
        !icon.attributes || typeof icon.attributes !== "object" || Array.isArray(icon.attributes) || !Array.isArray(icon.nodes) || !Array.isArray(icon.warnings) || !icon.warnings.every((warning) => typeof warning === "string" && warning.length <= 300)) {
      throw iconError("E_ICON_RESOURCE", `${name} 图标结构无效`);
    }
    const syntheticRoot = { tag: "g", attributes: icon.attributes, children: icon.nodes };
    const counter = { nodes: -1 };
    validateStoredNode(syntheticRoot, counter);
    icons[name] = {
      viewBox: icon.viewBox as [number, number, number, number],
      attributes: icon.attributes as SafeVectorIcon["attributes"],
      nodes: icon.nodes as SafeVectorNode[],
      warnings: [...icon.warnings] as string[],
    };
  }
  if (Object.keys(icons).length === 0) throw iconError("E_ICON_RESOURCE", "图标包资源为空");
  return {
    schemaVersion: 1,
    name: pack.name,
    version: pack.version,
    defaultSize: Number(pack.defaultSize),
    icons,
    warnings: [...pack.warnings] as string[],
  };
}

function normalizedZipPath(path: string): string {
  if (!path || path.includes("\\") || path.includes("\0") || /^[a-zA-Z]:/.test(path) || path.startsWith("/") || path.startsWith("//")) {
    throw iconError("E_ICON_ZIP_PATH", `ZIP 条目路径无效：${path || "<empty>"}`);
  }
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized === ".." || normalized.startsWith("../") || path.split("/").includes("..")) {
    throw iconError("E_ICON_ZIP_PATH", `ZIP 条目试图越过根目录：${path}`);
  }
  return normalized;
}

function validateZipEntry(file: ZipFile): void {
  const path = normalizedZipPath(file.path);
  const unixType = (file.externalFileAttributes >>> 16) & 0o170000;
  if (file.flags & 1) throw iconError("E_ICON_ZIP", `不允许加密条目：${path}`);
  if (![0, 8].includes(file.compressionMethod)) throw iconError("E_ICON_ZIP", `不支持的压缩方法：${path}`);
  if (file.type === "Directory") {
    if (path !== "icons/") throw iconError("E_ICON_ZIP_PATH", `不允许的目录：${path}`);
    if (unixType !== 0 && unixType !== 0o040000) throw iconError("E_ICON_ZIP", `ZIP 包含特殊目录条目：${path}`);
    return;
  }
  if (file.type !== "File" || (unixType !== 0 && unixType !== 0o100000)) throw iconError("E_ICON_ZIP", `ZIP 包含链接或特殊文件：${path}`);
  if (path !== "manifest.json" && !ICON_PATH.test(path)) throw iconError("E_ICON_ZIP_PATH", `仅允许 manifest.json 和 icons/*.svg：${path}`);
  const limit = path === "manifest.json" ? MAX_MANIFEST_BYTES : MAX_SVG_BYTES;
  if (file.uncompressedSize < 0 || file.uncompressedSize > limit) throw iconError("E_ICON_SIZE", `${path} 超过大小上限`);
}

async function readZipFile(file: ZipFile, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const stream = file.stream();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream as unknown as AsyncIterable<Buffer | Uint8Array>) {
    if (signal?.aborted) {
      stream.destroy();
      throw iconError("E_IMPORT_CANCELLED", "图标包导入已取消");
    }
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > limit) {
      stream.destroy();
      throw iconError("E_ICON_SIZE", `${file.path} 解压后超过大小上限`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function inspectIconPack(path: string, options?: IconPackInspectionOptions): Promise<InspectedIconPack> {
  inspectionProgress(options, "reading", 8, "正在读取 ZIP 中央目录");
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || extname(path).toLowerCase() !== ".zip" || info.size <= 0 || info.size > MAX_ZIP_BYTES) {
    throw iconError("E_ICON_SIZE", "图标包必须是小于或等于 10 MiB 的 ZIP 文件");
  }
  let directory: Awaited<ReturnType<typeof Open.file>>;
  try {
    directory = await Open.file(path);
  } catch (error) {
    throw iconError("E_ICON_ZIP", "无法读取 ZIP 中央目录", { cause: error instanceof Error ? error.message : String(error) });
  }
  if (directory.files.length === 0 || directory.files.length > MAX_ENTRY_COUNT) throw iconError("E_ICON_SIZE", `ZIP 条目数必须位于 1–${MAX_ENTRY_COUNT}`);
  inspectionProgress(options, "validating", 22, "正在校验 ZIP 条目和大小限制");
  const seen = new Set<string>();
  let declaredTotal = 0;
  for (const file of directory.files) {
    validateZipEntry(file);
    const normalized = normalizedZipPath(file.path);
    if (seen.has(normalized)) throw iconError("E_ICON_ZIP_PATH", `ZIP 包含重复条目：${normalized}`);
    seen.add(normalized);
    declaredTotal += file.uncompressedSize;
    if (declaredTotal > MAX_TOTAL_BYTES) throw iconError("E_ICON_SIZE", "ZIP 解压总量不得超过 8 MiB");
  }
  const manifestEntry = directory.files.find((file) => file.path === "manifest.json" && file.type === "File");
  if (!manifestEntry) throw iconError("E_ICON_MANIFEST", "图标包缺少 manifest.json");
  const manifestBuffer = await readZipFile(manifestEntry, MAX_MANIFEST_BYTES, options?.signal);
  const manifest = parseIconManifest(manifestBuffer.toString("utf8"));
  inspectionProgress(options, "validating", 38, "manifest 校验完成");
  const entries = new Map(directory.files.filter((file) => file.type === "File").map((file) => [file.path, file]));
  const icons: SanitizedIconPack["icons"] = {};
  const warnings = new Set<string>();
  let actualTotal = manifestBuffer.length;
  const manifestIcons = Object.entries(manifest.icons) as Array<[SemanticIconName, string]>;
  for (const [index, [name, iconPath]] of manifestIcons.entries()) {
    const entry = entries.get(iconPath);
    if (!entry) throw iconError("E_ICON_MANIFEST", `${name} 引用的文件不存在：${iconPath}`);
    inspectionProgress(options, "sanitizing", 40 + Math.round((index / manifestIcons.length) * 50), `正在清理 ${name}`);
    const buffer = await readZipFile(entry, MAX_SVG_BYTES, options?.signal);
    actualTotal += buffer.length;
    if (actualTotal > MAX_TOTAL_BYTES) throw iconError("E_ICON_SIZE", "ZIP 实际解压总量不得超过 8 MiB");
    const icon = sanitizeSvg(buffer.toString("utf8"));
    icons[name] = icon;
    for (const warning of icon.warnings) warnings.add(`${name}：${warning}`);
  }
  const missingCount = SEMANTIC_ICON_NAMES.length - Object.keys(icons).length;
  inspectionProgress(options, "sanitizing", 94, "正在生成安全预览");
  if (missingCount > 0) warnings.add(`未提供的 ${missingCount} 个语义图标将使用内置精细线性图标。`);
  return {
    sourceSizeBytes: info.size,
    pack: {
      schemaVersion: 1,
      name: manifest.name,
      version: manifest.version,
      defaultSize: manifest.defaultSize,
      icons,
      warnings: [...warnings],
    },
  };
}
