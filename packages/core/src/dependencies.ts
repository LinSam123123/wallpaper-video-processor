import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "./errors.js";
import { runCommand, type CommandRunner } from "./process-runner.js";

export interface DependencyDescriptor {
  id: "ffmpeg" | "realesrgan" | "rife";
  displayName: string;
  version: string;
  sourcePage: string;
  downloadUrl: string;
  license: string;
  licenseUrl: string;
  approximateSizeBytes: number;
}

export interface DependencyCatalogEntry extends DependencyDescriptor {
  installable: boolean;
}

export interface DependencyArtifact extends DependencyDescriptor {
  sha256: string;
  archive: "zip" | "tar.xz";
  executablePaths: string[];
}

export interface DependencyManifest {
  schemaVersion: 1;
  platform: "win32-x64";
  artifacts: DependencyArtifact[];
}

export interface InstalledDependency {
  id: DependencyArtifact["id"];
  version: string;
  installDirectory: string;
  executables: string[];
}

export const WINDOWS_DEPENDENCY_CATALOG: readonly DependencyCatalogEntry[] = [
  {
    id: "ffmpeg",
    displayName: "FFmpeg essentials build",
    version: "7.1.1",
    sourcePage: "https://www.gyan.dev/ffmpeg/builds/",
    downloadUrl: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-7.1.1-essentials_build.zip",
    license: "GPL-3.0-or-later",
    licenseUrl: "https://www.ffmpeg.org/legal.html",
    approximateSizeBytes: 100_000_000,
    installable: false,
  },
  {
    id: "realesrgan",
    displayName: "Real-ESRGAN ncnn Vulkan",
    version: "0.2.5.0",
    sourcePage: "https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0",
    downloadUrl: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip",
    license: "BSD-3-Clause",
    licenseUrl: "https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE",
    approximateSizeBytes: 5_500_000,
    installable: false,
  },
  {
    id: "rife",
    displayName: "RIFE ncnn Vulkan",
    version: "20221029",
    sourcePage: "https://github.com/nihui/rife-ncnn-vulkan/releases/tag/20221029",
    downloadUrl: "https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip",
    license: "MIT",
    licenseUrl: "https://github.com/nihui/rife-ncnn-vulkan/blob/master/LICENSE",
    approximateSizeBytes: 412_000_000,
    installable: false,
  },
] as const;

export function validateDependencyManifest(value: unknown): DependencyManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("E_DEPENDENCY_MANIFEST", "Dependency manifest must be an object");
  }
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 1 || source.platform !== "win32-x64" || !Array.isArray(source.artifacts)) {
    throw new AppError("E_DEPENDENCY_MANIFEST", "Unsupported dependency manifest schema or platform");
  }
  const seen = new Set<string>();
  const artifacts = source.artifacts.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AppError("E_DEPENDENCY_MANIFEST", `artifacts[${index}] must be an object`);
    }
    const artifact = item as Record<string, unknown>;
    const id = artifact.id;
    if (id !== "ffmpeg" && id !== "realesrgan" && id !== "rife") {
      throw new AppError("E_DEPENDENCY_MANIFEST", `Unsupported dependency id: ${String(id)}`);
    }
    if (seen.has(id)) throw new AppError("E_DEPENDENCY_MANIFEST", `Duplicate dependency id: ${id}`);
    seen.add(id);
    const requiredStrings = ["displayName", "version", "sourcePage", "downloadUrl", "license", "licenseUrl", "sha256"] as const;
    for (const key of requiredStrings) {
      if (typeof artifact[key] !== "string" || artifact[key].length === 0) {
        throw new AppError("E_DEPENDENCY_MANIFEST", `artifacts[${index}].${key} must be a non-empty string`);
      }
    }
    if (!/^https:\/\//.test(String(artifact.downloadUrl))) {
      throw new AppError("E_DEPENDENCY_MANIFEST", `artifacts[${index}].downloadUrl must use HTTPS`);
    }
    if (!/^[a-fA-F0-9]{64}$/.test(String(artifact.sha256))) {
      throw new AppError("E_DEPENDENCY_MANIFEST", `artifacts[${index}].sha256 must be a fixed SHA-256 digest`);
    }
    if (artifact.archive !== "zip" && artifact.archive !== "tar.xz") {
      throw new AppError("E_DEPENDENCY_MANIFEST", `artifacts[${index}].archive is unsupported`);
    }
    if (!Array.isArray(artifact.executablePaths) || artifact.executablePaths.length === 0 ||
        !artifact.executablePaths.every((entry) => typeof entry === "string" && entry.length > 0)) {
      throw new AppError("E_DEPENDENCY_MANIFEST", `artifacts[${index}].executablePaths must contain paths`);
    }
    if (typeof artifact.approximateSizeBytes !== "number" || artifact.approximateSizeBytes <= 0) {
      throw new AppError("E_DEPENDENCY_MANIFEST", `artifacts[${index}].approximateSizeBytes must be positive`);
    }
    return artifact as unknown as DependencyArtifact;
  });
  return { schemaVersion: 1, platform: "win32-x64", artifacts };
}

export async function loadDependencyManifest(path: string): Promise<DependencyManifest> {
  try {
    return validateDependencyManifest(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("E_DEPENDENCY_MANIFEST", `Could not load dependency manifest: ${path}`, undefined, { cause: error });
  }
}

export function assertSafeArchiveEntry(entry: string, destination: string): string {
  if (!entry || entry.includes("\0")) throw new AppError("E_UNSAFE_ARCHIVE", "Archive contains an invalid empty or NUL path");
  const portable = entry.replaceAll("\\", "/");
  if (portable.startsWith("/") || isAbsolute(entry) || win32.isAbsolute(entry) || /^[a-zA-Z]:/.test(portable)) {
    throw new AppError("E_UNSAFE_ARCHIVE", `Archive contains an absolute path: ${entry}`);
  }
  const parts = portable.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new AppError("E_UNSAFE_ARCHIVE", `Archive path escapes its destination: ${entry}`);
  }
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (parts.some((part) => part.includes(":") || part.endsWith(".") || part.endsWith(" ") || reserved.test(part))) {
    throw new AppError("E_UNSAFE_ARCHIVE", `Archive contains an unsafe Windows path: ${entry}`);
  }
  const root = resolve(destination);
  const candidate = resolve(root, ...parts);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new AppError("E_UNSAFE_ARCHIVE", `Archive path escapes its destination: ${entry}`);
  }
  return candidate;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function downloadAndVerify(
  artifact: DependencyArtifact,
  directory: string,
  options: { consent: boolean; signal?: AbortSignal; fetchImpl?: typeof fetch } = { consent: false },
): Promise<string> {
  if (!options.consent) {
    throw new AppError("E_INVALID_ARGUMENT", `Downloading ${artifact.displayName} requires explicit consent`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(directory, { recursive: true });
  const extension = artifact.archive === "zip" ? ".zip" : ".tar.xz";
  const finalPath = join(directory, `${artifact.id}-${artifact.version}${extension}`);
  try {
    if (await sha256File(finalPath).catch(() => "") === artifact.sha256.toLowerCase()) return finalPath;
    await rm(finalPath, { force: true });
    const partialPath = `${finalPath}.${randomUUID()}.partial`;
    try {
      const response = await fetchImpl(artifact.downloadUrl, { signal: options.signal, redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new AppError("E_DOWNLOAD_FAILED", `Download failed with HTTP ${response.status}`, {
          url: artifact.downloadUrl,
          status: response.status,
        });
      }
      if (response.url && !response.url.startsWith("https://")) {
        throw new AppError("E_DOWNLOAD_FAILED", "Dependency download redirected to a non-HTTPS URL", { url: response.url });
      }
      const body = Readable.fromWeb(
        response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
      );
      await pipeline(body, createWriteStream(partialPath, { flags: "wx" }), { signal: options.signal });
      const digest = await sha256File(partialPath);
      if (digest.toLowerCase() !== artifact.sha256.toLowerCase()) {
        throw new AppError("E_CHECKSUM_MISMATCH", `SHA-256 mismatch for ${artifact.displayName}`, {
          expected: artifact.sha256.toLowerCase(),
          actual: digest.toLowerCase(),
        });
      }
      await rename(partialPath, finalPath);
      return finalPath;
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (options.signal?.aborted) throw new AppError("E_CANCELLED", "Dependency download cancelled");
    throw new AppError("E_DOWNLOAD_FAILED", `Could not download ${artifact.displayName}`, undefined, { cause: error });
  }
}

async function rejectLinksAndEscapes(root: string, current = root): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    assertSafeArchiveEntry(relative(root, path), root);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new AppError("E_UNSAFE_ARCHIVE", `Archive contains a symbolic link: ${path}`);
    if (info.isDirectory()) await rejectLinksAndEscapes(root, path);
  }
}

export async function safeExtractArchive(
  archivePath: string,
  destination: string,
  options: { tarPath?: string; runner?: CommandRunner; signal?: AbortSignal } = {},
): Promise<void> {
  const runner = options.runner ?? runCommand;
  const tarPath = options.tarPath ?? "tar";
  const list = await runner({ executable: tarPath, args: ["-tf", archivePath] }, { signal: options.signal });
  const entries = list.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) throw new AppError("E_UNSAFE_ARCHIVE", "Archive is empty");
  for (const entry of entries) assertSafeArchiveEntry(entry, destination);
  const verboseList = await runner({ executable: tarPath, args: ["-tvf", archivePath] }, { signal: options.signal });
  const unsafeType = verboseList.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .find((line) => /^[lhbcps]/i.test(line.trimStart()));
  if (unsafeType) throw new AppError("E_UNSAFE_ARCHIVE", `Archive contains a link or special file: ${unsafeType}`);

  const parent = dirname(resolve(destination));
  const staging = join(parent, `.${basename(destination)}-${randomUUID()}.extracting`);
  await mkdir(parent, { recursive: true });
  await mkdir(staging, { recursive: false });
  try {
    await runner({
      executable: tarPath,
      args: ["--no-same-owner", "--no-same-permissions", "-xf", archivePath, "-C", staging],
    }, { signal: options.signal });
    await rejectLinksAndEscapes(staging);
    const topLevel = await readdir(staging, { withFileTypes: true });
    const contentRoot = topLevel.length === 1 && topLevel[0]?.isDirectory()
      ? join(staging, topLevel[0].name)
      : staging;
    await access(destination).then(
      () => { throw new AppError("E_IO", `Install destination already exists: ${destination}`); },
      () => undefined,
    );
    await rename(contentRoot, destination);
    if (contentRoot !== staging) await rm(staging, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function installDependency(
  artifact: DependencyArtifact,
  toolsDirectory: string,
  options: {
    consent: boolean;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    tarPath?: string;
    runner?: CommandRunner;
  },
): Promise<InstalledDependency> {
  const installDirectory = join(toolsDirectory, `${artifact.id}-${artifact.version}`);
  const expectedExecutables = artifact.executablePaths.map((path) => assertSafeArchiveEntry(path, installDirectory));
  if ((await Promise.all(expectedExecutables.map((path) => access(path).then(() => true, () => false)))).every(Boolean)) {
    return { id: artifact.id, version: artifact.version, installDirectory, executables: expectedExecutables };
  }
  const downloads = join(toolsDirectory, ".downloads");
  const archive = await downloadAndVerify(artifact, downloads, options);
  await safeExtractArchive(archive, installDirectory, options);
  const executables = artifact.executablePaths.map((path) => assertSafeArchiveEntry(path, installDirectory));
  for (const executable of executables) {
    try {
      await access(executable, constantsForExecutable());
    } catch (error) {
      throw new AppError("E_DEPENDENCY_MANIFEST", `Expected executable was not found after extraction: ${executable}`, undefined, { cause: error });
    }
  }
  return { id: artifact.id, version: artifact.version, installDirectory, executables };
}

export async function installDependenciesFromManifest(
  manifestValue: DependencyManifest | unknown,
  ids: Array<DependencyArtifact["id"]>,
  toolsDirectory: string,
  options: {
    consent: boolean;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    tarPath?: string;
    runner?: CommandRunner;
  },
): Promise<InstalledDependency[]> {
  if (!options.consent) throw new AppError("E_INVALID_ARGUMENT", "Dependency installation requires explicit consent");
  const manifest = validateDependencyManifest(manifestValue);
  const uniqueIds = [...new Set(ids)];
  const results: InstalledDependency[] = [];
  for (const id of uniqueIds) {
    const artifact = manifest.artifacts.find((item) => item.id === id);
    if (!artifact) throw new AppError("E_DEPENDENCY_MANIFEST", `Manifest has no reviewed artifact for ${id}`);
    results.push(await installDependency(artifact, toolsDirectory, options));
  }
  return results;
}

function constantsForExecutable(): number {
  return process.platform === "win32" ? 0 : 1;
}
