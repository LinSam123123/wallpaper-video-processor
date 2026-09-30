import { createHash } from "node:crypto";
import type {
  AiScale,
  AiScaleSetting,
  AspectMode,
  FocusPoint,
  FrameStorageBudget,
  GpuId,
  InterpolationFactor,
  InterpolationSpec,
  NormalizedInterpolationSpec,
  NormalizedH264EncodingSpec,
  ProgressEvent,
  ProgressPhase,
  SourceFrameRange,
  TargetSize,
} from "./types.js";
import type { InputFingerprint } from "./job-state.js";

export interface AspectLayout {
  scale: number;
  scaledWidth: number;
  scaledHeight: number;
  cropX: number;
  cropY: number;
  padX: number;
  padY: number;
}

export interface DiskEstimateInput {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  sourceFrameCount: number;
  loopMode: "pingpong" | "none";
  upscaleMode: "realesrgan" | "lanczos";
  upscaleFactor?: number;
  interpolationFactor?: InterpolationFactor;
  safetyFactor?: number;
}

export interface DiskEstimate {
  sourceFramesBytes: number;
  interpolatedFramesBytes: number;
  enhancedFramesBytes: number;
  sequenceOverheadBytes: number;
  outputBytes: number;
  totalBytes: number;
}

export interface FrameCacheKeyInput {
  input: InputFingerprint;
  sourceFps: number;
  upscaleMode: "realesrgan" | "lanczos";
  model: string;
  actualScale: number;
  interpolation?: NormalizedInterpolationSpec;
  sourceRange?: SourceFrameRange;
  upscaleBackend?: string;
  requestedTile?: number;
  processingRevision?: string;
  sceneDetectorRevision?: string;
  runtimeIdentity?: Record<string, string>;
}

export const FRAME_CACHE_PIPELINE_REVISION = "dual-mode-pipeline-v1" as const;

export interface FrameRange {
  startFrame: number;
  endFrame: number;
  frameCount: number;
}

export function pingPongIndices(frameCount: number): number[] {
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new RangeError("frameCount must be a positive integer");
  }
  const result = Array.from({ length: frameCount }, (_, index) => index);
  for (let index = frameCount - 2; index >= 1; index -= 1) result.push(index);
  return result;
}

export function outputFrameCount(sourceFrameCount: number, loopMode: "pingpong" | "none"): number {
  if (!Number.isInteger(sourceFrameCount) || sourceFrameCount < 1) {
    throw new RangeError("sourceFrameCount must be a positive integer");
  }
  return loopMode === "pingpong" ? Math.max(1, sourceFrameCount * 2 - 2) : sourceFrameCount;
}

export function interpolatedForwardFrameCount(
  sourceFrameCount: number,
  factor: InterpolationFactor = 1,
): number {
  if (!Number.isInteger(sourceFrameCount) || sourceFrameCount < 1) {
    throw new RangeError("sourceFrameCount must be a positive integer");
  }
  return factor === 2 ? sourceFrameCount * 2 - 1 : sourceFrameCount;
}

export function interpolatedOutputFrameCount(
  sourceFrameCount: number,
  loopMode: "pingpong" | "none",
  factor: InterpolationFactor = 1,
): number {
  const forward = interpolatedForwardFrameCount(sourceFrameCount, factor);
  if (factor === 2 && (loopMode === "none" || sourceFrameCount === 1)) return sourceFrameCount * 2;
  return outputFrameCount(forward, loopMode);
}

export interface InterpolationFrameMapping {
  outputIndex: number;
  kind: "source" | "interpolated" | "hold";
  sourceIndex: number;
  nextSourceIndex?: number;
}

export function interpolationFrameMap(
  sourceIndices: number[],
  options: {
    includeTail?: boolean;
    sceneCutsAfter?: Iterable<number>;
    holdBoundariesAfter?: Iterable<number>;
  } = {},
): InterpolationFrameMapping[] {
  if (sourceIndices.length === 0 || sourceIndices.some((index, position) =>
    !Number.isInteger(index) || index < 0 || (position > 0 && index !== (sourceIndices[position - 1] as number) + 1))) {
    throw new RangeError("sourceIndices must be a non-empty contiguous range");
  }
  const cuts = new Set(options.sceneCutsAfter ?? []);
  const holds = new Set(options.holdBoundariesAfter ?? []);
  const result: InterpolationFrameMapping[] = [];
  for (let position = 0; position < sourceIndices.length; position += 1) {
    const sourceIndex = sourceIndices[position] as number;
    result.push({ outputIndex: sourceIndex * 2, kind: "source", sourceIndex });
    const nextSourceIndex = sourceIndices[position + 1];
    if (nextSourceIndex !== undefined) {
      result.push({
        outputIndex: sourceIndex * 2 + 1,
        kind: cuts.has(sourceIndex) || holds.has(sourceIndex) ? "hold" : "interpolated",
        sourceIndex,
        nextSourceIndex,
      });
    }
  }
  if (options.includeTail) {
    const sourceIndex = sourceIndices.at(-1) as number;
    result.push({ outputIndex: sourceIndex * 2 + 1, kind: "hold", sourceIndex });
  }
  return result;
}

export function missingFrameRanges(totalFrames: number, presentIndices: Iterable<number>): FrameRange[] {
  if (!Number.isInteger(totalFrames) || totalFrames < 0) throw new RangeError("totalFrames cannot be negative");
  const present = new Set(
    [...presentIndices].filter((index) => Number.isInteger(index) && index >= 0 && index < totalFrames),
  );
  const ranges: FrameRange[] = [];
  let start: number | null = null;
  for (let index = 0; index < totalFrames; index += 1) {
    if (!present.has(index) && start === null) start = index;
    if (start === null || (!present.has(index) && index !== totalFrames - 1)) continue;
    const rangeStart = start;
    const end = present.has(index) ? index - 1 : index;
    ranges.push({ startFrame: rangeStart, endFrame: end, frameCount: end - rangeStart + 1 });
    start = null;
  }
  return ranges;
}

export function durationForFrames(frameCount: number, frameRate: number): number {
  if (!Number.isInteger(frameCount) || frameCount < 0) throw new RangeError("frameCount cannot be negative");
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new RangeError("frameRate must be positive");
  return frameCount / frameRate;
}

export function parseRational(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value || value === "N/A") return 0;
  if (!value.includes("/")) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const [numeratorText, denominatorText] = value.split("/", 2);
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

export function clampFocus(focus: FocusPoint): FocusPoint {
  return {
    x: Math.min(1, Math.max(0, focus.x)),
    y: Math.min(1, Math.max(0, focus.y)),
  };
}

export function computeAspectLayout(
  source: TargetSize,
  target: TargetSize,
  mode: AspectMode,
  focus: FocusPoint = { x: 0.5, y: 0.5 },
): AspectLayout {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) {
    throw new RangeError("source and target dimensions must be positive");
  }
  const normalizedFocus = clampFocus(focus);
  const cover = mode === "cover" || mode === "blur-background";
  const scale = cover
    ? Math.max(target.width / source.width, target.height / source.height)
    : Math.min(target.width / source.width, target.height / source.height);
  const scaledWidth = Math.max(1, Math.round(source.width * scale));
  const scaledHeight = Math.max(1, Math.round(source.height * scale));
  const overflowX = Math.max(0, scaledWidth - target.width);
  const overflowY = Math.max(0, scaledHeight - target.height);
  const remainingX = Math.max(0, target.width - scaledWidth);
  const remainingY = Math.max(0, target.height - scaledHeight);
  return {
    scale,
    scaledWidth,
    scaledHeight,
    cropX: Math.round(overflowX * normalizedFocus.x),
    cropY: Math.round(overflowY * normalizedFocus.y),
    padX: Math.round(remainingX * normalizedFocus.x),
    padY: Math.round(remainingY * normalizedFocus.y),
  };
}

export function supportedAiScales(model: string): AiScale[] {
  return model === "realesr-animevideov3" ? [2, 3, 4] : [4];
}

export function requiredUpscaleRatio(source: TargetSize, target: TargetSize, mode: AspectMode): number {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) {
    throw new RangeError("source and target dimensions must be positive");
  }
  const widthRatio = target.width / source.width;
  const heightRatio = target.height / source.height;
  return mode === "cover" ? Math.max(widthRatio, heightRatio) : Math.min(widthRatio, heightRatio);
}

export function selectAiScale(
  source: TargetSize,
  target: TargetSize,
  mode: AspectMode,
  model: string,
  requested: AiScaleSetting = "auto",
): 1 | AiScale {
  const supported = supportedAiScales(model);
  if (requested !== "auto") {
    if (!supported.includes(requested)) throw new RangeError(`${model} does not support x${requested}`);
    return requested;
  }
  const required = requiredUpscaleRatio(source, target, mode);
  if (required <= 1) return 1;
  const maximumLanczosUpscale = 1.2;
  return supported.find((scale) => required / scale <= maximumLanczosUpscale) ?? supported.at(-1) ?? 4;
}

function decimal(value: number): string {
  return Number(value.toFixed(6)).toString();
}

export function buildFfmpegVideoFilter(
  mode: AspectMode,
  target: TargetSize,
  focus: FocusPoint = { x: 0.5, y: 0.5 },
): string {
  const x = decimal(clampFocus(focus).x);
  const y = decimal(clampFocus(focus).y);
  const size = `${target.width}:${target.height}`;
  const outputMetadata = "setsar=1,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709";
  if (mode === "cover") {
    return `scale=${size}:force_original_aspect_ratio=increase:flags=lanczos,crop=${size}:(iw-ow)*${x}:(ih-oh)*${y},${outputMetadata}`;
  }
  if (mode === "contain") {
    return `scale=${size}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${size}:(ow-iw)*${x}:(oh-ih)*${y}:color=black,${outputMetadata}`;
  }
  return [
    "split=2[background][foreground]",
    `[background]scale=${size}:force_original_aspect_ratio=increase:flags=lanczos,crop=${size}:(iw-ow)*${x}:(ih-oh)*${y},boxblur=luma_radius=min(h\\,w)/40:luma_power=2[blurred]`,
    `[foreground]scale=${size}:force_original_aspect_ratio=decrease:flags=lanczos[subject]`,
    `[blurred][subject]overlay=(W-w)/2:(H-h)/2,${outputMetadata}`,
  ].join(";");
}

export function tileFallbackOrder(tile: number): number[] {
  const manualFallbacks = [384, 256, 128, 64, 32];
  if (tile === 0) return [0, ...manualFallbacks];
  return [...new Set([tile, ...manualFallbacks.filter((candidate) => candidate < tile)])]
    .filter((candidate) => candidate > 0);
}

export function frameCacheKey(input: FrameCacheKeyInput): string {
  const usesRife = input.interpolation?.mode === "rife";
  return cacheKey({
    cacheSchemaVersion: 4,
    processingRevision: input.processingRevision ?? FRAME_CACHE_PIPELINE_REVISION,
    sceneDetectorRevision: input.sceneDetectorRevision ?? "frame-risk-v1",
    input: input.input,
    sourceFps: input.sourceFps,
    upscale: {
      mode: input.upscaleMode,
      backend: input.upscaleBackend ?? (input.upscaleMode === "lanczos" ? "lanczos" : "realesrgan-ncnn-vulkan"),
      model: input.model,
      actualScale: input.actualScale,
      requestedTile: input.requestedTile ?? null,
    },
    runtimeIdentity: input.runtimeIdentity ?? {},
    ...(usesRife ? {
      interpolation: input.interpolation,
    } : {}),
    ...(usesRife && input.sourceRange ? { sourceRange: input.sourceRange } : {}),
  });
}

export function rifeDirectoryArguments(input: {
  inputDirectory: string;
  outputDirectory: string;
  inputFrameCount: number;
  interpolation: InterpolationSpec;
  source: TargetSize;
  gpuId?: GpuId;
}): string[] {
  if (!Number.isInteger(input.inputFrameCount) || input.inputFrameCount < 2) {
    throw new RangeError("RIFE directory mode requires at least two input frames");
  }
  const useUhd = input.interpolation.memoryMode === "uhd" ||
    (input.interpolation.memoryMode === "auto" && input.source.width * input.source.height >= 3840 * 2160);
  return [
    "-i", input.inputDirectory,
    "-o", input.outputDirectory,
    "-n", String(input.inputFrameCount * 2),
    "-m", input.interpolation.model,
    "-j", "1:2:2",
    "-f", "%08d.png",
    ...(input.gpuId === undefined || input.gpuId === "auto" ? [] : ["-g", String(input.gpuId)]),
    ...(useUhd ? ["-u"] : []),
  ];
}

export function parseSceneCutBoundaries(stderr: string, frameRate: number, frameCount: number): number[] {
  if (!Number.isFinite(frameRate) || frameRate <= 0 || !Number.isInteger(frameCount) || frameCount < 1) return [];
  const cuts = new Set<number>();
  for (const match of stderr.matchAll(/lavfi\.scd\.time=([0-9]+(?:\.[0-9]+)?)/g)) {
    const boundary = Math.round(Number(match[1]) * frameRate) - 1;
    if (boundary >= 0 && boundary < frameCount - 1) cuts.add(boundary);
  }
  return [...cuts].sort((left, right) => left - right);
}

export function projectFrameStorage(
  existingSizes: number[],
  totalFrames: number,
  conservativeTotalBytes: number,
  measuredSafetyFactor = 1.5,
): FrameStorageBudget {
  if (!Number.isInteger(totalFrames) || totalFrames < 0) throw new RangeError("totalFrames cannot be negative");
  if (conservativeTotalBytes < 0) throw new RangeError("conservativeTotalBytes cannot be negative");
  const validSizes = existingSizes.filter((size) => Number.isFinite(size) && size >= 0);
  const existingBytes = validSizes.reduce((sum, size) => sum + size, 0);
  const complete = validSizes.length >= totalFrames && totalFrames > 0;
  const measured = validSizes.length >= 8;
  const average = measured ? existingBytes / validSizes.length : 0;
  const measuredTotal = measured ? Math.ceil(average * totalFrames * measuredSafetyFactor) : conservativeTotalBytes;
  const estimatedTotalBytes = complete
    ? existingBytes
    : Math.max(existingBytes, Math.min(conservativeTotalBytes, measuredTotal));
  return {
    existingBytes,
    estimatedTotalBytes,
    remainingBytes: Math.max(0, estimatedTotalBytes - existingBytes),
    frameCount: validSizes.length,
    measured,
  };
}

export function videoEncoderArguments(encoding: NormalizedH264EncodingSpec): string[] {
  if (encoding.encoder === "h264_nvenc") {
    const preset = encoding.preset === "medium" ? "p5" : encoding.preset === "slow" ? "p6" : "p7";
    return [
      "-c:v", "h264_nvenc",
      "-profile:v", "high",
      "-preset", preset,
      "-tune", "hq",
      "-rc", "vbr",
      "-cq", String(encoding.crf),
      "-b:v", "0",
    ];
  }
  return [
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", encoding.preset,
    "-crf", String(encoding.crf),
    "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv",
  ];
}

export function estimateDiskUsage(input: DiskEstimateInput): DiskEstimate {
  const safety = input.safetyFactor ?? 1.15;
  if (!Number.isFinite(safety) || safety < 1) throw new RangeError("safetyFactor must be at least 1");
  const sourceFrameCount = input.sourceFrameCount;
  const interpolationFactor = input.interpolationFactor ?? 1;
  const forwardFrameCount = interpolatedForwardFrameCount(sourceFrameCount, interpolationFactor);
  const processingFrameCount = interpolationFactor === 2 && input.loopMode === "none"
    ? sourceFrameCount * 2
    : forwardFrameCount;
  const resultFrameCount = interpolatedOutputFrameCount(sourceFrameCount, input.loopMode, interpolationFactor);
  const upscaleFactor = input.upscaleMode === "realesrgan" ? (input.upscaleFactor ?? 4) : 1;
  const rawSourceBytes = input.sourceWidth * input.sourceHeight * 4 * sourceFrameCount;
  const rawInterpolatedBytes = input.sourceWidth * input.sourceHeight * 4 * Math.max(0, processingFrameCount - sourceFrameCount);
  const rawEnhancedBytes = input.sourceWidth * upscaleFactor * input.sourceHeight * upscaleFactor * 4 * processingFrameCount;
  const sourceFramesBytes = Math.ceil(rawSourceBytes * safety);
  const interpolatedFramesBytes = interpolationFactor === 2 ? Math.ceil(rawInterpolatedBytes * safety) : 0;
  const enhancedFramesBytes = input.upscaleMode === "realesrgan" ? Math.ceil(rawEnhancedBytes * safety) : 0;
  const sequenceOverheadBytes = resultFrameCount * 4096;
  const rawTargetBytes = input.targetWidth * input.targetHeight * 1.5 * resultFrameCount;
  const outputBytes = Math.ceil(rawTargetBytes * 0.18 * safety);
  return {
    sourceFramesBytes,
    interpolatedFramesBytes,
    enhancedFramesBytes,
    sequenceOverheadBytes,
    outputBytes,
    totalBytes: sourceFramesBytes + interpolatedFramesBytes + enhancedFramesBytes + sequenceOverheadBytes + outputBytes,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function cacheKey(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function makeProgressEvent(input: {
  jobId: string;
  phase: ProgressPhase;
  current: number;
  total: number;
  startedAtMs: number;
  nowMs?: number;
  message: string;
}): ProgressEvent {
  const now = input.nowMs ?? Date.now();
  const total = Math.max(0, input.total);
  const current = Math.max(0, Math.min(input.current, total || input.current));
  const percent = total === 0 ? 0 : Number(((current / total) * 100).toFixed(2));
  const elapsed = Math.max(0, now - input.startedAtMs);
  const etaMs = current > 0 && current < total
    ? Math.max(0, Math.round((elapsed / current) * (total - current)))
    : current >= total && total > 0 ? 0 : null;
  return { jobId: input.jobId, phase: input.phase, current, total, percent, etaMs, message: input.message };
}
