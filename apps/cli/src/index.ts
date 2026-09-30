#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AppError,
  defaultCacheDirectory,
  doctor,
  diagnosticPreviewVideo,
  loopPreviewVideo,
  cleanupFrameCache,
  inspectCache,
  inspectMedia,
  parseJobSpec,
  parseVerificationExpectation,
  previewVideo,
  processVideo,
  runCacheMaintenance,
  resolveBinaryPaths,
  toAppError,
  verifyMedia,
  type BinaryPaths,
  type NormalizedJobSpec,
  type PipelineOptions,
  type ProgressEvent,
} from "@wallpaper-video/core";
import { optionalNumberFlag, optionalStringFlag, parseArguments, previewOptionsFromFlags, requiredFlag } from "./arguments.js";

const HELP = `AI Video Wallpaper CLI

Usage:
  wallpaper-video doctor [--json] [--cache PATH]
  wallpaper-video inspect --input VIDEO [--json] [--ffprobe PATH]
  wallpaper-video preview --config JOB.json [--preview-mode segment|loop-boundary] [--turn start|end] [--center SEC] [--frames N] [--output VIDEO] [--work-dir PATH] [--json]
  wallpaper-video diagnostic-preview --config JOB.json --output-dir PATH [--preview-mode segment|loop-boundary] [--turn start|end] [--center SEC] [--frames N] [--work-dir PATH] [--json]
  wallpaper-video loop-preview --config JOB.json --output-dir PATH [--frames N] [--work-dir PATH] [--json]
  wallpaper-video process --config JOB.json [--work-dir PATH] [--json]
  wallpaper-video verify --input VIDEO --expected JSON_OR_PATH [--json]
  wallpaper-video cache-status --work-dir PATH [--cache-policy POLICY] [--cache-limit-bytes N] [--json]
  wallpaper-video cache-cleanup --work-dir PATH [--cache-policy POLICY] [--cache-limit-bytes N] [--force] [--json]
  wallpaper-video cache-delete --work-dir PATH --frame-cache-key KEY [--json]

Shared tool flags: --ffmpeg PATH --ffprobe PATH --realesrgan PATH --rife PATH --cache PATH
Processing flags: --work-dir PATH --cache-policy cleanup-on-success|keep-24-hours|keep-all --cache-limit-bytes N
`;

interface OutputWriter {
  json: boolean;
  value(value: unknown): void;
  progress(event: ProgressEvent): void;
}

export interface CliDependencies {
  doctor: typeof doctor;
  resolveBinaryPaths: typeof resolveBinaryPaths;
  inspectMedia: typeof inspectMedia;
  verifyMedia: typeof verifyMedia;
  inspectCache: typeof inspectCache;
  runCacheMaintenance: typeof runCacheMaintenance;
  cleanupFrameCache: typeof cleanupFrameCache;
  previewVideo: typeof previewVideo;
  diagnosticPreviewVideo: typeof diagnosticPreviewVideo;
  loopPreviewVideo: typeof loopPreviewVideo;
  processVideo: typeof processVideo;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

const DEFAULT_CLI_DEPENDENCIES: CliDependencies = {
  doctor,
  resolveBinaryPaths,
  inspectMedia,
  verifyMedia,
  inspectCache,
  runCacheMaintenance,
  cleanupFrameCache,
  previewVideo,
  diagnosticPreviewVideo,
  loopPreviewVideo,
  processVideo,
  writeStdout: (text) => { process.stdout.write(text); },
  writeStderr: (text) => { process.stderr.write(text); },
};

const PROCESS_PREVIEW_ONLY_FLAGS = ["preview-mode", "turn", "center", "frames", "output", "output-dir"] as const;

function writer(json: boolean, dependencies: CliDependencies): OutputWriter {
  return {
    json,
    value(value) {
      dependencies.writeStdout(`${JSON.stringify(value, null, json ? 0 : 2)}\n`);
    },
    progress(event) {
      if (json) dependencies.writeStdout(`${JSON.stringify(event)}\n`);
      else dependencies.writeStderr(`\r${event.phase.padEnd(10)} ${event.percent.toFixed(1).padStart(6)}% ${event.message}`);
    },
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new AppError("E_INVALID_CONFIG", `Could not read JSON: ${path}`, undefined, { cause: error });
  }
}

export interface LoadedJobSpec {
  rawSpec: unknown;
  normalizedSpec: NormalizedJobSpec;
}

export async function loadJobSpec(configPath: string): Promise<LoadedJobSpec> {
  const absoluteConfig = resolve(configPath);
  const raw = await readJson(absoluteConfig);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { rawSpec: raw, normalizedSpec: parseJobSpec(raw) };
  }
  const value = { ...(raw as Record<string, unknown>) };
  const directory = dirname(absoluteConfig);
  if (typeof value.inputPath === "string" && !isAbsolute(value.inputPath)) value.inputPath = resolve(directory, value.inputPath);
  if (typeof value.outputPath === "string" && !isAbsolute(value.outputPath)) value.outputPath = resolve(directory, value.outputPath);
  return { rawSpec: value, normalizedSpec: parseJobSpec(value) };
}

function binariesFromFlags(flags: Map<string, string | true>): Partial<BinaryPaths> {
  const result: Partial<BinaryPaths> = {};
  for (const name of ["ffmpeg", "ffprobe", "realesrgan", "rife"] as const) {
    const value = flags.get(name);
    if (typeof value === "string") result[name] = resolve(value);
  }
  return result;
}

function cacheFromFlags(flags: Map<string, string | true>): string {
  const value = flags.get("cache");
  return typeof value === "string" ? resolve(value) : defaultCacheDirectory();
}

function cachePolicyFromFlags(flags: Map<string, string | true>): "cleanup-on-success" | "keep-24-hours" | "keep-all" | undefined {
  const value = optionalStringFlag(flags, "cache-policy");
  if (value === undefined) return undefined;
  if (value !== "cleanup-on-success" && value !== "keep-24-hours" && value !== "keep-all") {
    throw new AppError("E_INVALID_ARGUMENT", "--cache-policy must be cleanup-on-success, keep-24-hours, or keep-all");
  }
  return value;
}

async function expectedFromFlag(value: string): Promise<unknown> {
  if (value.trimStart().startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new AppError("E_INVALID_CONFIG", "--expected contains invalid JSON", undefined, { cause: error });
    }
  }
  return await readJson(resolve(value));
}

function exitCode(error: AppError): number {
  if (error.code === "E_CANCELLED") return 130;
  if (error.code === "E_INVALID_ARGUMENT" || error.code === "E_INVALID_CONFIG") return 2;
  if (error.code === "E_DEPENDENCY_MISSING") return 3;
  if (error.code === "E_VERIFICATION_FAILED") return 4;
  return 1;
}

export async function runCli(
  argv = process.argv.slice(2),
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const dependencies: CliDependencies = { ...DEFAULT_CLI_DEPENDENCIES, ...overrides };
  let output = writer(false, dependencies);
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    const { command, flags } = parseArguments(argv);
    output = writer(flags.has("json"), dependencies);
    if (!command || command === "help" || flags.has("help")) {
      dependencies.writeStdout(HELP);
      return 0;
    }
    const cacheDirectory = cacheFromFlags(flags);
    const binaryOverrides = binariesFromFlags(flags);
    const cachePolicy = cachePolicyFromFlags(flags);
    const cacheLimitBytes = optionalNumberFlag(flags, "cache-limit-bytes");
    if (command === "doctor") {
      const report = await dependencies.doctor({ cacheDirectory, binaries: binaryOverrides });
      output.value(report);
      return 0;
    }
    if (command === "inspect") {
      const paths = await dependencies.resolveBinaryPaths(cacheDirectory, binaryOverrides);
      output.value(await dependencies.inspectMedia(requiredFlag(flags, "input"), {
        ffprobePath: paths.ffprobe,
        signal: controller.signal,
      }));
      return 0;
    }
    if (command === "verify") {
      const paths = await dependencies.resolveBinaryPaths(cacheDirectory, binaryOverrides);
      const expectation = parseVerificationExpectation(await expectedFromFlag(requiredFlag(flags, "expected")));
      const result = await dependencies.verifyMedia(requiredFlag(flags, "input"), expectation, {
        ffmpegPath: paths.ffmpeg ?? "ffmpeg",
        ffprobePath: paths.ffprobe,
        signal: controller.signal,
        fullDecode: true,
      });
      output.value(result);
      return result.passed ? 0 : 4;
    }
    if (command === "cache-status" || command === "cache-cleanup") {
      const workDirectory = resolve(requiredFlag(flags, "work-dir"));
      const cacheOptions = { cachePolicy, cacheLimitBytes };
      const result = command === "cache-status"
        ? await dependencies.inspectCache(workDirectory, { policy: cacheOptions.cachePolicy, limitBytes: cacheOptions.cacheLimitBytes })
        : await dependencies.runCacheMaintenance(workDirectory, {
          policy: cacheOptions.cachePolicy,
          limitBytes: cacheOptions.cacheLimitBytes,
          force: flags.has("force"),
        });
      output.value(result);
      return 0;
    }
    if (command === "cache-delete") {
      const workDirectory = resolve(requiredFlag(flags, "work-dir"));
      await dependencies.cleanupFrameCache(requiredFlag(flags, "frame-cache-key"), workDirectory);
      output.value(await dependencies.inspectCache(workDirectory, { policy: cachePolicy, limitBytes: cacheLimitBytes }));
      return 0;
    }
    if (command === "preview" || command === "diagnostic-preview" || command === "loop-preview" || command === "process") {
      const invalidProcessFlags = command === "process"
        ? PROCESS_PREVIEW_ONLY_FLAGS.filter((name) => flags.has(name))
        : [];
      if (invalidProcessFlags.length > 0) {
        throw new AppError(
          "E_INVALID_ARGUMENT",
          `${invalidProcessFlags.map((name) => `--${name}`).join(", ")} ${invalidProcessFlags.length === 1 ? "is" : "are"} only supported by preview commands`,
        );
      }
      if (command === "loop-preview" && (flags.has("preview-mode") || flags.has("turn") || flags.has("center"))) {
        throw new AppError("E_INVALID_ARGUMENT", "loop-preview always generates all loop boundaries; only --frames is supported");
      }
      const { rawSpec, normalizedSpec } = await loadJobSpec(requiredFlag(flags, "config"));
      const previewOptions = command === "process" || command === "loop-preview"
        ? undefined
        : previewOptionsFromFlags(flags, normalizedSpec.loopMode);
      const workDirectory = optionalStringFlag(flags, "work-dir");
      const options: PipelineOptions = {
        cacheDirectory,
        workDirectory: workDirectory === undefined ? undefined : resolve(workDirectory),
        binaries: binaryOverrides,
        signal: controller.signal,
        onProgress: (event: ProgressEvent) => output.progress(event),
        cachePolicy,
        cacheLimitBytes,
      };
      const result = command === "preview"
        ? await dependencies.previewVideo(rawSpec, {
          ...previewOptions,
          outputPath: typeof flags.get("output") === "string" ? String(flags.get("output")) : undefined,
        }, options)
        : command === "diagnostic-preview"
          ? await dependencies.diagnosticPreviewVideo(rawSpec, {
            ...previewOptions,
            outputDirectory: requiredFlag(flags, "output-dir"),
          }, options)
          : command === "loop-preview"
            ? await dependencies.loopPreviewVideo(rawSpec, {
              outputDirectory: requiredFlag(flags, "output-dir"),
              frameCount: optionalNumberFlag(flags, "frames"),
            }, options)
          : await dependencies.processVideo(rawSpec, options);
      if (!output.json) dependencies.writeStderr("\n");
      output.value(result);
      return 0;
    }
    throw new AppError("E_INVALID_ARGUMENT", `Unknown command: ${command}`);
  } catch (error) {
    const appError = toAppError(error);
    if (!output.json) dependencies.writeStderr("\n");
    dependencies.writeStderr(`${JSON.stringify(appError.toJSON(), null, output.json ? 0 : 2)}\n`);
    return exitCode(appError);
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  return await runCli(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
