import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { AppError, toAppError } from "./errors.js";
import {
  analyzeFrameRisks,
  detectorRevision,
  frameRiskCaptureBytes,
  parseFfmpegFrameMetadata,
  selectDiagnosticRiskPreview,
  type FrameRiskAnalysis,
  type FrameRiskPreview,
} from "./frame-risk.js";
import {
  acquireJobLock,
  acquireFrameCacheWriteLock,
  cleanupOneFrameCache,
  DEFAULT_CACHE_LIMIT_BYTES,
  DEFAULT_CACHE_POLICY,
  inspectCache,
  registerFrameCacheUse,
  releaseFrameCacheUse,
  runCacheMaintenance,
  type JobLockHandle,
} from "./cache-manager.js";
import { resolveBinaryPaths, defaultCacheDirectory } from "./doctor.js";
import {
  assertNotCancelled,
  buildFrameSequence,
  clearCancellation,
  createJobId,
  ensureDiskSpace,
  fingerprintInput,
  frameFileName,
  linkOrCopy,
  loadJobState,
  jobSpecIdentity,
  requestCancellation,
  sameFilesystem,
  saveJobState,
  type JobState,
} from "./job-state.js";
import { inspectMedia, verifyMedia } from "./media.js";
import { validatePng, type PngDimensions } from "./png.js";
import {
  buildFfmpegVideoFilter,
  cacheKey,
  durationForFrames,
  estimateDiskUsage,
  frameCacheKey as createFrameCacheKey,
  interpolatedForwardFrameCount,
  interpolatedOutputFrameCount,
  interpolationFrameMap,
  makeProgressEvent,
  pingPongIndices,
  projectFrameStorage,
  rifeDirectoryArguments,
  selectAiScale,
  tileFallbackOrder,
  videoEncoderArguments,
} from "./pure.js";
import { LineAccumulator, runCommand, type CommandRunner } from "./process-runner.js";
import type {
  BinaryPaths,
  JobSpec,
  MediaInfo,
  NormalizedJobSpec,
  PreviewOptions,
  PreviewResult,
  ProcessResult,
  ProgressListener,
  ProgressPhase,
  SpaceBudget,
  VerificationExpectation,
  CachePolicy,
  DiagnosticPreviewResult,
  DiagnosticPreviewVariant,
  LoopPreviewResult,
  LoopPreviewVariant,
  LoopTurn,
  PreviewBoundary,
  PreviewMode,
  SourceFrameRange,
} from "./types.js";
import { assertEncoderResolutionSupported, parseJobSpec } from "./validation.js";

export interface PipelineOptions {
  cacheDirectory?: string;
  workDirectory?: string;
  binaries?: Partial<BinaryPaths>;
  runner?: CommandRunner;
  signal?: AbortSignal;
  onProgress?: ProgressListener;
  now?: () => number;
  cachePolicy?: CachePolicy;
  cacheLimitBytes?: number;
}

interface PreparedJob {
  spec: NormalizedJobSpec;
  media: MediaInfo;
  sourceFps: number;
  fps: number;
  jobId: string;
  jobDirectory: string;
  workDirectory: string;
  frameCacheKey: string;
  actualAiScale: number;
  sourceRange: SourceFrameRange;
  sourceDirectory: string;
  interpolatedDirectory: string;
  enhancedDirectory: string;
  sequenceDirectory: string;
  binaries: BinaryPaths;
  state: JobState;
  resumed: boolean;
  preserveCompletedPhase: boolean;
  runner: CommandRunner;
  options: PipelineOptions;
}

interface ActivePreparedJob {
  job: PreparedJob;
  lock: JobLockHandle;
}

const runtimeIdentityCache = new Map<string, Promise<string>>();

async function runtimeFileIdentity(path: string, hashContents: boolean): Promise<string> {
  const absolute = resolve(path);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) return `unresolved:${absolute}`;

  // Model weights are part of the cache contract. Do not memoize their digest
  // by metadata: a replacement can preserve both size and mtime.
  if (hashContents) return `sha256:${await sha256File(absolute)}`;

  const identityKey = `${absolute}:${info.size}:${Math.round(info.mtimeMs)}:stat`;
  let pending = runtimeIdentityCache.get(identityKey);
  if (!pending) {
    pending = Promise.resolve(`file:${absolute}:${info.size}:${Math.round(info.mtimeMs)}`);
    runtimeIdentityCache.set(identityKey, pending);
  }
  return await pending;
}

function realesrganModelPaths(spec: NormalizedJobSpec, binaries: BinaryPaths, actualAiScale: number): string[] {
  const modelBase = spec.model === "realesr-animevideov3"
    ? `${spec.model}-x${actualAiScale}`
    : spec.model;
  return ["bin", "param"].map((extension) => join(dirname(binaries.realesrgan), "models", `${modelBase}.${extension}`));
}

async function frameRuntimeIdentity(
  spec: NormalizedJobSpec,
  binaries: BinaryPaths,
  actualAiScale: number,
): Promise<Record<string, string>> {
  const paths: Array<{ key: string; path: string; hashContents: boolean }> = [
    { key: "tool.ffmpeg", path: binaries.ffmpeg, hashContents: false },
    { key: "tool.ffprobe", path: binaries.ffprobe, hashContents: false },
  ];
  if (spec.upscaleBackend === "realesrgan-ncnn-vulkan" && actualAiScale > 1) {
    paths.push({ key: "tool.realesrgan", path: binaries.realesrgan, hashContents: false });
    for (const modelPath of realesrganModelPaths(spec, binaries, actualAiScale)) {
      const extension = modelPath.endsWith(".bin") ? "bin" : "param";
      paths.push({ key: `model.realesrgan.${extension}`, path: modelPath, hashContents: true });
    }
  }
  if (spec.interpolation.mode === "rife" && spec.interpolation.backend === "rife-ncnn-vulkan") {
    paths.push({ key: "tool.rife", path: binaries.rife, hashContents: false });
    const modelDirectory = join(dirname(binaries.rife), spec.interpolation.model);
    for (const file of ["flownet.bin", "flownet.param"]) {
      paths.push({ key: `model.rife.${file}`, path: join(modelDirectory, file), hashContents: true });
    }
  }
  return Object.fromEntries(await Promise.all(paths.map(async (entry) => [
    entry.key,
    await runtimeFileIdentity(entry.path, entry.hashContents),
  ])));
}

export function defaultWorkDirectory(outputPath: string): string {
  return join(dirname(resolve(outputPath)), ".ai-video-wallpaper-work");
}

export function selectPreviewFrameRange(
  media: MediaInfo,
  preview: PreviewOptions = {},
  sourceRange: SourceFrameRange = { startFrame: 0, endFrameExclusive: media.video.frameCount },
): { startFrame: number; frameCount: number } {
  const sourceFps = media.video.frameRate;
  const requestedCount = Math.max(1, Math.round(preview.frameCount ?? sourceFps * 2));
  const selectedFrameCount = sourceRange.endFrameExclusive - sourceRange.startFrame;
  const frameCount = Math.min(requestedCount, selectedFrameCount);
  const defaultCenter = (sourceRange.startFrame + selectedFrameCount / 2) / sourceFps;
  const requestedCenter = preview.centerSeconds ?? defaultCenter;
  const minimumCenter = sourceRange.startFrame / sourceFps;
  const maximumCenter = sourceRange.endFrameExclusive / sourceFps;
  const center = Math.min(maximumCenter, Math.max(minimumCenter, requestedCenter));
  const startFrame = Math.max(sourceRange.startFrame, Math.min(
    sourceRange.endFrameExclusive - frameCount,
    Math.round(center * sourceFps - frameCount / 2),
  ));
  return { startFrame, frameCount };
}

function emit(
  job: Pick<PreparedJob, "jobId" | "options">,
  phase: ProgressPhase,
  current: number,
  total: number,
  startedAtMs: number,
  message: string,
): void {
  job.options.onProgress?.(makeProgressEvent({
    jobId: job.jobId,
    phase,
    current,
    total,
    startedAtMs,
    nowMs: job.options.now?.(),
    message,
  }));
}

async function requireBinaries(
  spec: NormalizedJobSpec,
  options: PipelineOptions,
  cacheDirectory: string,
  requireUpscaler: boolean,
  actualAiScale = 1,
): Promise<BinaryPaths> {
  const found = await resolveBinaryPaths(cacheDirectory, options.binaries);
  const missing = ["ffmpeg", "ffprobe"]
    .filter((name) => !found[name as keyof BinaryPaths]);
  if (requireUpscaler && spec.upscaleBackend === "realesrgan-ncnn-vulkan" && !found.realesrgan) {
    missing.push("realesrgan");
  }
  const resolvedRealesrgan = found.realesrgan
    ? { ...found, ffmpeg: found.ffmpeg ?? "", ffprobe: found.ffprobe ?? "", rife: found.rife ?? "" } as BinaryPaths
    : null;
  const realesrganModelFiles = requireUpscaler && spec.upscaleBackend === "realesrgan-ncnn-vulkan" &&
      resolvedRealesrgan && await access(resolvedRealesrgan.realesrgan).then(() => true, () => false)
    ? realesrganModelPaths(spec, resolvedRealesrgan, actualAiScale)
    : [];
  const missingRealesrganModelFiles = (await Promise.all(realesrganModelFiles.map(async (path) => ({
    path,
    exists: await access(path).then(() => true, () => false),
  })))).filter((file) => !file.exists).map((file) => file.path);
  if (missingRealesrganModelFiles.length > 0) missing.push("realesrgan-model");
  if (spec.interpolation.mode === "rife" && spec.interpolation.backend === "rife-ncnn-vulkan" && !found.rife) {
    missing.push("rife");
  }
  const rifeModelPath = found.rife && spec.interpolation.backend === "rife-ncnn-vulkan"
    ? join(dirname(found.rife), spec.interpolation.model)
    : null;
  const missingRifeModelFiles = spec.interpolation.mode === "rife" &&
      spec.interpolation.backend === "rife-ncnn-vulkan" && rifeModelPath
    ? (await Promise.all(["flownet.bin", "flownet.param"].map(async (file) => ({
        path: join(rifeModelPath, file),
        exists: await access(join(rifeModelPath, file)).then(() => true, () => false),
      })))).filter((file) => !file.exists).map((file) => file.path)
    : [];
  if (spec.interpolation.mode === "rife" && spec.interpolation.backend === "rife-ncnn-vulkan" &&
      rifeModelPath && missingRifeModelFiles.length > 0) {
    missing.push("rife-model");
  }
  if (missing.length > 0) {
    throw new AppError("E_DEPENDENCY_MISSING", `Required tools are missing: ${missing.join(", ")}`, {
      missing,
      ...(missing.includes("rife-model") ? {
        model: spec.interpolation.model,
        expectedPath: rifeModelPath,
        missingFiles: missingRifeModelFiles,
      } : {}),
      ...(missing.includes("realesrgan-model") ? {
        model: spec.model,
        missingFiles: missingRealesrganModelFiles,
      } : {}),
    });
  }
  return {
    ffmpeg: found.ffmpeg as string,
    ffprobe: found.ffprobe as string,
    realesrgan: found.realesrgan ?? "realesrgan-ncnn-vulkan",
    rife: found.rife ?? "rife-ncnn-vulkan",
  };
}

async function prepareJob(
  spec: NormalizedJobSpec,
  options: PipelineOptions,
  identity?: {
    input: Awaited<ReturnType<typeof fingerprintInput>>;
    jobId: string;
    jobDirectory: string;
  },
): Promise<PreparedJob> {
  const cacheDirectory = resolve(options.cacheDirectory ?? defaultCacheDirectory());
  const workDirectory = resolve(options.workDirectory ?? defaultWorkDirectory(spec.outputPath));
  const runner = options.runner ?? runCommand;
  let binaries = await requireBinaries(spec, options, cacheDirectory, false);
  const input = identity?.input ?? await fingerprintInput(spec.inputPath);
  const jobId = identity?.jobId ?? createJobId(spec, input);
  const jobDirectory = identity?.jobDirectory ?? join(workDirectory, "jobs", jobId);
  await mkdir(jobDirectory, { recursive: true });
  await clearCancellation(jobDirectory);
  const startedAt = options.now?.() ?? Date.now();
  emit({ jobId, options }, "inspect", 0, 1, startedAt, "Inspecting source video");
  const media = await inspectMedia(spec.inputPath, { ffprobePath: binaries.ffprobe, runner, signal: options.signal });
  const sourceRange = spec.sourceRange ?? { startFrame: 0, endFrameExclusive: media.video.frameCount };
  if (sourceRange.startFrame >= media.video.frameCount || sourceRange.endFrameExclusive > media.video.frameCount) {
    throw new AppError("E_INVALID_CONFIG", "sourceRange is outside the source video", {
      sourceRange,
      sourceFrameCount: media.video.frameCount,
    });
  }
  if (spec.sourceRange && media.video.frameRateMode !== "constant") {
    throw new AppError(
      "E_UNSUPPORTED_MEDIA",
      "Frame-accurate source ranges require a confirmed constant-frame-rate video; convert this source to CFR first",
      { frameRateMode: media.video.frameRateMode, sourceRange },
    );
  }
  const selectedSourceFrameCount = sourceRange.endFrameExclusive - sourceRange.startFrame;
  const sourceFps = spec.sourceFps === "auto" ? media.video.frameRate : spec.sourceFps;
  const fps = sourceFps * spec.interpolation.factor;
  let actualAiScale = 1;
  if (spec.upscaleMode === "realesrgan") {
    try {
      actualAiScale = selectAiScale(
        { width: media.video.width, height: media.video.height },
        spec.target,
        spec.aspectMode,
        spec.model,
        spec.aiScale,
      );
    } catch (error) {
      throw new AppError("E_INVALID_CONFIG", error instanceof Error ? error.message : String(error), undefined, { cause: error });
    }
  }
  if (actualAiScale > 1) {
    binaries = await requireBinaries(spec, options, cacheDirectory, true, actualAiScale);
  }
  const runtimeIdentity = await frameRuntimeIdentity(spec, binaries, actualAiScale);
  const sharedFrameCacheKey = createFrameCacheKey({
    input,
    sourceFps,
    upscaleMode: spec.upscaleMode,
    model: spec.model,
    actualScale: actualAiScale,
    interpolation: spec.interpolation,
    sourceRange,
    upscaleBackend: spec.upscaleBackend,
    requestedTile: spec.tile,
    sceneDetectorRevision: detectorRevision,
    runtimeIdentity,
  });
  const sharedFrameDirectory = join(workDirectory, "frame-cache", sharedFrameCacheKey);
  const specHash = cacheKey(jobSpecIdentity(spec));
  const existing = await loadJobState(jobDirectory);
  if (existing && (existing.specHash !== specHash || existing.input.size !== input.size || existing.input.modifiedMs !== input.modifiedMs)) {
    throw new AppError("E_JOB_STATE", "Cached task state does not match this input and configuration", { jobId });
  }
  const timestamp = new Date().toISOString();
  const state: JobState = existing ?? {
    schemaVersion: 1,
    jobId,
    specHash,
    input,
    phase: "prepare",
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceFrameCount: selectedSourceFrameCount,
    completedUpscaleFrames: [],
    selectedTile: null,
    completedInterpolationFrames: [],
    detectedSceneCuts: [],
    outputFrameCount: interpolatedOutputFrameCount(
      selectedSourceFrameCount,
      spec.loopMode,
      spec.interpolation.factor,
    ),
    outputPath: resolve(spec.outputPath),
    spec,
    frameCacheKey: sharedFrameCacheKey,
    actualAiScale,
    lastError: null,
  };
  if (existing && existing.frameCacheKey !== sharedFrameCacheKey) {
    await clearJobSequenceCaches(jobDirectory);
    state.phase = "prepare";
    state.completedUpscaleFrames = [];
    state.selectedTile = null;
    state.completedInterpolationFrames = [];
    state.detectedSceneCuts = [];
    state.frameRiskAnalysis = undefined;
    state.frameRiskRange = undefined;
    state.spaceBudget = undefined;
    state.verifiedOutput = undefined;
  }
  state.sourceFrameCount = selectedSourceFrameCount;
  state.completedInterpolationFrames ??= [];
  state.detectedSceneCuts ??= [];
  state.outputFrameCount = interpolatedOutputFrameCount(
    selectedSourceFrameCount,
    spec.loopMode,
    spec.interpolation.factor,
  );
  state.spec = spec;
  state.frameCacheKey = sharedFrameCacheKey;
  state.actualAiScale = actualAiScale;
  state.lastError = null;
  await saveJobState(jobDirectory, state);
  emit({ jobId, options }, "inspect", 1, 1, startedAt, "Source video inspected");
  return {
    spec,
    media,
    sourceFps,
    fps,
    jobId,
    jobDirectory,
    workDirectory,
    frameCacheKey: sharedFrameCacheKey,
    actualAiScale,
    sourceRange,
    sourceDirectory: join(sharedFrameDirectory, "source-frames"),
    interpolatedDirectory: join(sharedFrameDirectory, "interpolated-frames"),
    enhancedDirectory: join(sharedFrameDirectory, "enhanced-frames"),
    sequenceDirectory: join(jobDirectory, "sequence"),
    binaries,
    state,
    resumed: existing !== null,
    preserveCompletedPhase: false,
    runner,
    options,
  };
}

async function beginPreparedJobFromSpec(spec: NormalizedJobSpec, options: PipelineOptions): Promise<ActivePreparedJob> {
  assertEncoderResolutionSupported(spec);
  const workDirectory = resolve(options.workDirectory ?? defaultWorkDirectory(spec.outputPath));
  await runCacheMaintenance(workDirectory, {
    policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
    limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
    now: options.now?.(),
  });
  const input = await fingerprintInput(spec.inputPath);
  const jobId = createJobId(spec, input);
  const jobDirectory = join(workDirectory, "jobs", jobId);
  await mkdir(jobDirectory, { recursive: true });
  const lock = await acquireJobLock(jobDirectory, jobId);
  try {
    const job = await prepareJob(spec, { ...options, workDirectory }, { input, jobId, jobDirectory });
    await registerFrameCacheUse({
      workDirectory: job.workDirectory,
      frameCacheKey: job.frameCacheKey,
      jobId: job.jobId,
      inputFingerprint: job.state.input,
      now: options.now?.(),
    });
    return { job, lock };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

async function beginPreparedJob(rawSpec: JobSpec | unknown, options: PipelineOptions): Promise<ActivePreparedJob> {
  return await beginPreparedJobFromSpec(parseJobSpec(rawSpec), options);
}

async function finishPreparedJob(
  active: ActivePreparedJob,
  outcome: "complete" | "recoverable",
): Promise<void> {
  const { job, lock } = active;
  await releaseFrameCacheUse({
    workDirectory: job.workDirectory,
    frameCacheKey: job.frameCacheKey,
    jobId: job.jobId,
    inputFingerprint: job.state.input,
    outcome,
    now: job.options.now?.(),
  }).catch(() => undefined);
  await lock.release();
}

async function savePhase(job: PreparedJob, phase: ProgressPhase): Promise<void> {
  if (!job.preserveCompletedPhase) job.state.phase = phase;
  await saveJobState(job.jobDirectory, job.state);
}

async function countFrames(directory: string): Promise<number> {
  return await readdir(directory).then(
    (entries) => entries.filter((entry) => /^frame_\d{8}\.png$/i.test(entry)).length,
    () => 0,
  );
}

async function selectedFrameSizes(directory: string, indices: number[], expected: PngDimensions): Promise<number[]> {
  const sizes: number[] = [];
  for (const index of indices) {
    const path = join(directory, frameFileName(index));
    if (!await validatePng(path, expected)) {
      await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    const size = await stat(path).then((info) => info.size, () => null);
    if (size !== null) sizes.push(size);
  }
  return sizes;
}

async function clearJobSequenceCaches(jobDirectory: string): Promise<void> {
  const entries = await readdir(jobDirectory, { withFileTypes: true }).catch(() => []);
  const sequenceNames = entries
    .map((entry) => entry.name)
    .filter((name) => name === "sequence" ||
      name.startsWith("preview-sequence-") ||
      name.startsWith("preview-boundary-sequence-"));
  await Promise.all(sequenceNames.map(async (name) => {
    await rm(join(jobDirectory, name), { recursive: true, force: true });
  }));
}

async function withFrameCacheWriteLock<T>(job: PreparedJob, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireFrameCacheWriteLock({
    workDirectory: job.workDirectory,
    frameCacheKey: job.frameCacheKey,
    jobId: job.jobId,
    signal: job.options.signal,
    assertNotCancelled: async () => await assertNotCancelled(job.jobDirectory, job.options.signal),
  });
  try {
    await assertNotCancelled(job.jobDirectory, job.options.signal);
    return await operation();
  } finally {
    await lock.release();
  }
}

function enhancedDirectoryForTile(job: PreparedJob, tile = job.state.selectedTile ?? job.spec.tile): string {
  return join(job.enhancedDirectory, `tile-${tile === 0 ? "auto" : tile}`);
}

async function createSpaceBudget(
  job: PreparedJob,
  sourceIndices: number[],
  processingIndices: number[],
  sequenceDirectory: string,
  sequenceFrameCount: number,
  outputPath: string,
  loopMode: "pingpong" | "none",
): Promise<SpaceBudget> {
  const usesAiUpscale = job.spec.upscaleMode === "realesrgan" && job.actualAiScale > 1;
  const estimate = estimateDiskUsage({
    sourceWidth: job.media.video.width,
    sourceHeight: job.media.video.height,
    targetWidth: job.spec.target.width,
    targetHeight: job.spec.target.height,
    sourceFrameCount: sourceIndices.length,
    loopMode,
    upscaleMode: usesAiUpscale ? "realesrgan" : "lanczos",
    upscaleFactor: job.actualAiScale,
    interpolationFactor: job.spec.interpolation.factor,
  });
  const sourceDimensions = { width: job.media.video.width, height: job.media.video.height };
  const enhancedDimensions = {
    width: job.media.video.width * job.actualAiScale,
    height: job.media.video.height * job.actualAiScale,
  };
  const sourceSizes = await selectedFrameSizes(job.sourceDirectory, sourceIndices, sourceDimensions);
  const interpolatedSizes = job.spec.interpolation.mode === "rife"
    ? await selectedFrameSizes(job.interpolatedDirectory, processingIndices, sourceDimensions)
    : [];
  const enhancedSizes = usesAiUpscale
    ? await selectedFrameSizes(enhancedDirectoryForTile(job), processingIndices, enhancedDimensions)
    : [];
  const source = projectFrameStorage(sourceSizes, sourceIndices.length, estimate.sourceFramesBytes);
  const interpolated = job.spec.interpolation.mode === "rife"
    ? projectFrameStorage(interpolatedSizes, processingIndices.length, estimate.interpolatedFramesBytes)
    : projectFrameStorage([], 0, 0);
  const enhanced = usesAiUpscale
    ? projectFrameStorage(enhancedSizes, processingIndices.length, estimate.enhancedFramesBytes)
    : projectFrameStorage([], 0, 0);
  const existingSequenceFrames = Math.min(sequenceFrameCount, await countFrames(sequenceDirectory));
  const sequenceRemainingBytes = Math.max(0, sequenceFrameCount - existingSequenceFrames) * 4096;
  const batchOverheadBytes = usesAiUpscale && enhanced.frameCount < processingIndices.length
    ? job.spec.batchSize * 8192
    : 0;
  const workRequiredBytes = source.remainingBytes + interpolated.remainingBytes + enhanced.remainingBytes + sequenceRemainingBytes + batchOverheadBytes;
  const outputRequiredBytes = Math.ceil(
    job.spec.target.width * job.spec.target.height * 1.5 * sequenceFrameCount * 0.18 * 1.15,
  );
  const outputDirectory = dirname(resolve(outputPath));
  await Promise.all([
    mkdir(job.workDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
  ]);
  const sameVolume = await sameFilesystem(job.workDirectory, outputDirectory);
  return {
    workDirectory: job.workDirectory,
    outputDirectory,
    sameVolume,
    source,
    interpolated,
    enhanced,
    sequenceRemainingBytes,
    batchOverheadBytes,
    workRequiredBytes,
    outputRequiredBytes,
    combinedRequiredBytes: workRequiredBytes + outputRequiredBytes,
  };
}

async function checkSpaceBudget(job: PreparedJob, budget: SpaceBudget): Promise<void> {
  job.state.spaceBudget = budget;
  await saveJobState(job.jobDirectory, job.state);
  const required = budget.sameVolume ? budget.combinedRequiredBytes : budget.workRequiredBytes;
  emit(job, "prepare", 0, 1, job.options.now?.() ?? Date.now(), `Checking ${required} bytes of remaining space`);
  if (budget.sameVolume) {
    await ensureDiskSpace(budget.workDirectory, budget.combinedRequiredBytes, "combined");
  } else {
    await ensureDiskSpace(budget.workDirectory, budget.workRequiredBytes, "work");
    await ensureDiskSpace(budget.outputDirectory, budget.outputRequiredBytes, "output");
  }
}

async function recordJobError(job: PreparedJob, error: unknown): Promise<void> {
  job.state.lastError = toAppError(error).toJSON();
  await saveJobState(job.jobDirectory, job.state).catch(() => undefined);
}

async function runFfmpegWithProgress(
  job: PreparedJob,
  args: string[],
  phase: ProgressPhase,
  totalFrames: number,
  message: string,
  progress: { offset: number; overallTotal: number } = { offset: 0, overallTotal: totalFrames },
): Promise<void> {
  const startedAt = job.options.now?.() ?? Date.now();
  const lines = new LineAccumulator();
  let lastFrame = 0;
  emit(job, phase, progress.offset, progress.overallTotal, startedAt, message);
  const consume = (line: string): void => {
    const match = /^frame=(\d+)$/.exec(line.trim());
    if (!match) return;
    const parsed = Number(match[1]);
    if (parsed > lastFrame) {
      lastFrame = parsed;
      emit(
        job,
        phase,
        progress.offset + Math.min(parsed, totalFrames),
        progress.overallTotal,
        startedAt,
        message,
      );
    }
  };
  await job.runner({ executable: job.binaries.ffmpeg, args }, {
    signal: job.options.signal,
    onStdout: (chunk) => lines.push(chunk).forEach(consume),
  });
  const remainder = lines.flush();
  if (remainder) consume(remainder);
  emit(job, phase, progress.offset + totalFrames, progress.overallTotal, startedAt, message);
}

async function presentSourceFrameIndices(
  directory: string,
  totalFrames: number,
  expected: PngDimensions,
): Promise<Set<number>> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const present = new Set<number>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^frame_(\d{8})\.png$/i.exec(entry.name);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= totalFrames) continue;
    const path = join(directory, entry.name);
    if (await validatePng(path, expected)) present.add(index);
    else await rm(path, { force: true }).catch(() => undefined);
  }
  return present;
}

function mergeSourceRanges(ranges: SourceFrameRange[]): SourceFrameRange[] {
  const sorted = ranges
    .filter((range) => range.endFrameExclusive > range.startFrame)
    .map((range) => ({ ...range }))
    .sort((left, right) => left.startFrame - right.startFrame);
  const merged: SourceFrameRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.startFrame > previous.endFrameExclusive) merged.push(range);
    else previous.endFrameExclusive = Math.max(previous.endFrameExclusive, range.endFrameExclusive);
  }
  return merged;
}

function missingRequestedFrameRanges(
  ranges: SourceFrameRange[],
  present: Set<number>,
): Array<{ startFrame: number; endFrame: number; frameCount: number }> {
  const missing: Array<{ startFrame: number; endFrame: number; frameCount: number }> = [];
  for (const range of mergeSourceRanges(ranges)) {
    let start: number | null = null;
    for (let index = range.startFrame; index < range.endFrameExclusive; index += 1) {
      if (!present.has(index) && start === null) start = index;
      const closes = start !== null && (present.has(index) || index === range.endFrameExclusive - 1);
      if (!closes) continue;
      const endFrame = present.has(index) ? index - 1 : index;
      missing.push({ startFrame: start as number, endFrame, frameCount: endFrame - (start as number) + 1 });
      start = null;
    }
  }
  return missing;
}

async function extractSourceRanges(job: PreparedJob, requestedRanges: SourceFrameRange[]): Promise<void> {
  await assertNotCancelled(job.jobDirectory, job.options.signal);
  await mkdir(job.sourceDirectory, { recursive: true });
  const totalFrames = job.media.video.frameCount;
  const ranges = mergeSourceRanges(requestedRanges);
  if (ranges.length === 0 || ranges.some((range) => range.startFrame < 0 || range.endFrameExclusive > totalFrames)) {
    throw new AppError("E_INVALID_CONFIG", "Requested source frame range is outside the source video", {
      requestedRanges,
      sourceFrameCount: totalFrames,
    });
  }
  const requestedFrameCount = ranges.reduce((sum, range) => sum + range.endFrameExclusive - range.startFrame, 0);
  const expected = { width: job.media.video.width, height: job.media.video.height };
  let present = await presentSourceFrameIndices(job.sourceDirectory, totalFrames, expected);
  const missingRanges = missingRequestedFrameRanges(ranges, present);
  if (missingRanges.length === 0) return;
  await savePhase(job, "extract");
  let completed = requestedFrameCount - missingRanges.reduce((sum, range) => sum + range.frameCount, 0);
  for (const range of missingRanges) {
    await assertNotCancelled(job.jobDirectory, job.options.signal);
    await runFfmpegWithProgress(job, [
      "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-y",
      "-i", job.spec.inputPath,
      "-map", "0:v:0",
      "-vf", `select=between(n\\,${range.startFrame}\\,${range.endFrame})`,
      "-vsync", "0", "-start_number", String(range.startFrame + 1),
      join(job.sourceDirectory, "frame_%08d.png"),
    ], "extract", range.frameCount, "Extracting missing source frames", {
      offset: completed,
      overallTotal: requestedFrameCount,
    });
    completed += range.frameCount;
  }
  present = await presentSourceFrameIndices(job.sourceDirectory, totalFrames, expected);
  const missing = missingRequestedFrameRanges(ranges, present);
  if (missing.length > 0) {
    throw new AppError("E_PROCESS_FAILED", "FFmpeg did not produce the requested source frame range", {
      expected: requestedFrameCount,
      actual: requestedFrameCount - missing.reduce((sum, range) => sum + range.frameCount, 0),
      missing,
    });
  }
}

async function detectFrameRisks(job: PreparedJob, sourceIndices: number[]): Promise<{
  sceneCutsAfter: Set<number>;
  holdBoundariesAfter: Set<number>;
  analysis: FrameRiskAnalysis;
}> {
  if (sourceIndices.length < 2) {
    const analysis = analyzeFrameRisks(sourceIndices.map((frame) => ({
      frame,
      ptsTime: frame / job.media.video.frameRate,
    })));
    job.state.detectedSceneCuts = [];
    job.state.frameRiskAnalysis = analysis;
    job.state.frameRiskRange = sourceIndices.length === 0
      ? { startFrame: 0, endFrameExclusive: 0 }
      : { startFrame: sourceIndices[0] as number, endFrameExclusive: (sourceIndices[0] as number) + 1 };
    await saveJobState(job.jobDirectory, job.state);
    return { sceneCutsAfter: new Set(), holdBoundariesAfter: new Set(), analysis };
  }
  const first = sourceIndices[0] as number;
  const last = sourceIndices.at(-1) as number;
  const result = await job.runner({
    executable: job.binaries.ffmpeg,
    args: [
      "-hide_banner", "-loglevel", "info", "-i", job.spec.inputPath,
      "-map", "0:v:0",
      "-vf", `trim=start_frame=${first}:end_frame=${last + 1},signalstats,scdet=threshold=10,blackframe=amount=90:threshold=32,metadata=print`,
      "-frames:v", String(sourceIndices.length),
      "-an", "-f", "framemd5", "-",
    ],
  }, {
    signal: job.options.signal,
    maxCaptureBytes: frameRiskCaptureBytes(sourceIndices.length),
  });
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new AppError("E_PROCESS_FAILED", "Frame risk scan output exceeded its bounded capture budget", {
      frameCount: sourceIndices.length,
      maxCaptureBytes: frameRiskCaptureBytes(sourceIndices.length),
      stdoutTruncated: result.stdoutTruncated === true,
      stderrTruncated: result.stderrTruncated === true,
    });
  }
  const parsed = parseFfmpegFrameMetadata({
    signalstats: result.stderr,
    scdet: result.stderr,
    blackframe: result.stderr,
    framemd5: result.stdout,
  }).map((frame) => ({ ...frame, frame: frame.frame + first }));
  const analysis = analyzeFrameRisks(parsed);
  const detected = new Set(analysis.hardCuts.map((risk) => risk.startFrame));
  const exactHolds = new Set(analysis.exactDuplicateIntervals.flatMap((risk) => risk.holdBoundariesAfter));
  const previous = new Set(job.state.detectedSceneCuts ?? []);
  for (let index = first; index < last; index += 1) previous.delete(index);
  for (const index of detected) previous.add(index);
  job.state.detectedSceneCuts = [...previous].sort((left, right) => left - right);
  job.state.frameRiskAnalysis = analysis;
  job.state.frameRiskRange = { startFrame: first, endFrameExclusive: last + 1 };
  await saveJobState(job.jobDirectory, job.state);
  return { sceneCutsAfter: detected, holdBoundariesAfter: exactHolds, analysis };
}

async function ensureFrameRiskAnalysis(job: PreparedJob): Promise<{
  sceneCutsAfter: Set<number>;
  holdBoundariesAfter: Set<number>;
  analysis: FrameRiskAnalysis;
}> {
  const expectedRange = job.sourceRange;
  const cachedRange = job.state.frameRiskRange;
  const cached = job.state.frameRiskAnalysis;
  if (cached?.detectorRevision === detectorRevision &&
      cached.frameCount === expectedRange.endFrameExclusive - expectedRange.startFrame &&
      cachedRange?.startFrame === expectedRange.startFrame &&
      cachedRange.endFrameExclusive === expectedRange.endFrameExclusive) {
    return {
      sceneCutsAfter: new Set(job.state.detectedSceneCuts ?? []),
      holdBoundariesAfter: new Set(cached.exactDuplicateIntervals.flatMap((risk) => risk.holdBoundariesAfter)),
      analysis: cached,
    };
  }
  const sourceIndices = Array.from(
    { length: expectedRange.endFrameExclusive - expectedRange.startFrame },
    (_, offset) => expectedRange.startFrame + offset,
  );
  return await detectFrameRisks(job, sourceIndices);
}

async function publishExactFrame(source: string, destination: string, expected: PngDimensions): Promise<void> {
  await rm(destination, { force: true }).catch(() => undefined);
  await linkOrCopy(source, destination);
  if (!await validatePng(destination, expected)) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw new AppError("E_PROCESS_FAILED", "Could not publish an exact source frame for interpolation");
  }
}

function contiguousChunks(indices: number[], maximumLength: number): number[][] {
  const chunks: number[][] = [];
  for (const index of indices) {
    const current = chunks.at(-1);
    if (!current || current.length >= maximumLength || index !== (current.at(-1) as number) + 1) chunks.push([index]);
    else current.push(index);
  }
  return chunks;
}

async function interpolateFrames(
  job: PreparedJob,
  sourceIndices: number[],
  includeTail: boolean,
): Promise<string> {
  if (job.spec.interpolation.mode === "none") return job.sourceDirectory;
  const interpolation = job.spec.interpolation;
  await assertNotCancelled(job.jobDirectory, job.options.signal);
  await savePhase(job, "interpolate");
  await mkdir(job.interpolatedDirectory, { recursive: true });
  const expected = { width: job.media.video.width, height: job.media.video.height };
  const startedAt = job.options.now?.() ?? Date.now();
  emit(job, "interpolate", 0, Math.max(1, sourceIndices.length * 2 - (includeTail ? 0 : 1)), startedAt, "Detecting scene changes");
  const risks = await ensureFrameRiskAnalysis(job);
  const mapping = interpolationFrameMap(sourceIndices, {
    includeTail,
    sceneCutsAfter: risks.sceneCutsAfter,
    holdBoundariesAfter: risks.holdBoundariesAfter,
  });
  const completed = new Set(job.state.completedInterpolationFrames ?? []);
  const missingIntervals: number[] = [];

  for (const frame of mapping) {
    const destination = join(job.interpolatedDirectory, frameFileName(frame.outputIndex));
    if (frame.kind === "source" || frame.kind === "hold") {
      await publishExactFrame(
        join(job.sourceDirectory, frameFileName(frame.sourceIndex)),
        destination,
        expected,
      );
      completed.add(frame.outputIndex);
    } else if (await validatePng(destination, expected)) {
      completed.add(frame.outputIndex);
    } else {
      completed.delete(frame.outputIndex);
      await rm(destination, { force: true }).catch(() => undefined);
      missingIntervals.push(frame.sourceIndex);
    }
  }
  job.state.completedInterpolationFrames = [...completed].sort((left, right) => left - right);
  await saveJobState(job.jobDirectory, job.state);
  let completedForRequest = mapping.filter((frame) => completed.has(frame.outputIndex)).length;
  emit(job, "interpolate", completedForRequest, mapping.length, startedAt, "Interpolating frames with RIFE");

  for (const chunk of contiguousChunks(missingIntervals, 64)) {
    await assertNotCancelled(job.jobDirectory, job.options.signal);
    const first = chunk[0] as number;
    const last = chunk.at(-1) as number;
    const blockDirectory = join(job.jobDirectory, "rife-batches", `${String(first + 1).padStart(8, "0")}-${String(last + 2).padStart(8, "0")}`);
    const inputDirectory = join(blockDirectory, "input");
    const outputDirectory = join(blockDirectory, "output");
    await rm(blockDirectory, { recursive: true, force: true });
    await Promise.all([mkdir(inputDirectory, { recursive: true }), mkdir(outputDirectory, { recursive: true })]);
    try {
      for (let sourceIndex = first; sourceIndex <= last + 1; sourceIndex += 1) {
        await linkOrCopy(
          join(job.sourceDirectory, frameFileName(sourceIndex)),
          join(inputDirectory, frameFileName(sourceIndex - first)),
        );
      }
      const inputFrameCount = last - first + 2;
      await job.runner({
        executable: job.binaries.rife,
        args: rifeDirectoryArguments({
          inputDirectory,
          outputDirectory,
          inputFrameCount,
          interpolation,
          source: expected,
          gpuId: job.spec.gpuId,
        }),
        cwd: dirname(job.binaries.rife),
      }, { signal: job.options.signal });
      const outputs = (await readdir(outputDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^\d{8}\.png$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      if (outputs.length !== inputFrameCount * 2) {
        throw new AppError("E_PROCESS_FAILED", "RIFE produced an unexpected frame count", {
          expected: inputFrameCount * 2,
          actual: outputs.length,
        });
      }
      for (const name of outputs) {
        if (!await validatePng(join(outputDirectory, name), expected)) {
          throw new AppError("E_PROCESS_FAILED", "RIFE produced a missing or invalid PNG frame", { name });
        }
      }
      for (const sourceIndex of chunk) {
        const localOutput = outputs[(sourceIndex - first) * 2 + 1] as string;
        const destination = join(job.interpolatedDirectory, frameFileName(sourceIndex * 2 + 1));
        await rm(destination, { force: true }).catch(() => undefined);
        await rename(join(outputDirectory, localOutput), destination);
        if (!await validatePng(destination, expected)) {
          await rm(destination, { force: true }).catch(() => undefined);
          throw new AppError("E_PROCESS_FAILED", "Published RIFE frame failed validation", { sourceIndex });
        }
        completed.add(sourceIndex * 2 + 1);
      }
      completedForRequest += chunk.length;
      job.state.completedInterpolationFrames = [...completed].sort((left, right) => left - right);
      await saveJobState(job.jobDirectory, job.state);
      emit(job, "interpolate", completedForRequest, mapping.length, startedAt, "Interpolating frames with RIFE");
    } finally {
      await rm(blockDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  for (const frame of mapping) {
    if (!await validatePng(join(job.interpolatedDirectory, frameFileName(frame.outputIndex)), expected)) {
      throw new AppError("E_PROCESS_FAILED", "RIFE cache is incomplete after interpolation", { outputIndex: frame.outputIndex });
    }
  }
  emit(job, "interpolate", mapping.length, mapping.length, startedAt, "RIFE interpolation complete");
  return job.interpolatedDirectory;
}

export function isGpuMemoryError(error: unknown): boolean {
  const text = error instanceof AppError
    ? `${error.message} ${JSON.stringify(error.details)}`
    : error instanceof Error ? error.message : String(error);
  return /out of (device )?memory|vk_error_out_of_device_memory|vkallocatememory|failed to allocate|insufficient.*memory/i.test(text);
}

function realesrganArguments(
  job: PreparedJob,
  inputDirectory: string,
  outputDirectory: string,
  tile: number,
): string[] {
  return [
    "-i", inputDirectory,
    "-o", outputDirectory,
    "-n", job.spec.model,
    "-s", String(job.actualAiScale),
    "-t", String(tile),
    "-j", "1:2:2",
    "-f", "png",
    "-v",
    ...(job.spec.gpuId === "auto" ? [] : ["-g", String(job.spec.gpuId)]),
  ];
}

async function selectUpscaleTile(
  job: PreparedJob,
  indices: number[],
  inputFrameDirectory: string,
  expected: PngDimensions,
  startedAt: number,
): Promise<number> {
  if (job.state.selectedTile !== null) return job.state.selectedTile;
  const representative = indices[Math.floor(indices.length / 2)];
  if (representative === undefined) {
    throw new AppError("E_PROCESS_FAILED", "Cannot select a Real-ESRGAN tile without a representative frame");
  }
  const probeRoot = join(job.jobDirectory, "tile-probe");
  const probeName = frameFileName(representative);
  await rm(probeRoot, { recursive: true, force: true });
  try {
    const tiles = tileFallbackOrder(job.spec.tile);
    for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
      const tile = tiles[tileIndex];
      if (tile === undefined) continue;
      await assertNotCancelled(job.jobDirectory, job.options.signal);
      const probeDirectory = join(probeRoot, `tile-${tile}`);
      const inputDirectory = join(probeDirectory, "input");
      const outputDirectory = join(probeDirectory, "output");
      await Promise.all([mkdir(inputDirectory, { recursive: true }), mkdir(outputDirectory, { recursive: true })]);
      await linkOrCopy(
        join(inputFrameDirectory, probeName),
        join(inputDirectory, probeName),
      );
      emit(job, "upscale", 0, indices.length, startedAt, `Testing representative frame with tile ${tile}`);
      try {
        await job.runner({
          executable: job.binaries.realesrgan,
          args: realesrganArguments(job, inputDirectory, outputDirectory, tile),
          cwd: dirname(job.binaries.realesrgan),
        }, { signal: job.options.signal });
      } catch (error) {
        await rm(enhancedDirectoryForTile(job, tile), { recursive: true, force: true }).catch(() => undefined);
        if (!isGpuMemoryError(error) || tileIndex === tiles.length - 1) throw error;
        continue;
      }
      if (!await validatePng(join(outputDirectory, probeName), expected)) {
        throw new AppError("E_PROCESS_FAILED", "Real-ESRGAN tile probe produced a missing or invalid PNG frame", {
          representative,
          tile,
        });
      }
      await clearJobSequenceCaches(job.jobDirectory);
      job.state.selectedTile = tile;
      job.state.completedUpscaleFrames = [];
      await saveJobState(job.jobDirectory, job.state);
      return tile;
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  throw new AppError("E_PROCESS_FAILED", "Real-ESRGAN could not select a supported tile size");
}

async function upscaleFrames(
  job: PreparedJob,
  indices: number[],
  inputFrameDirectory: string,
): Promise<string> {
  if (job.spec.upscaleMode === "lanczos" || job.actualAiScale === 1) return inputFrameDirectory;
  await savePhase(job, "upscale");
  const expected = {
    width: job.media.video.width * job.actualAiScale,
    height: job.media.video.height * job.actualAiScale,
  };
  const startedAt = job.options.now?.() ?? Date.now();
  const selectedTile = await selectUpscaleTile(job, indices, inputFrameDirectory, expected, startedAt);
  const tiles = tileFallbackOrder(selectedTile);
  for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
    const tile = tiles[tileIndex];
    if (tile === undefined) continue;
    const enhancedDirectory = enhancedDirectoryForTile(job, tile);
    await mkdir(enhancedDirectory, { recursive: true });
    if (job.state.selectedTile !== tile) {
      await clearJobSequenceCaches(job.jobDirectory);
      job.state.selectedTile = tile;
      job.state.completedUpscaleFrames = [];
      await saveJobState(job.jobDirectory, job.state);
    }

    const completed = new Set<number>();
    const missing: number[] = [];
    for (const index of indices) {
      const output = join(enhancedDirectory, frameFileName(index));
      if (await validatePng(output, expected)) {
        completed.add(index);
      } else {
        await rm(output, { force: true }).catch(() => undefined);
        missing.push(index);
      }
    }
    job.state.completedUpscaleFrames = [...completed].sort((left, right) => left - right);
    await saveJobState(job.jobDirectory, job.state);
    emit(job, "upscale", completed.size, indices.length, startedAt, `Upscaling frames with tile ${tile}`);

    let retryWithSmallerTile = false;
    for (let offset = 0; offset < missing.length; offset += job.spec.batchSize) {
      await assertNotCancelled(job.jobDirectory, job.options.signal);
      const block = missing.slice(offset, offset + job.spec.batchSize);
      const first = block[0];
      const last = block.at(-1);
      if (first === undefined || last === undefined) continue;
      const blockDirectory = join(job.jobDirectory, "batches", `${String(first + 1).padStart(8, "0")}-${String(last + 1).padStart(8, "0")}`);
      const inputDirectory = join(blockDirectory, "input");
      const outputDirectory = join(blockDirectory, "output");
      await rm(blockDirectory, { recursive: true, force: true });
      await Promise.all([mkdir(inputDirectory, { recursive: true }), mkdir(outputDirectory, { recursive: true })]);
      try {
        for (const index of block) {
          await linkOrCopy(
            join(inputFrameDirectory, frameFileName(index)),
            join(inputDirectory, frameFileName(index)),
          );
        }
        try {
          await job.runner({
            executable: job.binaries.realesrgan,
            args: realesrganArguments(job, inputDirectory, outputDirectory, tile),
            cwd: dirname(job.binaries.realesrgan),
          }, { signal: job.options.signal });
        } catch (error) {
          if (!isGpuMemoryError(error) || tileIndex === tiles.length - 1) throw error;
          retryWithSmallerTile = true;
          await clearJobSequenceCaches(job.jobDirectory);
          await rm(enhancedDirectory, { recursive: true, force: true }).catch(() => undefined);
          job.state.completedUpscaleFrames = [];
          job.state.selectedTile = tiles[tileIndex + 1] ?? null;
          await saveJobState(job.jobDirectory, job.state);
          emit(job, "upscale", 0, indices.length, startedAt, "GPU memory limit reached; rebuilding all frames with a smaller tile");
          break;
        }
        const invalid = [];
        for (const index of block) {
          if (!await validatePng(join(outputDirectory, frameFileName(index)), expected)) invalid.push(index);
        }
        if (invalid.length > 0) {
          throw new AppError("E_PROCESS_FAILED", "Real-ESRGAN batch produced missing or invalid PNG frames", { invalid });
        }
        for (const index of block) {
          const staged = join(outputDirectory, frameFileName(index));
          const published = join(enhancedDirectory, frameFileName(index));
          await rm(published, { force: true }).catch(() => undefined);
          await rename(staged, published);
          completed.add(index);
        }
        job.state.completedUpscaleFrames = [...completed].sort((left, right) => left - right);
        await saveJobState(job.jobDirectory, job.state);
        emit(job, "upscale", completed.size, indices.length, startedAt, `Upscaling frames with tile ${tile}`);
      } finally {
        await rm(blockDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      if (retryWithSmallerTile) break;
    }
    if (retryWithSmallerTile) continue;
    return enhancedDirectory;
  }
  throw new AppError("E_PROCESS_FAILED", "Real-ESRGAN could not complete with any supported tile size");
}

async function sequenceFrames(job: PreparedJob, sourceDirectory: string, indices: number[], destination = job.sequenceDirectory): Promise<void> {
  await assertNotCancelled(job.jobDirectory, job.options.signal);
  await savePhase(job, "sequence");
  const startedAt = job.options.now?.() ?? Date.now();
  emit(job, "sequence", 0, indices.length, startedAt, "Building output sequence");
  await buildFrameSequence(sourceDirectory, destination, indices, (current, total) => {
    emit(job, "sequence", current, total, startedAt, "Building output sequence");
  });
}

function temporaryOutputPath(outputPath: string, jobId: string): string {
  const extension = extname(outputPath) || ".mp4";
  const base = outputPath.slice(0, outputPath.length - extname(outputPath).length);
  return `${base}.${jobId}.partial${extension}`;
}

function encodeArguments(job: PreparedJob, sequenceDirectory: string, frameCount: number, outputPath: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-y",
    "-framerate", String(job.fps),
    "-start_number", "1",
    "-i", join(sequenceDirectory, "frame_%08d.png"),
    "-frames:v", String(frameCount),
    "-vf", buildFfmpegVideoFilter(job.spec.aspectMode, job.spec.target, job.spec.focus),
    ...videoEncoderArguments(job.spec.encoding),
    "-pix_fmt", job.spec.encoding.pixelFormat,
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-color_range", "tv",
    "-r", String(job.fps),
    "-an", "-movflags", "+faststart",
    outputPath,
  ];
}

async function encode(job: PreparedJob, sequenceDirectory: string, frameCount: number, outputPath: string): Promise<void> {
  await assertNotCancelled(job.jobDirectory, job.options.signal);
  await mkdir(dirname(outputPath), { recursive: true });
  await savePhase(job, "encode");
  await runFfmpegWithProgress(
    job,
    encodeArguments(job, sequenceDirectory, frameCount, outputPath),
    "encode",
    frameCount,
    "Encoding H.264 wallpaper",
  );
}

function expectedOutput(job: PreparedJob, frameCount: number): VerificationExpectation {
  return {
    width: job.spec.target.width,
    height: job.spec.target.height,
    sampleAspectRatio: "1:1",
    frameRate: job.fps,
    frameRateTolerance: 0.01,
    frameCount,
    durationSeconds: durationForFrames(frameCount, job.fps),
    durationToleranceSeconds: Math.max(0.05, 1 / job.fps),
    codec: "h264",
    pixelFormat: "yuv420p",
    colorSpace: "bt709",
    colorPrimaries: "bt709",
    colorTransfer: "bt709",
    colorRange: "tv",
    audio: "none",
  };
}

async function verifyEncodedOutput(
  job: PreparedJob,
  inputPath: string,
  frameCount: number,
  referenceSourceRanges?: SourceFrameRange[],
) {
  await assertNotCancelled(job.jobDirectory, job.options.signal);
  await savePhase(job, "verify");
  const startedAt = job.options.now?.() ?? Date.now();
  emit(job, "verify", 0, 1, startedAt, "Verifying encoded wallpaper");
  const verification = await verifyMedia(inputPath, expectedOutput(job, frameCount), {
    ffmpegPath: job.binaries.ffmpeg,
    ffprobePath: job.binaries.ffprobe,
    runner: job.runner,
    signal: job.options.signal,
    throwOnFailure: true,
    fullDecode: {
      reference: {
        inputPath: job.spec.inputPath,
        media: job.media,
        ...(referenceSourceRanges
          ? { sourceRanges: referenceSourceRanges }
          : { sourceRange: job.sourceRange }),
      },
    },
  });
  emit(job, "verify", 1, 1, startedAt, "Encoded wallpaper verified");
  return verification;
}

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function matchesVerifiedOutput(
  outputPath: string,
  marker: NonNullable<JobState["verifiedOutput"]> | undefined,
  frameCount: number,
): Promise<boolean> {
  if (!marker || resolve(marker.outputPath) !== outputPath || marker.frameCount !== frameCount ||
      !/^[a-f0-9]{64}$/.test(marker.sha256)) return false;
  const info = await stat(outputPath).catch(() => null);
  if (!info?.isFile() || info.size !== marker.size || Math.round(info.mtimeMs) !== marker.modifiedMs) return false;
  return await sha256File(outputPath).then((hash) => hash === marker.sha256, () => false);
}

export async function processVideo(rawSpec: JobSpec | unknown, options: PipelineOptions = {}): Promise<ProcessResult> {
  const active = await beginPreparedJob(rawSpec, options);
  const { job } = active;
  const outputPath = resolve(job.spec.outputPath);
  const partialOutput = temporaryOutputPath(outputPath, job.jobId);
  let outcome: "complete" | "recoverable" = "recoverable";
  let result: ProcessResult | null = null;
  try {
    if (resolve(job.spec.inputPath).toLowerCase() === outputPath.toLowerCase()) {
      throw new AppError("E_INVALID_CONFIG", "Input and output paths must be different");
    }
    const selectedSourceFrameCount = job.sourceRange.endFrameExclusive - job.sourceRange.startFrame;
    const sourceIndices = Array.from(
      { length: selectedSourceFrameCount },
      (_, offset) => job.sourceRange.startFrame + offset,
    );
    const forwardFrameCount = interpolatedForwardFrameCount(
      selectedSourceFrameCount,
      job.spec.interpolation.factor,
    );
    const processingStartFrame = job.spec.interpolation.mode === "rife"
      ? job.sourceRange.startFrame * 2
      : job.sourceRange.startFrame;
    const processingFrameCount = job.spec.interpolation.mode === "rife" && job.spec.loopMode === "none"
      ? selectedSourceFrameCount * 2
      : forwardFrameCount;
    const processingIndices = Array.from(
      { length: processingFrameCount },
      (_, offset) => processingStartFrame + offset,
    );
    const singleFrameRifePingPong = job.spec.interpolation.mode === "rife" &&
      job.spec.loopMode === "pingpong" && selectedSourceFrameCount === 1;
    const sequenceIndices = job.spec.loopMode === "pingpong"
      ? singleFrameRifePingPong
        ? [processingStartFrame, processingStartFrame]
        : pingPongIndices(forwardFrameCount).map((index) => processingStartFrame + index)
      : processingIndices;
    const existingOutput = await access(outputPath).then(() => true, () => false);
    if (existingOutput) {
      const recoverablePublish = job.resumed && job.state.phase !== "complete" &&
        await matchesVerifiedOutput(outputPath, job.state.verifiedOutput, sequenceIndices.length);
      if (!job.resumed || (job.state.phase !== "complete" && !recoverablePublish)) {
        throw new AppError("E_OUTPUT_EXISTS", `Output file already exists: ${outputPath}`);
      }
      const verification = await verifyEncodedOutput(job, outputPath, sequenceIndices.length);
      job.state.phase = "complete";
      job.state.outputPath = outputPath;
      job.state.outputFrameCount = sequenceIndices.length;
      job.state.lastError = null;
      await saveJobState(job.jobDirectory, job.state);
      await rm(job.sequenceDirectory, { recursive: true, force: true });
      result = {
        jobId: job.jobId,
        outputPath,
        media: verification.media,
        verification,
        resumed: true,
        workDirectory: job.workDirectory,
        frameCacheKey: job.frameCacheKey,
        actualAiScale: job.actualAiScale,
        sourceRange: { ...job.sourceRange },
        sourceFrameCount: selectedSourceFrameCount,
        ...(job.state.frameRiskAnalysis ? { frameRiskAnalysis: job.state.frameRiskAnalysis } : {}),
      };
    } else {
      await withFrameCacheWriteLock(job, async () => {
        const budget = await createSpaceBudget(
          job,
          sourceIndices,
          processingIndices,
          job.sequenceDirectory,
          sequenceIndices.length,
          outputPath,
          job.spec.loopMode,
        );
        await checkSpaceBudget(job, budget);
        await extractSourceRanges(job, [job.sourceRange]);
        const interpolatedDirectory = await interpolateFrames(
          job,
          sourceIndices,
          job.spec.interpolation.mode === "rife" && job.spec.loopMode === "none",
        );
        const frameDirectory = await upscaleFrames(job, processingIndices, interpolatedDirectory);
        await sequenceFrames(job, frameDirectory, sequenceIndices);
      });

      job.state.verifiedOutput = undefined;
      await encode(job, job.sequenceDirectory, sequenceIndices.length, partialOutput);
      const verification = await verifyEncodedOutput(job, partialOutput, sequenceIndices.length);
      await assertNotCancelled(job.jobDirectory, job.options.signal);
      const verifiedSha256 = await sha256File(partialOutput);
      const verifiedInfo = await stat(partialOutput);
      job.state.outputPath = outputPath;
      job.state.outputFrameCount = sequenceIndices.length;
      job.state.lastError = null;
      job.state.verifiedOutput = {
        outputPath,
        size: verifiedInfo.size,
        modifiedMs: Math.round(verifiedInfo.mtimeMs),
        frameCount: sequenceIndices.length,
        sha256: verifiedSha256,
      };
      await saveJobState(job.jobDirectory, job.state);
      await assertNotCancelled(job.jobDirectory, job.options.signal);
      await rename(partialOutput, outputPath);
      verification.media.path = outputPath;
      await savePhase(job, "complete");
      await rm(job.sequenceDirectory, { recursive: true, force: true });
      emit(job, "complete", 1, 1, options.now?.() ?? Date.now(), "Wallpaper video complete");
      result = {
        jobId: job.jobId,
        outputPath,
        media: verification.media,
        verification,
        resumed: job.resumed,
        workDirectory: job.workDirectory,
        frameCacheKey: job.frameCacheKey,
        actualAiScale: job.actualAiScale,
        sourceRange: { ...job.sourceRange },
        sourceFrameCount: selectedSourceFrameCount,
        ...(job.state.frameRiskAnalysis ? { frameRiskAnalysis: job.state.frameRiskAnalysis } : {}),
      };
    }
    outcome = "complete";
  } catch (error) {
    await rm(partialOutput, { force: true }).catch(() => undefined);
    await recordJobError(job, error);
    throw error;
  } finally {
    await finishPreparedJob(active, outcome);
  }
  if (!result) throw new AppError("E_JOB_STATE", "Completed process did not produce a result");
  result.cacheMaintenance = await runCacheMaintenance(job.workDirectory, {
    policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
    limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
    now: options.now?.(),
  }).catch((error) => ({
    workDirectory: job.workDirectory,
    cacheDirectory: join(job.workDirectory, "frame-cache"),
    policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
    limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
    totalBytes: 0,
    releasedBytes: 0,
    remainingBytes: 0,
    removedKeys: [],
    legacyCount: 0,
    entries: [],
    errors: [error instanceof Error ? error.message : String(error)],
  }));
  return result;
}

function previewOutputPath(spec: { outputPath: string }, override?: string): string {
  if (override) return resolve(override);
  const extension = extname(spec.outputPath) || ".mp4";
  const base = spec.outputPath.slice(0, spec.outputPath.length - extname(spec.outputPath).length);
  return resolve(`${base}.preview${extension}`);
}

interface PreviewFramePlan {
  previewMode: PreviewMode;
  turn?: LoopTurn;
  startFrame: number;
  sourceFrameCount: number;
  sourceRanges: SourceFrameRange[];
  processingIndices: number[];
  sequenceIndices: number[];
  boundary?: PreviewBoundary;
}

function normalizedPreviewMode(job: PreparedJob, preview: PreviewOptions): { previewMode: PreviewMode; turn?: LoopTurn } {
  const previewMode = preview.previewMode ?? "segment";
  if (previewMode !== "segment" && previewMode !== "loop-boundary") {
    throw new AppError("E_INVALID_ARGUMENT", `Unsupported preview mode: ${String(previewMode)}`);
  }
  if (preview.frameCount !== undefined &&
      (!Number.isInteger(preview.frameCount) || preview.frameCount < 1)) {
    throw new AppError("E_INVALID_ARGUMENT", "Preview frameCount must be a positive integer");
  }
  if (previewMode === "segment") {
    if (preview.turn !== undefined) {
      throw new AppError("E_INVALID_ARGUMENT", "turn is only valid for a ping-pong loop-boundary preview");
    }
    return { previewMode };
  }
  if (preview.centerSeconds !== undefined) {
    throw new AppError("E_INVALID_ARGUMENT", "centerSeconds cannot be used with a loop-boundary preview");
  }
  if (job.spec.loopMode === "none") {
    if (preview.turn !== undefined) {
      throw new AppError("E_INVALID_ARGUMENT", "turn is not valid for a direct loop seam");
    }
    return { previewMode };
  }
  const turn = preview.turn ?? "end";
  if (turn !== "start" && turn !== "end") {
    throw new AppError("E_INVALID_ARGUMENT", `Unsupported ping-pong turn: ${String(turn)}`);
  }
  return { previewMode, turn };
}

function sourceRangesForProcessingIndices(job: PreparedJob, processingIndices: number[]): SourceFrameRange[] {
  const sourceIndices = new Set<number>();
  for (const processingIndex of processingIndices) {
    if (job.spec.interpolation.mode === "none") {
      sourceIndices.add(processingIndex);
      continue;
    }
    const sourceIndex = Math.floor(processingIndex / 2);
    sourceIndices.add(sourceIndex);
    if (processingIndex % 2 === 1 && sourceIndex + 1 < job.sourceRange.endFrameExclusive) {
      sourceIndices.add(sourceIndex + 1);
    }
  }
  return mergeSourceRanges([...sourceIndices]
    .sort((left, right) => left - right)
    .map((index) => ({ startFrame: index, endFrameExclusive: index + 1 })));
}

function periodicWindow(
  cycle: number[],
  frameCount: number,
  anchorCycleIndex: number,
  anchorOutputFrame: number,
): number[] {
  if (cycle.length === 0) throw new AppError("E_JOB_STATE", "Loop preview cycle cannot be empty");
  return Array.from({ length: frameCount }, (_, outputFrame) => {
    const relative = anchorCycleIndex + outputFrame - anchorOutputFrame;
    const cycleIndex = ((relative % cycle.length) + cycle.length) % cycle.length;
    return cycle[cycleIndex] as number;
  });
}

function createPreviewFramePlan(job: PreparedJob, preview: PreviewOptions): PreviewFramePlan {
  const mode = normalizedPreviewMode(job, preview);
  const factor = job.spec.interpolation.factor;
  if (mode.previewMode === "segment") {
    const { startFrame, frameCount } = selectPreviewFrameRange(job.media, preview, job.sourceRange);
    const processingStart = job.spec.interpolation.mode === "rife" ? startFrame * 2 : startFrame;
    const processingFrameCount = frameCount * factor;
    const processingIndices = Array.from(
      { length: processingFrameCount },
      (_, offset) => processingStart + offset,
    );
    return {
      previewMode: mode.previewMode,
      startFrame,
      sourceFrameCount: frameCount,
      sourceRanges: sourceRangesForProcessingIndices(job, processingIndices),
      processingIndices,
      sequenceIndices: processingIndices,
    };
  }

  const selectedSourceFrameCount = job.sourceRange.endFrameExclusive - job.sourceRange.startFrame;
  const requestedSourceFrames = Math.max(1, Math.round(preview.frameCount ?? job.media.video.frameRate * 2));
  const outputFrameCount = requestedSourceFrames * factor;
  const processingStart = job.spec.interpolation.mode === "rife"
    ? job.sourceRange.startFrame * 2
    : job.sourceRange.startFrame;
  const forwardFrameCount = interpolatedForwardFrameCount(selectedSourceFrameCount, factor);
  let cycle: number[];
  let anchorCycleIndex: number;
  let boundaryType: PreviewBoundary["type"];
  if (selectedSourceFrameCount === 1) {
    cycle = [processingStart];
    anchorCycleIndex = 0;
    boundaryType = job.spec.loopMode === "pingpong"
      ? mode.turn === "start" ? "pingpong-start" : "pingpong-end"
      : "direct-seam";
  } else if (job.spec.loopMode === "pingpong") {
    cycle = pingPongIndices(forwardFrameCount).map((index) => processingStart + index);
    anchorCycleIndex = mode.turn === "start" ? 0 : forwardFrameCount - 1;
    boundaryType = mode.turn === "start" ? "pingpong-start" : "pingpong-end";
  } else {
    const directFrameCount = factor === 2 ? selectedSourceFrameCount * 2 : selectedSourceFrameCount;
    cycle = Array.from({ length: directFrameCount }, (_, offset) => processingStart + offset);
    anchorCycleIndex = 0;
    boundaryType = "direct-seam";
  }
  const boundaryOutputFrame = Math.floor(outputFrameCount / 2);
  const sequenceIndices = periodicWindow(cycle, outputFrameCount, anchorCycleIndex, boundaryOutputFrame);
  const processingIndices = [...new Set(sequenceIndices)].sort((left, right) => left - right);
  const sourceRanges = sourceRangesForProcessingIndices(job, processingIndices);
  return {
    previewMode: mode.previewMode,
    ...(mode.turn ? { turn: mode.turn } : {}),
    startFrame: sourceRanges[0]?.startFrame ?? job.sourceRange.startFrame,
    sourceFrameCount: sourceRanges.reduce(
      (sum, range) => sum + range.endFrameExclusive - range.startFrame,
      0,
    ),
    sourceRanges,
    processingIndices,
    sequenceIndices,
    boundary: { type: boundaryType, outputFrame: boundaryOutputFrame },
  };
}

async function interpolatePreviewFrames(job: PreparedJob, plan: PreviewFramePlan): Promise<string> {
  if (job.spec.interpolation.mode === "none") return job.sourceDirectory;
  const requested = new Set(plan.processingIndices);
  for (const range of plan.sourceRanges) {
    const sourceIndices = Array.from(
      { length: range.endFrameExclusive - range.startFrame },
      (_, offset) => range.startFrame + offset,
    );
    const lastSourceFrame = range.endFrameExclusive - 1;
    const includeTail = lastSourceFrame === job.sourceRange.endFrameExclusive - 1 &&
      requested.has(lastSourceFrame * 2 + 1);
    await interpolateFrames(job, sourceIndices, includeTail);
  }
  return job.interpolatedDirectory;
}

async function previewNormalizedVideo(
  spec: NormalizedJobSpec,
  preview: PreviewOptions = {},
  options: PipelineOptions = {},
  internal: { autoLocateRisk?: boolean } = {},
): Promise<PreviewResult> {
  const active = await beginPreparedJobFromSpec(spec, options);
  const { job } = active;
  job.preserveCompletedPhase = job.state.phase === "complete";
  let partialOutput: string | null = null;
  try {
    const mode = normalizedPreviewMode(job, preview);
    let selectedRiskPreview: FrameRiskPreview | undefined;
    if (internal.autoLocateRisk) {
      const risks = await ensureFrameRiskAnalysis(job);
      if (mode.previewMode === "segment" && preview.centerSeconds === undefined) {
        selectedRiskPreview = selectDiagnosticRiskPreview(risks.analysis);
      }
    }
    const effectivePreview = selectedRiskPreview
      ? { ...preview, centerSeconds: selectedRiskPreview.ptsTime ?? selectedRiskPreview.frame / job.sourceFps }
      : preview;
    const plan = createPreviewFramePlan(job, effectivePreview);
    const previewSequence = plan.previewMode === "segment"
      ? join(job.jobDirectory, `preview-sequence-${plan.startFrame}-${plan.sequenceIndices.length}`)
      : join(job.jobDirectory, `preview-boundary-sequence-${cacheKey({
          previewMode: plan.previewMode,
          turn: plan.turn,
          sequenceIndices: plan.sequenceIndices,
        }).slice(0, 16)}`);
    const outputPath = previewOutputPath(job.spec, preview.outputPath);
    partialOutput = temporaryOutputPath(outputPath, job.jobId);
    if (await access(outputPath).then(() => true, () => false)) {
      throw new AppError("E_OUTPUT_EXISTS", `Preview file already exists: ${outputPath}`);
    }
    await withFrameCacheWriteLock(job, async () => {
      const budget = await createSpaceBudget(
        job,
        plan.sourceRanges.flatMap((range) => Array.from(
          { length: range.endFrameExclusive - range.startFrame },
          (_, offset) => range.startFrame + offset,
        )),
        plan.processingIndices,
        previewSequence,
        plan.sequenceIndices.length,
        outputPath,
        "none",
      );
      await checkSpaceBudget(job, budget);
      await extractSourceRanges(job, plan.sourceRanges);
      const interpolatedDirectory = await interpolatePreviewFrames(job, plan);
      const frameDirectory = await upscaleFrames(job, plan.processingIndices, interpolatedDirectory);
      await sequenceFrames(job, frameDirectory, plan.sequenceIndices, previewSequence);
    });
    await encode(job, previewSequence, plan.sequenceIndices.length, partialOutput);
    const verification = await verifyEncodedOutput(
      job,
      partialOutput,
      plan.sequenceIndices.length,
      plan.sourceRanges,
    );
    await assertNotCancelled(job.jobDirectory, job.options.signal);
    await rename(partialOutput, outputPath);
    verification.media.path = outputPath;
    job.state.lastError = null;
    await saveJobState(job.jobDirectory, job.state);
    await rm(previewSequence, { recursive: true, force: true });
    return {
      jobId: job.jobId,
      outputPath,
      startFrame: plan.startFrame,
      frameCount: plan.sequenceIndices.length,
      sourceFrameCount: plan.sourceFrameCount,
      media: verification.media,
      verification,
      workDirectory: job.workDirectory,
      frameCacheKey: job.frameCacheKey,
      actualAiScale: job.actualAiScale,
      previewMode: plan.previewMode,
      ...(plan.turn ? { turn: plan.turn } : {}),
      sourceRanges: plan.sourceRanges.map((range) => ({ ...range })),
      ...(plan.boundary ? { boundary: { ...plan.boundary } } : {}),
      ...(job.state.frameRiskAnalysis ? { frameRiskAnalysis: job.state.frameRiskAnalysis } : {}),
      ...(selectedRiskPreview ? { selectedRiskPreview } : {}),
    };
  } catch (error) {
    if (partialOutput) await rm(partialOutput, { force: true }).catch(() => undefined);
    await recordJobError(job, error);
    throw error;
  } finally {
    await finishPreparedJob(active, "recoverable");
    await runCacheMaintenance(job.workDirectory, {
      policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
      limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
      now: options.now?.(),
    }).catch(() => undefined);
  }
}

export async function previewVideo(
  rawSpec: JobSpec | unknown,
  preview: PreviewOptions = {},
  options: PipelineOptions = {},
): Promise<PreviewResult> {
  return await previewNormalizedVideo(parseJobSpec(rawSpec), preview, options);
}

export async function diagnosticPreviewVideo(
  rawSpec: JobSpec | unknown,
  preview: PreviewOptions & { outputDirectory: string },
  options: PipelineOptions = {},
): Promise<DiagnosticPreviewResult> {
  const base = parseJobSpec(rawSpec);
  const outputDirectory = resolve(preview.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const none = {
    mode: "none" as const,
    factor: 1 as const,
    model: "rife-v4.6" as const,
    memoryMode: "auto" as const,
    sceneCutMode: "hold" as const,
    backend: "rife-ncnn-vulkan" as const,
  };
  const rife = { ...none, mode: "rife" as const, factor: 2 as const };
  const variants: Array<{
    id: DiagnosticPreviewVariant["id"];
    label: string;
    description: string;
    spec: NormalizedJobSpec;
  }> = [
    {
      id: "A",
      label: "Lanczos",
      description: "无 RIFE，仅 Lanczos",
      spec: { ...base, upscaleMode: "lanczos", upscaleBackend: "lanczos", aiScale: "auto", interpolation: none },
    },
    {
      id: "B",
      label: "AI 2x",
      description: "无 RIFE，AI 2x + Lanczos",
      spec: { ...base, upscaleMode: "realesrgan", upscaleBackend: "realesrgan-ncnn-vulkan", model: "realesr-animevideov3", aiScale: 2, interpolation: none },
    },
    {
      id: "C",
      label: "AI 3x",
      description: "无 RIFE，AI 3x + 缩小",
      spec: { ...base, upscaleMode: "realesrgan", upscaleBackend: "realesrgan-ncnn-vulkan", model: "realesr-animevideov3", aiScale: 3, interpolation: none },
    },
    {
      id: "D",
      label: "RIFE + AI 2x",
      description: "RIFE 2x，AI 2x + Lanczos",
      spec: { ...base, upscaleMode: "realesrgan", upscaleBackend: "realesrgan-ncnn-vulkan", model: "realesr-animevideov3", aiScale: 2, interpolation: rife },
    },
  ];
  const started = options.now?.() ?? Date.now();
  const results: DiagnosticPreviewVariant[] = [];
  let sourceFrameCount = 0;
  let previewMode: PreviewMode = preview.previewMode ?? "segment";
  let turn: LoopTurn | undefined;
  let sourceRanges: SourceFrameRange[] = [];
  let boundary: PreviewBoundary | undefined;
  let frameRiskAnalysis: FrameRiskAnalysis | undefined;
  let selectedRiskPreview: FrameRiskPreview | undefined;
  let resolvedCenterSeconds = preview.centerSeconds;
  for (const variant of variants) {
    const variantStarted = options.now?.() ?? Date.now();
    const result = await previewNormalizedVideo(variant.spec, {
      centerSeconds: resolvedCenterSeconds,
      frameCount: preview.frameCount,
      previewMode: preview.previewMode,
      turn: preview.turn,
      outputPath: join(outputDirectory, `${variant.id.toLowerCase()}-${variant.label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.mp4`),
    }, options, { autoLocateRisk: results.length === 0 });
    const overview = await inspectCache(result.workDirectory, {
      policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
      limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
      now: options.now?.(),
    });
    const entry = overview.entries.find((item) => item.frameCacheKey === result.frameCacheKey);
    if (results.length === 0) {
      sourceFrameCount = result.sourceFrameCount;
      previewMode = result.previewMode;
      turn = result.turn;
      sourceRanges = result.sourceRanges.map((range) => ({ ...range }));
      boundary = result.boundary ? { ...result.boundary } : undefined;
      frameRiskAnalysis = result.frameRiskAnalysis;
      selectedRiskPreview = result.selectedRiskPreview;
      if (selectedRiskPreview && resolvedCenterSeconds === undefined) {
        resolvedCenterSeconds = selectedRiskPreview.ptsTime ??
          selectedRiskPreview.frame / result.media.video.frameRate;
      }
    }
    results.push({
      id: variant.id,
      label: variant.label,
      description: variant.description,
      outputPath: result.outputPath,
      durationMs: Math.max(0, (options.now?.() ?? Date.now()) - variantStarted),
      cacheSizeBytes: entry?.sizeBytes ?? 0,
      frameCacheKey: result.frameCacheKey,
      actualAiScale: result.actualAiScale,
      media: result.media,
      verification: result.verification,
    });
  }
  const workDirectory = resolve(options.workDirectory ?? defaultWorkDirectory(base.outputPath));
  const cache = await inspectCache(workDirectory, {
    policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
    limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
    now: options.now?.(),
  });
  return {
    workDirectory,
    outputDirectory,
    sourceFrameCount,
    totalDurationMs: Math.max(0, (options.now?.() ?? Date.now()) - started),
    variants: results,
    cache,
    previewMode,
    ...(turn ? { turn } : {}),
    sourceRanges,
    ...(boundary ? { boundary } : {}),
    ...(frameRiskAnalysis ? { frameRiskAnalysis } : {}),
    ...(selectedRiskPreview ? { selectedRiskPreview } : {}),
  };
}

export function loopPreviewTarget(target: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, 960 / Math.max(target.width, target.height));
  const even = (value: number): number => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(target.width), height: even(target.height) };
}

export async function loopPreviewVideo(
  rawSpec: JobSpec | unknown,
  preview: { outputDirectory: string; frameCount?: number },
  options: PipelineOptions = {},
): Promise<LoopPreviewResult> {
  const base = parseJobSpec(rawSpec);
  const outputDirectory = resolve(preview.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const target = loopPreviewTarget(base.target);
  const interpolation = {
    mode: "none" as const,
    factor: 1 as const,
    backend: "rife-ncnn-vulkan" as const,
    model: "rife-v4.6" as const,
    memoryMode: "auto" as const,
    sceneCutMode: "hold" as const,
  };
  const encoding = {
    codec: "h264" as const,
    encoder: "libx264" as const,
    profile: "high" as const,
    crf: 23,
    preset: "medium" as const,
    pixelFormat: "yuv420p" as const,
    removeAudio: true as const,
  };
  const lightweight: NormalizedJobSpec = {
    ...base,
    target,
    upscaleMode: "lanczos" as const,
    upscaleBackend: "lanczos" as const,
    model: "lanczos" as const,
    tile: 0,
    gpuId: "auto" as const,
    aiScale: "auto" as const,
    batchSize: 64,
    interpolation,
    encoding,
  };
  const definitions: Array<{
    id: LoopPreviewVariant["id"];
    label: string;
    description: string;
    loopMode: "pingpong" | "none";
    turn?: LoopTurn;
  }> = [
    { id: "pingpong-end", label: "乒乓循环 · 片尾折返", description: "乒乓循环必须检查的第 1 个折返点", loopMode: "pingpong", turn: "end" },
    { id: "pingpong-start", label: "乒乓循环 · 片头折返", description: "乒乓循环必须检查的第 2 个折返点", loopMode: "pingpong", turn: "start" },
    { id: "direct-seam", label: "直接循环 · 尾首衔接", description: "片尾直接跳回片头时的接缝", loopMode: "none" },
  ];
  const started = options.now?.() ?? Date.now();
  const variants: LoopPreviewVariant[] = [];
  let sourceFrameCount = 0;
  for (const definition of definitions) {
    const variantStarted = options.now?.() ?? Date.now();
    const result = await previewNormalizedVideo({ ...lightweight, loopMode: definition.loopMode }, {
      previewMode: "loop-boundary",
      ...(definition.turn ? { turn: definition.turn } : {}),
      ...(preview.frameCount === undefined ? {} : { frameCount: preview.frameCount }),
      outputPath: join(outputDirectory, `${definition.id}.mp4`),
    }, options);
    if (!result.boundary) throw new AppError("E_JOB_STATE", "Loop preview did not report its boundary");
    sourceFrameCount = Math.max(sourceFrameCount, result.sourceFrameCount);
    variants.push({
      ...definition,
      outputPath: result.outputPath,
      durationMs: Math.max(0, (options.now?.() ?? Date.now()) - variantStarted),
      media: result.media,
      verification: result.verification,
      sourceRanges: result.sourceRanges,
      boundary: result.boundary,
    });
  }
  const workDirectory = resolve(options.workDirectory ?? defaultWorkDirectory(base.outputPath));
  const cache = await inspectCache(workDirectory, {
    policy: options.cachePolicy ?? DEFAULT_CACHE_POLICY,
    limitBytes: options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES,
    now: options.now?.(),
  });
  return {
    workDirectory,
    outputDirectory,
    sourceFrameCount,
    totalDurationMs: Math.max(0, (options.now?.() ?? Date.now()) - started),
    target,
    variants,
    cache,
  };
}

function checkedJobDirectory(workDirectory: string, jobId: string): string {
  if (!/^[a-f0-9]{20}$/.test(jobId)) throw new AppError("E_INVALID_ARGUMENT", "Invalid job id");
  return join(resolve(workDirectory), "jobs", jobId);
}

export async function cancelJob(jobId: string, workDirectory: string): Promise<void> {
  await requestCancellation(checkedJobDirectory(workDirectory, jobId));
}

export async function cleanupJob(jobId: string, workDirectory: string): Promise<void> {
  await rm(checkedJobDirectory(workDirectory, jobId), { recursive: true, force: true });
}

export async function cleanupFrameCache(frameCacheKey: string, workDirectory: string): Promise<void> {
  await cleanupOneFrameCache(frameCacheKey, workDirectory);
}
