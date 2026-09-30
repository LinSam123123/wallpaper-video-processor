import { AppError } from "./errors.js";
import {
  JOB_SPEC_VERSION,
  INTERPOLATION_JOB_SPEC_VERSION,
  LEGACY_JOB_SPEC_VERSION,
  SOURCE_RANGE_JOB_SPEC_VERSION,
  SUPPORTED_JOB_SPEC_VERSIONS,
  type AspectMode,
  type EncodingPreset,
  type BatchSize,
  type GpuId,
  type H264Encoder,
  type InterpolationBackend,
  type InterpolationMode,
  type JobSpecVersion,
  type RifeMemoryMode,
  type RifeModel,
  type NormalizedJobSpec,
  type LoopMode,
  type UpscaleBackend,
  type UpscaleMode,
  type VerificationExpectation,
} from "./types.js";

const ASPECT_MODES = new Set<AspectMode>(["blur-background", "cover", "contain"]);
const LOOP_MODES = new Set<LoopMode>(["pingpong", "none"]);
const UPSCALE_MODES = new Set<UpscaleMode>(["realesrgan", "lanczos"]);
const PRESETS = new Set<EncodingPreset>(["medium", "slow", "slower"]);
const ENCODERS = new Set<H264Encoder>(["libx264", "h264_nvenc"]);
const INTERPOLATION_MODES = new Set<InterpolationMode>(["none", "rife"]);
const RIFE_MEMORY_MODES = new Set<RifeMemoryMode>(["auto", "standard", "uhd"]);
const UPSCALE_BACKENDS = new Set<UpscaleBackend>([
  "lanczos",
  "realesrgan-ncnn-vulkan",
]);
const INTERPOLATION_BACKENDS = new Set<InterpolationBackend>([
  "rife-ncnn-vulkan",
]);
const RIFE_MODELS = new Set<RifeModel>(["rife-v4.6"]);
const SUPPORTED_JOB_SPEC_VERSION_SET = new Set<JobSpecVersion>(SUPPORTED_JOB_SPEC_VERSIONS);

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("E_INVALID_CONFIG", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("E_INVALID_CONFIG", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("E_INVALID_CONFIG", `${label} must be a finite number`);
  }
  return value;
}

function integerInRange(value: unknown, label: string, min: number, max: number): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError("E_INVALID_CONFIG", `${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function evenDimension(value: unknown, label: string): number {
  const parsed = integerInRange(value, label, 2, 16384);
  if (parsed % 2 !== 0) {
    throw new AppError("E_INVALID_CONFIG", `${label} must be even for yuv420p output`);
  }
  return parsed;
}

function member<T extends string>(value: unknown, values: Set<T>, label: string): T {
  if (typeof value !== "string" || !values.has(value as T)) {
    throw new AppError("E_INVALID_CONFIG", `${label} has an unsupported value`, {
      value,
      allowed: [...values],
    });
  }
  return value as T;
}

function rejectPresent(source: Record<string, unknown>, keys: readonly string[], label: string): void {
  const present = keys.filter((key) => source[key] !== undefined);
  if (present.length > 0) {
    throw new AppError("E_INVALID_CONFIG", `${label} does not support ${present.join(", ")}`);
  }
}

function assertOnlyKeys(source: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unsupported = Object.keys(source).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new AppError("E_INVALID_CONFIG", `${label} contains unsupported fields: ${unsupported.join(", ")}`);
  }
}

export function parseJobSpec(value: unknown): NormalizedJobSpec {
  const source = record(value, "JobSpec");
  const target = record(source.target, "target");
  const focus = source.focus === undefined ? {} : record(source.focus, "focus");
  const encoding = source.encoding === undefined ? {} : record(source.encoding, "encoding");

  const rawVersion = source.version ?? LEGACY_JOB_SPEC_VERSION;
  if (typeof rawVersion !== "number" || !SUPPORTED_JOB_SPEC_VERSION_SET.has(rawVersion as JobSpecVersion)) {
    throw new AppError("E_INVALID_CONFIG", `Unsupported JobSpec version: ${String(rawVersion)}`);
  }
  const version = rawVersion as JobSpecVersion;
  if (version < SOURCE_RANGE_JOB_SPEC_VERSION && source.sourceRange !== undefined) {
    throw new AppError(
      "E_INVALID_CONFIG",
      `sourceRange is only supported in JobSpec v${SOURCE_RANGE_JOB_SPEC_VERSION} and newer`,
    );
  }

  let sourceRange;
  if (version >= SOURCE_RANGE_JOB_SPEC_VERSION) {
    const range = record(source.sourceRange, "sourceRange");
    const startFrame = integerInRange(range.startFrame, "sourceRange.startFrame", 0, Number.MAX_SAFE_INTEGER);
    const endFrameExclusive = integerInRange(
      range.endFrameExclusive,
      "sourceRange.endFrameExclusive",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (endFrameExclusive <= startFrame) {
      throw new AppError("E_INVALID_CONFIG", "sourceRange must contain at least one frame");
    }
    sourceRange = { startFrame, endFrameExclusive };
  }

  const isV4 = version === JOB_SPEC_VERSION;
  if (isV4) {
    rejectPresent(
      source,
      ["upscaleMode", "model", "tile", "gpuId", "aiScale", "batchSize"],
      `JobSpec v${JOB_SPEC_VERSION}`,
    );
  }

  const supportsInterpolation = version >= INTERPOLATION_JOB_SPEC_VERSION;
  const interpolationSource = isV4
    ? record(source.interpolation, "interpolation")
    : supportsInterpolation && source.interpolation !== undefined
      ? record(source.interpolation, "interpolation")
      : {};

  let interpolationBackend: InterpolationBackend = "rife-ncnn-vulkan";
  let interpolationMode: InterpolationMode;
  let interpolationFactor: 1 | 2;
  let interpolationModel: RifeModel;
  let interpolationMemoryMode: RifeMemoryMode;

  if (isV4) {
    assertOnlyKeys(
      interpolationSource,
      ["mode", "factor", "backend", "model", "memoryMode", "sceneCutMode"],
      "interpolation",
    );
    interpolationMode = member(interpolationSource.mode, INTERPOLATION_MODES, "interpolation.mode");
    interpolationFactor = integerInRange(interpolationSource.factor, "interpolation.factor", 1, 2) as 1 | 2;
    interpolationBackend = member(
      interpolationSource.backend,
      INTERPOLATION_BACKENDS,
      "interpolation.backend",
    );
    interpolationModel = member(interpolationSource.model, RIFE_MODELS, "interpolation.model");
    interpolationMemoryMode = member(
      interpolationSource.memoryMode,
      RIFE_MEMORY_MODES,
      "interpolation.memoryMode",
    );
    if (interpolationSource.sceneCutMode !== "hold") {
      throw new AppError("E_INVALID_CONFIG", "interpolation.sceneCutMode must be hold");
    }
    const validEngine = interpolationBackend === "rife-ncnn-vulkan" && interpolationModel === "rife-v4.6";
    if (!validEngine) {
      throw new AppError(
        "E_INVALID_CONFIG",
        `interpolation backend ${interpolationBackend} does not support model ${interpolationModel}`,
      );
    }
  } else {
    interpolationMode = supportsInterpolation
      ? member(interpolationSource.mode ?? "none", INTERPOLATION_MODES, "interpolation.mode")
      : "none";
    interpolationFactor = integerInRange(
      supportsInterpolation ? interpolationSource.factor ?? (interpolationMode === "rife" ? 2 : 1) : 1,
      "interpolation.factor",
      1,
      2,
    ) as 1 | 2;
    const legacyModel = interpolationSource.model ?? "rife-v4.6";
    if (legacyModel !== "rife-v4.6") {
      throw new AppError("E_INVALID_CONFIG", "interpolation.model must be rife-v4.6");
    }
    interpolationModel = "rife-v4.6";
    interpolationMemoryMode = member(
      interpolationSource.memoryMode ?? "auto",
      RIFE_MEMORY_MODES,
      "interpolation.memoryMode",
    );
    const sceneCutMode = interpolationSource.sceneCutMode ?? "hold";
    if (sceneCutMode !== "hold") {
      throw new AppError("E_INVALID_CONFIG", "interpolation.sceneCutMode must be hold");
    }
  }

  if ((interpolationMode === "rife" && interpolationFactor !== 2) ||
      (interpolationMode === "none" && interpolationFactor !== 1)) {
    throw new AppError(
      "E_INVALID_CONFIG",
      `interpolation mode ${interpolationMode} requires factor ${interpolationMode === "rife" ? 2 : 1}`,
    );
  }

  const focusX = finiteNumber(focus.x ?? 0.5, "focus.x");
  const focusY = finiteNumber(focus.y ?? 0.5, "focus.y");
  if (focusX < 0 || focusX > 1 || focusY < 0 || focusY > 1) {
    throw new AppError("E_INVALID_CONFIG", "focus coordinates must be normalized to 0..1");
  }

  const sourceFpsValue = source.sourceFps ?? "auto";
  const sourceFps = sourceFpsValue === "auto"
    ? "auto"
    : finiteNumber(sourceFpsValue, "sourceFps");
  if (sourceFps !== "auto" && (sourceFps <= 0 || sourceFps > 240)) {
    throw new AppError("E_INVALID_CONFIG", "sourceFps must be greater than 0 and at most 240");
  }

  let upscaleMode: UpscaleMode;
  let upscaleBackend: UpscaleBackend;
  let model: string;
  let tile: number;
  let gpuId: GpuId;
  let aiScaleValue: "auto" | 2 | 3 | 4;
  let batchSizeValue: BatchSize;

  const parseTile = (value: unknown, label: string, fallback: number): number => {
    const parsed = integerInRange(value ?? fallback, label, 0, 4096);
    if (parsed !== 0 && parsed % 32 !== 0) {
      throw new AppError("E_INVALID_CONFIG", `${label} must be 0 (automatic) or a multiple of 32`);
    }
    return parsed;
  };
  const parseGpu = (value: unknown, label: string): GpuId =>
    value === undefined || value === null || value === "auto" ? "auto" : integerInRange(value, label, 0, 31);
  const parseAiScale = (value: unknown, label: string, fallback: "auto" | 2): "auto" | 2 | 3 | 4 => {
    const parsed = value ?? fallback;
    if (parsed !== "auto" && parsed !== 2 && parsed !== 3 && parsed !== 4) {
      throw new AppError("E_INVALID_CONFIG", `${label} must be auto, 2, 3, or 4`);
    }
    return parsed;
  };
  const parseBatchSize = (value: unknown, label: string, fallback: BatchSize): BatchSize => {
    const parsed = integerInRange(value ?? fallback, label, 32, 64);
    if (parsed !== 32 && parsed !== 64) {
      throw new AppError("E_INVALID_CONFIG", `${label} must be 32 or 64`);
    }
    return parsed as BatchSize;
  };

  if (isV4) {
    const upscale = record(source.upscale, "upscale");
    upscaleBackend = member(upscale.backend, UPSCALE_BACKENDS, "upscale.backend");
    if (upscaleBackend === "lanczos") {
      assertOnlyKeys(upscale, ["backend", "model"], "upscale");
      if (upscale.model !== "lanczos") {
        throw new AppError("E_INVALID_CONFIG", "upscale backend lanczos requires model lanczos");
      }
      upscaleMode = "lanczos";
      model = "lanczos";
      tile = 0;
      gpuId = "auto";
      aiScaleValue = "auto";
      batchSizeValue = 64;
    } else if (upscaleBackend === "realesrgan-ncnn-vulkan") {
      assertOnlyKeys(upscale, ["backend", "model", "tile", "gpuId", "aiScale", "batchSize"], "upscale");
      if (upscale.model !== "realesr-animevideov3" && upscale.model !== "realesrgan-x4plus") {
        throw new AppError(
          "E_INVALID_CONFIG",
          "upscale backend realesrgan-ncnn-vulkan requires a supported Real-ESRGAN model",
        );
      }
      upscaleMode = "realesrgan";
      model = upscale.model;
      tile = parseTile(upscale.tile, "upscale.tile", 384);
      gpuId = parseGpu(upscale.gpuId, "upscale.gpuId");
      aiScaleValue = parseAiScale(upscale.aiScale, "upscale.aiScale", "auto");
      if (model === "realesrgan-x4plus" && aiScaleValue !== "auto" && aiScaleValue !== 4) {
        throw new AppError("E_INVALID_CONFIG", "realesrgan-x4plus is only supported at x4");
      }
      batchSizeValue = parseBatchSize(upscale.batchSize, "upscale.batchSize", 64);
    } else {
      throw new AppError("E_INVALID_CONFIG", `Unsupported upscale backend: ${String(upscaleBackend)}`);
    }
  } else {
    upscaleMode = member(source.upscaleMode ?? "realesrgan", UPSCALE_MODES, "upscaleMode");
    upscaleBackend = upscaleMode === "realesrgan" ? "realesrgan-ncnn-vulkan" : "lanczos";
    tile = parseTile(source.tile, "tile", 384);
    model = stringValue(source.model ?? "realesr-animevideov3", "model");
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
      throw new AppError("E_INVALID_CONFIG", "model must be a model name, not a path or command fragment");
    }
    gpuId = parseGpu(source.gpuId, "gpuId");
    aiScaleValue = parseAiScale(source.aiScale, "aiScale", "auto");
    if (aiScaleValue !== "auto" && model !== "realesr-animevideov3" && aiScaleValue !== 4) {
      throw new AppError("E_INVALID_CONFIG", `${model} is only supported at x4`);
    }
    batchSizeValue = parseBatchSize(source.batchSize, "batchSize", 64);
  }

  const crf = integerInRange(encoding.crf ?? 17, "encoding.crf", 0, 51);
  const removeAudio = encoding.removeAudio ?? true;
  if (removeAudio !== true) {
    throw new AppError("E_INVALID_CONFIG", "v1 always removes audio");
  }

  if ((encoding.codec ?? "h264") !== "h264" ||
      (encoding.profile ?? "high") !== "high" ||
      (encoding.pixelFormat ?? "yuv420p") !== "yuv420p") {
    throw new AppError("E_INVALID_CONFIG", "v1 encoding is fixed to H.264 High/yuv420p");
  }

  return {
    version,
    inputPath: stringValue(source.inputPath, "inputPath"),
    outputPath: stringValue(source.outputPath, "outputPath"),
    target: {
      width: evenDimension(target.width, "target.width"),
      height: evenDimension(target.height, "target.height"),
    },
    aspectMode: member(source.aspectMode ?? "cover", ASPECT_MODES, "aspectMode"),
    focus: { x: focusX, y: focusY },
    loopMode: member(source.loopMode ?? "pingpong", LOOP_MODES, "loopMode"),
    upscaleMode,
    upscaleBackend,
    model,
    tile,
    sourceFps,
    gpuId,
    aiScale: aiScaleValue,
    batchSize: batchSizeValue as BatchSize,
    interpolation: {
      backend: interpolationBackend,
      mode: interpolationMode,
      factor: interpolationFactor as 1 | 2,
      model: interpolationModel,
      memoryMode: interpolationMemoryMode,
      sceneCutMode: "hold",
    },
    ...(sourceRange ? { sourceRange } : {}),
    encoding: {
      codec: "h264",
      encoder: member(encoding.encoder ?? "libx264", ENCODERS, "encoding.encoder"),
      profile: "high",
      crf,
      preset: member(encoding.preset ?? "slow", PRESETS, "encoding.preset"),
      pixelFormat: "yuv420p",
      removeAudio: true,
    },
  } as NormalizedJobSpec;
}

export function assertEncoderResolutionSupported(spec: NormalizedJobSpec): void {
  const maxDimension = 4096;
  if (spec.encoding.encoder !== "h264_nvenc" ||
      (spec.target.width <= maxDimension && spec.target.height <= maxDimension)) return;
  const scale = Math.min(maxDimension / spec.target.width, maxDimension / spec.target.height);
  const evenFloor = (value: number): number => Math.max(2, Math.floor(value / 2) * 2);
  throw new AppError(
    "E_ENCODER_UNSUPPORTED_RESOLUTION",
    `h264_nvenc supports target dimensions up to ${maxDimension} pixels per side`,
    {
      encoder: "h264_nvenc",
      requested: { ...spec.target },
      maxDimension,
      suggestedTarget: {
        width: evenFloor(spec.target.width * scale),
        height: evenFloor(spec.target.height * scale),
      },
      supportedEncoder: "libx264",
    },
  );
}

export function parseVerificationExpectation(value: unknown): VerificationExpectation {
  const source = record(value, "verification expectation");
  const result: VerificationExpectation = {};
  const optionalPositive = (key: keyof VerificationExpectation): number | undefined => {
    if (source[key] === undefined) return undefined;
    const parsed = finiteNumber(source[key], String(key));
    if (parsed < 0) throw new AppError("E_INVALID_CONFIG", `${String(key)} cannot be negative`);
    return parsed;
  };

  result.width = optionalPositive("width");
  result.height = optionalPositive("height");
  result.frameRate = optionalPositive("frameRate");
  result.frameCount = optionalPositive("frameCount");
  result.durationSeconds = optionalPositive("durationSeconds");
  result.durationToleranceSeconds = optionalPositive("durationToleranceSeconds");
  result.frameRateTolerance = optionalPositive("frameRateTolerance");

  if (source.sampleAspectRatio !== undefined) {
    if (source.sampleAspectRatio !== "1:1") {
      throw new AppError("E_INVALID_CONFIG", "sampleAspectRatio must be 1:1");
    }
    result.sampleAspectRatio = "1:1";
  }
  if (source.codec !== undefined) {
    if (source.codec !== "h264") throw new AppError("E_INVALID_CONFIG", "codec must be h264");
    result.codec = "h264";
  }
  if (source.pixelFormat !== undefined) {
    if (source.pixelFormat !== "yuv420p") throw new AppError("E_INVALID_CONFIG", "pixelFormat must be yuv420p");
    result.pixelFormat = "yuv420p";
  }
  if (source.colorSpace !== undefined) {
    if (source.colorSpace !== "bt709") throw new AppError("E_INVALID_CONFIG", "colorSpace must be bt709");
    result.colorSpace = "bt709";
  }
  if (source.colorPrimaries !== undefined) {
    if (source.colorPrimaries !== "bt709") throw new AppError("E_INVALID_CONFIG", "colorPrimaries must be bt709");
    result.colorPrimaries = "bt709";
  }
  if (source.colorTransfer !== undefined) {
    if (source.colorTransfer !== "bt709") throw new AppError("E_INVALID_CONFIG", "colorTransfer must be bt709");
    result.colorTransfer = "bt709";
  }
  if (source.colorRange !== undefined) {
    if (source.colorRange !== "tv") throw new AppError("E_INVALID_CONFIG", "colorRange must be tv");
    result.colorRange = "tv";
  }
  if (source.audio !== undefined) {
    if (source.audio !== "none" && source.audio !== "any") {
      throw new AppError("E_INVALID_CONFIG", "audio must be none or any");
    }
    result.audio = source.audio;
  }
  return Object.fromEntries(Object.entries(result).filter(([, item]) => item !== undefined)) as VerificationExpectation;
}
