import type { JobSpec, StartTaskRequest } from "./contracts.js";

export const H264_NVENC_MAX_DIMENSION = 4096;

export interface EncoderResolutionDetails {
  encoder: "h264_nvenc";
  requested: { width: number; height: number };
  maxDimension: number;
  suggestedTarget: { width: number; height: number };
  supportedEncoder: "libx264";
}

function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export function fitWithinDimension(
  target: { width: number; height: number },
  maxDimension = H264_NVENC_MAX_DIMENSION,
): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / target.width, maxDimension / target.height);
  return {
    width: Math.min(maxDimension, evenFloor(target.width * scale)),
    height: Math.min(maxDimension, evenFloor(target.height * scale)),
  };
}

export function encoderResolutionDetails(spec: {
  target: { width: number; height: number };
  encoding: { encoder: JobSpec["encoding"]["encoder"] };
}): EncoderResolutionDetails | null {
  if (spec.encoding.encoder !== "h264_nvenc" ||
      (spec.target.width <= H264_NVENC_MAX_DIMENSION && spec.target.height <= H264_NVENC_MAX_DIMENSION)) {
    return null;
  }
  return {
    encoder: "h264_nvenc",
    requested: { ...spec.target },
    maxDimension: H264_NVENC_MAX_DIMENSION,
    suggestedTarget: fitWithinDimension(spec.target),
    supportedEncoder: "libx264",
  };
}

function invalid(message: string, code = "E_INVALID_CONFIG", details?: unknown): never {
  throw Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validGpuId(value: unknown, optional = false): boolean {
  return (optional && value === undefined) || value === "auto" ||
    (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 31);
}

function validAiScale(value: unknown, optional = false): boolean {
  return (optional && value === undefined) || ["auto", 2, 3, 4].includes(value as "auto" | number);
}

function validTile(value: unknown, optional = false): boolean {
  if (optional && value === undefined) return true;
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 4096 &&
    ((value as number) === 0 || (value as number) % 32 === 0);
}

function validInterpolation(spec: JobSpec): boolean {
  if (spec.version === 1) return true;
  const interpolation = spec.interpolation;
  if (!isRecord(interpolation) ||
      !["auto", "standard", "uhd"].includes(interpolation.memoryMode) ||
      interpolation.sceneCutMode !== "hold") return false;
  if (spec.version === 4) {
    if (!hasOnlyKeys(interpolation, ["mode", "factor", "backend", "model", "memoryMode", "sceneCutMode"])) {
      return false;
    }
    const validEngine = interpolation.backend === "rife-ncnn-vulkan" && interpolation.model === "rife-v4.6";
    if (!validEngine) return false;
  } else if (interpolation.model !== "rife-v4.6") {
    return false;
  }
  return (interpolation.mode === "none" && interpolation.factor === 1) ||
    (interpolation.mode === "rife" && interpolation.factor === 2);
}

function validSourceRange(spec: JobSpec): boolean {
  if (spec.version < 3) return spec.sourceRange === undefined;
  const range = spec.sourceRange;
  if (!range) return false;
  return Number.isSafeInteger(range.startFrame) &&
    Number.isSafeInteger(range.endFrameExclusive) &&
    range.startFrame >= 0 &&
    range.endFrameExclusive > range.startFrame;
}

function validV4Upscale(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.backend === "lanczos") {
    return value.model === "lanczos" && hasOnlyKeys(value, ["backend", "model"]);
  }
  if (value.backend === "realesrgan-ncnn-vulkan") {
    return (value.model === "realesr-animevideov3" || value.model === "realesrgan-x4plus") &&
      hasOnlyKeys(value, ["backend", "model", "tile", "gpuId", "aiScale", "batchSize"]) &&
      validTile(value.tile, true) && validGpuId(value.gpuId, true) && validAiScale(value.aiScale, true) &&
      (value.model !== "realesrgan-x4plus" || value.aiScale === undefined || value.aiScale === "auto" || value.aiScale === 4) &&
      (value.batchSize === undefined || value.batchSize === 32 || value.batchSize === 64);
  }
  return false;
}

function validUpscale(spec: JobSpec): boolean {
  if (spec.version !== 4) {
    return validGpuId(spec.gpuId) && validAiScale(spec.aiScale) && [32, 64].includes(spec.batchSize);
  }
  const source = spec as unknown as Record<string, unknown>;
  if (["upscaleMode", "model", "tile", "gpuId", "aiScale", "batchSize"]
    .some((key) => source[key] !== undefined)) return false;
  return validV4Upscale(spec.upscale);
}

export function validateJobRequest(value: unknown): StartTaskRequest {
  if (!value || typeof value !== "object") invalid("任务参数无效");
  const request = value as StartTaskRequest;
  const spec = request.spec;
  if (!spec || (spec.version !== 1 && spec.version !== 2 && spec.version !== 3 && spec.version !== 4) ||
      typeof spec.inputPath !== "string" || typeof spec.outputPath !== "string" ||
      !Number.isInteger(spec.target?.width) || !Number.isInteger(spec.target?.height) ||
      spec.target.width < 2 || spec.target.height < 2 ||
      spec.target.width > 16_384 || spec.target.height > 16_384 ||
      spec.target.width % 2 !== 0 || spec.target.height % 2 !== 0) {
    invalid("任务配置不完整，输出尺寸必须为 2 到 16384 之间的正偶数");
  }
  if (request.centerSeconds !== undefined && (!Number.isFinite(request.centerSeconds) || request.centerSeconds < 0)) {
    invalid("预览位置无效");
  }
  if (request.previewMode !== undefined && request.previewMode !== "segment" && request.previewMode !== "loop-boundary") {
    invalid("预览模式无效");
  }
  const previewMode = request.previewMode ?? "segment";
  if (previewMode === "loop-boundary" && request.centerSeconds !== undefined) {
    invalid("循环边界预览不能同时指定中心位置");
  }
  if (request.turn !== undefined && request.turn !== "start" && request.turn !== "end") {
    invalid("循环转折点无效");
  }
  if (request.turn !== undefined && (previewMode !== "loop-boundary" || spec.loopMode !== "pingpong")) {
    invalid("只有乒乓循环的边界预览才能指定转折点");
  }
  if (!spec.encoding || !validUpscale(spec) ||
      !["libx264", "h264_nvenc"].includes(spec.encoding.encoder) ||
      !validInterpolation(spec) ||
      !validSourceRange(spec)) {
    invalid("GPU、AI 倍率、插帧或编码器配置无效");
  }
  if (request.workDirectory !== undefined && typeof request.workDirectory !== "string") {
    invalid("工作文件位置无效");
  }
  if (request.cachePolicy !== undefined &&
      !["cleanup-on-success", "keep-24-hours", "keep-all"].includes(request.cachePolicy)) {
    invalid("缓存策略无效");
  }
  if (request.cacheLimitBytes !== undefined &&
      (!Number.isSafeInteger(request.cacheLimitBytes) || request.cacheLimitBytes < 0)) {
    invalid("缓存上限无效");
  }
  const resolution = encoderResolutionDetails(spec);
  if (resolution) {
    invalid(
      `H.264 NVIDIA 编码器不支持 ${spec.target.width} × ${spec.target.height} 输出`,
      "E_ENCODER_UNSUPPORTED_RESOLUTION",
      resolution,
    );
  }
  return request;
}
