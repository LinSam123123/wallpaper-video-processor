import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import type { DependencyId, InstallDependenciesResult } from "../shared/contracts.js";

interface ManifestArtifact {
  id: DependencyId;
  displayName: string;
  version: string;
  sourcePage: string;
  downloadUrl: string;
  license: string;
  licenseUrl: string;
  approximateSizeBytes: number;
  sha256: string;
  archive: "zip" | "tar.xz";
  executablePaths: string[];
}

interface Manifest {
  schemaVersion: 1;
  platform: "win32-x64";
  artifacts: ManifestArtifact[];
}

function failure(code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

export function safeEntry(entry: string, root: string): string {
  const portable = entry.replaceAll("\\", "/");
  if (!portable || portable.includes("\0") || portable.startsWith("/") || isAbsolute(entry) || win32.isAbsolute(entry)) {
    throw failure("E_UNSAFE_ARCHIVE", `压缩包包含不安全路径：${entry}`);
  }
  const parts = portable.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw failure("E_UNSAFE_ARCHIVE", `压缩包路径越界：${entry}`);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (parts.some((part) => part.includes(":") || part.endsWith(".") || part.endsWith(" ") || reserved.test(part))) {
    throw failure("E_UNSAFE_ARCHIVE", `压缩包包含 Windows 不安全路径：${entry}`);
  }
  const candidate = resolve(root, ...parts);
  if (candidate !== resolve(root) && !candidate.startsWith(resolve(root) + sep)) {
    throw failure("E_UNSAFE_ARCHIVE", `压缩包路径越界：${entry}`);
  }
  return candidate;
}

async function command(executable: string, args: string[]): Promise<string> {
  const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return await new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise(stdout) : reject(failure("E_PROCESS_FAILED", stderr || `${executable} 退出码 ${String(code)}`)));
  });
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function rejectLinks(root: string, current = root): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    safeEntry(relative(root, path), root);
    if ((await lstat(path)).isSymbolicLink()) throw failure("E_UNSAFE_ARCHIVE", `压缩包包含链接：${entry.name}`);
    if (entry.isDirectory()) await rejectLinks(root, path);
  }
}

export function validateManifest(value: unknown): Manifest {
  if (!value || typeof value !== "object") throw failure("E_DEPENDENCY_MANIFEST", "依赖清单格式无效");
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 1 || source.platform !== "win32-x64" || !Array.isArray(source.artifacts)) {
    throw failure("E_DEPENDENCY_MANIFEST", "不支持的依赖清单版本或平台");
  }
  const artifacts = source.artifacts.map((item) => {
    const artifact = item as Record<string, unknown>;
    const requiredText = ["displayName", "version", "sourcePage", "downloadUrl", "license", "licenseUrl"] as const;
    if ((artifact.id !== "ffmpeg" && artifact.id !== "realesrgan" && artifact.id !== "rife") ||
        !requiredText.every((key) => typeof artifact[key] === "string" && String(artifact[key]).length > 0) ||
        !String(artifact.downloadUrl).startsWith("https://") ||
        typeof artifact.approximateSizeBytes !== "number" || artifact.approximateSizeBytes <= 0 ||
        typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.sha256) ||
        (artifact.archive !== "zip" && artifact.archive !== "tar.xz") ||
        !Array.isArray(artifact.executablePaths) || !artifact.executablePaths.every((path) => typeof path === "string")) {
      throw failure("E_DEPENDENCY_MANIFEST", "依赖清单条目不完整");
    }
    return artifact as unknown as ManifestArtifact;
  });
  return { schemaVersion: 1, platform: "win32-x64", artifacts };
}

export async function loadDependencyManifest(candidates: string[]): Promise<Manifest | null> {
  for (const candidate of candidates) {
    try {
      return validateManifest(JSON.parse(await readFile(candidate, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

async function download(artifact: ManifestArtifact, destination: string): Promise<void> {
  const response = await fetch(artifact.downloadUrl, { redirect: "follow" });
  if (!response.ok || !response.body) throw failure("E_DOWNLOAD_FAILED", `下载失败：HTTP ${response.status}`);
  if (response.url && !response.url.startsWith("https://")) {
    throw failure("E_DOWNLOAD_FAILED", "依赖下载被重定向到非 HTTPS 地址");
  }
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
    createWriteStream(destination, { flags: "wx" }),
  );
  const digest = await hashFile(destination);
  if (digest.toLowerCase() !== artifact.sha256.toLowerCase()) {
    throw failure("E_CHECKSUM_MISMATCH", `${artifact.id} 的 SHA-256 不匹配`, { expected: artifact.sha256, actual: digest });
  }
}

async function installOne(artifact: ManifestArtifact, toolsDirectory: string): Promise<void> {
  const staging = join(toolsDirectory, `.${artifact.id}-${randomUUID()}.extracting`);
  const archive = join(toolsDirectory, `.${artifact.id}-${randomUUID()}.${artifact.archive === "zip" ? "zip" : "tar.xz"}`);
  const destination = join(toolsDirectory, artifact.id);
  const backup = join(toolsDirectory, `.${artifact.id}-${randomUUID()}.backup`);
  await mkdir(staging, { recursive: false });
  try {
    await download(artifact, archive);
    const listing = await command("tar", ["-tf", archive]);
    listing.split(/\r?\n/).filter(Boolean).forEach((entry) => safeEntry(entry, staging));
    const verboseListing = await command("tar", ["-tvf", archive]);
    const unsafeType = verboseListing.split(/\r?\n/).filter(Boolean).find((line) => /^[lhbcps]/i.test(line.trimStart()));
    if (unsafeType) throw failure("E_UNSAFE_ARCHIVE", `压缩包包含链接或特殊文件：${unsafeType}`);
    await command("tar", ["-xf", archive, "-C", staging]);
    await rejectLinks(staging);
    let contentRoot = staging;
    const top = await readdir(staging, { withFileTypes: true });
    if (top.length === 1 && top[0]?.isDirectory()) contentRoot = join(staging, top[0].name);
    for (const executable of artifact.executablePaths) {
      const path = safeEntry(executable, contentRoot);
      if (!await access(path).then(() => true, () => false)) {
        throw failure("E_DEPENDENCY_MANIFEST", `解压后未找到 ${executable}`);
      }
    }
    const existed = await access(destination).then(() => true, () => false);
    if (existed) await rename(destination, backup);
    try {
      await rename(contentRoot, destination);
    } catch (error) {
      if (existed) await rename(backup, destination).catch(() => undefined);
      throw error;
    }
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  } finally {
    await rm(archive, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

export async function installDependencies(options: {
  ids: DependencyId[];
  consent: boolean;
  toolsDirectory: string;
  manifest: Manifest | null;
}): Promise<InstallDependenciesResult> {
  if (!options.consent) throw failure("E_INVALID_ARGUMENT", "下载依赖前需要明确确认");
  if (!options.manifest) {
    throw failure("E_DEPENDENCY_MANIFEST", "安装包未包含固定 SHA-256 依赖清单，已拒绝下载");
  }
  await mkdir(options.toolsDirectory, { recursive: true });
  const installed: InstallDependenciesResult["installed"] = [];
  for (const id of [...new Set(options.ids)]) {
    const artifact = options.manifest.artifacts.find((candidate) => candidate.id === id);
    if (!artifact) throw failure("E_DEPENDENCY_MANIFEST", `清单中缺少 ${id}`);
    await installOne(artifact, options.toolsDirectory);
    installed.push({ id, version: artifact.version });
  }
  return { installed };
}
