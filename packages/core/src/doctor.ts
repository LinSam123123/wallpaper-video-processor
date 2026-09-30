import { constants } from "node:fs";
import { access, mkdir, open, readdir, rm } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand, type CommandRunner } from "./process-runner.js";
import type { BinaryPaths, DoctorReport, ToolStatus } from "./types.js";
import { SUPPORTED_JOB_SPEC_VERSIONS } from "./types.js";

export const H264_NVENC_MAX_DIMENSION = 4096 as const;

export async function probeH264Nvenc(
  ffmpegPath: string | undefined,
  runner: CommandRunner = runCommand,
): Promise<{ available: boolean; maxDimension: 4096; error?: string }> {
  if (!ffmpegPath) {
    return { available: false, maxDimension: H264_NVENC_MAX_DIMENSION, error: "FFmpeg is unavailable" };
  }
  try {
    await runner({
      executable: ffmpegPath,
      args: [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=256x256:r=1",
        "-frames:v", "1", "-an",
        "-c:v", "h264_nvenc", "-profile:v", "high",
        "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "17", "-b:v", "0",
        "-pix_fmt", "yuv420p", "-f", "null", "-",
      ],
    });
    return { available: true, maxDimension: H264_NVENC_MAX_DIMENSION };
  } catch (error) {
    return {
      available: false,
      maxDimension: H264_NVENC_MAX_DIMENSION,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function defaultCacheDirectory(): string {
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? process.cwd(), ".cache");
  return join(base, "AI Video Wallpaper");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(name: string, candidates: string[] = []): Promise<string | null> {
  const suffix = process.platform === "win32" && !name.toLowerCase().endsWith(".exe") ? ".exe" : "";
  const executable = name + suffix;
  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory.replace(/^"|"$/g, ""), executable));
  for (const candidate of [...candidates, ...pathCandidates]) {
    const absolute = resolve(candidate);
    if (await isExecutable(absolute)) return absolute;
  }
  return null;
}

async function findInstalledExecutable(root: string, executableName: string, maxDepth = 4): Promise<string | null> {
  const visit = async (directory: string, depth: number): Promise<string | null> => {
    if (depth > maxDepth) return null;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const direct = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === executableName.toLowerCase());
    if (direct) return join(directory, direct.name);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = await visit(join(directory, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return await visit(root, 0);
}

export async function resolveBinaryPaths(
  cacheDirectory = defaultCacheDirectory(),
  overrides: Partial<BinaryPaths> = {},
): Promise<Partial<BinaryPaths>> {
  const tools = join(cacheDirectory, "tools");
  const installedFfmpeg = await findInstalledExecutable(tools, "ffmpeg.exe");
  const installedFfprobe = await findInstalledExecutable(tools, "ffprobe.exe");
  const installedRealesrgan = await findInstalledExecutable(tools, "realesrgan-ncnn-vulkan.exe");
  const installedRife = await findInstalledExecutable(tools, "rife-ncnn-vulkan.exe");
  const ffmpeg = overrides.ffmpeg ?? await findExecutable("ffmpeg", [
    join(tools, "ffmpeg", "bin", "ffmpeg.exe"),
    join(tools, "ffmpeg", "ffmpeg.exe"),
    ...(installedFfmpeg ? [installedFfmpeg] : []),
  ]);
  const ffprobe = overrides.ffprobe ?? await findExecutable("ffprobe", [
    join(tools, "ffmpeg", "bin", "ffprobe.exe"),
    join(tools, "ffmpeg", "ffprobe.exe"),
    ...(installedFfprobe ? [installedFfprobe] : []),
  ]);
  const realesrgan = overrides.realesrgan ?? await findExecutable("realesrgan-ncnn-vulkan", [
    join(tools, "realesrgan", "realesrgan-ncnn-vulkan.exe"),
    ...(installedRealesrgan ? [installedRealesrgan] : []),
  ]);
  const rife = overrides.rife ?? await findExecutable("rife-ncnn-vulkan", [
    join(tools, "rife", "rife-ncnn-vulkan.exe"),
    ...(installedRife ? [installedRife] : []),
  ]);
  return {
    ...(ffmpeg ? { ffmpeg } : {}),
    ...(ffprobe ? { ffprobe } : {}),
    ...(realesrgan ? { realesrgan } : {}),
    ...(rife ? { rife } : {}),
  };
}

async function toolStatus(
  name: keyof BinaryPaths,
  path: string | undefined,
  runner: CommandRunner,
): Promise<ToolStatus> {
  if (!path) return { name, available: false, path: null, version: null, error: "not found" };
  const args = name === "realesrgan" || name === "rife" ? ["-h"] : ["-version"];
  try {
    const acceptedExitCodes = name === "realesrgan" || name === "rife" ? [0, 1, -1, 0xffffffff] : [0, 1];
    const result = await runner({ executable: path, args }, { acceptedExitCodes });
    const firstLine = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "available";
    if (name === "rife") {
      const modelDirectory = join(dirname(path), "rife-v4.6");
      const requiredModelFiles = ["flownet.bin", "flownet.param"].map((file) => join(modelDirectory, file));
      const missingModelFiles: string[] = [];
      for (const modelFile of requiredModelFiles) {
        if (!await pathExists(modelFile)) missingModelFiles.push(modelFile);
      }
      if (missingModelFiles.length > 0) {
        return {
          name,
          available: false,
          path,
          version: firstLine,
          error: `model files not found: ${missingModelFiles.join(", ")}`,
        };
      }
    }
    return { name, available: true, path, version: firstLine };
  } catch (error) {
    return { name, available: false, path, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkWritable(directory: string): Promise<boolean> {
  const marker = join(directory, `.doctor-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    const handle = await open(marker, "wx");
    await handle.close();
    await rm(marker);
    return true;
  } catch {
    await rm(marker, { force: true }).catch(() => undefined);
    return false;
  }
}

export async function doctor(options: {
  cacheDirectory?: string;
  binaries?: Partial<BinaryPaths>;
  runner?: CommandRunner;
} = {}): Promise<DoctorReport> {
  const cacheDirectory = resolve(options.cacheDirectory ?? defaultCacheDirectory());
  const runner = options.runner ?? runCommand;
  const binaries = await resolveBinaryPaths(cacheDirectory, options.binaries);
  const tools = await Promise.all([
    toolStatus("ffmpeg", binaries.ffmpeg, runner),
    toolStatus("ffprobe", binaries.ffprobe, runner),
    toolStatus("realesrgan", binaries.realesrgan, runner),
    toolStatus("rife", binaries.rife, runner),
  ]);
  const h264Nvenc = await probeH264Nvenc(binaries.ffmpeg, runner);
  const cacheWritable = await checkWritable(cacheDirectory);
  const recommendations: string[] = [];
  if (!tools.find((tool) => tool.name === "ffmpeg")?.available) recommendations.push("Install or configure FFmpeg.");
  if (!tools.find((tool) => tool.name === "ffprobe")?.available) recommendations.push("Install or configure ffprobe.");
  if (!tools.find((tool) => tool.name === "realesrgan")?.available) recommendations.push("Install Real-ESRGAN for AI upscaling; Lanczos remains available.");
  if (!tools.find((tool) => tool.name === "rife")?.available) recommendations.push("Install RIFE ncnn Vulkan to enable AI frame interpolation.");
  if (!cacheWritable) recommendations.push(`Make the cache directory writable: ${dirname(cacheDirectory)}`);
  return {
    ok: cacheWritable && tools.filter((tool) => tool.name !== "realesrgan" && tool.name !== "rife").every((tool) => tool.available),
    platform: process.platform,
    arch: process.arch,
    cacheDirectory,
    cacheWritable,
    tools,
    recommendations,
    capabilities: {
      jobSpecVersions: [...SUPPORTED_JOB_SPEC_VERSIONS],
      previewModes: ["segment", "loop-boundary"],
      h264Nvenc,
    },
  };
}
