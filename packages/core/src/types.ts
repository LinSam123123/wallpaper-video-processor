export const LEGACY_JOB_SPEC_VERSION = 1 as const;
export const INTERPOLATION_JOB_SPEC_VERSION = 2 as const;
export const SOURCE_RANGE_JOB_SPEC_VERSION = 3 as const;
export const JOB_SPEC_VERSION = 4 as const;
export const SUPPORTED_JOB_SPEC_VERSIONS = [
  LEGACY_JOB_SPEC_VERSION,
  INTERPOLATION_JOB_SPEC_VERSION,
  SOURCE_RANGE_JOB_SPEC_VERSION,
  JOB_SPEC_VERSION,
] as const;

export type JobSpecVersion = (typeof SUPPORTED_JOB_SPEC_VERSIONS)[number];

export type AspectMode = "blur-background" | "cover" | "contain";
export type LoopMode = "pingpong" | "none";
export type UpscaleMode = "realesrgan" | "lanczos";
export type UpscaleBackend = "lanczos" | "realesrgan-ncnn-vulkan";
export type UpscaleModel = "lanczos" | "realesr-animevideov3" | "realesrgan-x4plus";
export type EncodingPreset = "medium" | "slow" | "slower";
export type H264Encoder = "libx264" | "h264_nvenc";
export type AiScale = 2 | 3 | 4;
export type AiScaleSetting = "auto" | AiScale;
export type GpuId = "auto" | number;
export type BatchSize = 32 | 64;
export type InterpolationMode = "none" | "rife";
export type InterpolationFactor = 1 | 2;
export type InterpolationBackend = "rife-ncnn-vulkan";
export type RifeModel = "rife-v4.6";
export type RifeMemoryMode = "auto" | "standard" | "uhd";
export type SceneCutMode = "hold";
export type CachePolicy = "cleanup-on-success" | "keep-24-hours" | "keep-all";
export type CacheEntryStatus = "active" | "recoverable" | "complete" | "legacy";
export type PreviewMode = "segment" | "loop-boundary";
export type LoopTurn = "start" | "end";

export interface SourceFrameRange {
  startFrame: number;
  endFrameExclusive: number;
}

export interface InterpolationSpec {
  mode: InterpolationMode;
  factor: InterpolationFactor;
  model: "rife-v4.6";
  memoryMode: RifeMemoryMode;
  sceneCutMode: SceneCutMode;
}

export type LegacyInterpolationSpec = InterpolationSpec;

export type NormalizedInterpolationSpec = InterpolationSpec & { backend: "rife-ncnn-vulkan" };

export interface FocusPoint {
  x: number;
  y: number;
}

export interface TargetSize {
  width: number;
  height: number;
}

export interface H264EncodingSpec {
  codec: "h264";
  encoder?: H264Encoder;
  profile: "high";
  crf: number;
  preset: EncodingPreset;
  pixelFormat: "yuv420p";
  removeAudio: true;
}

export interface JobSpecCommon {
  inputPath: string;
  outputPath: string;
  target: TargetSize;
  aspectMode: AspectMode;
  focus: FocusPoint;
  loopMode: LoopMode;
  sourceFps: number | "auto";
  encoding: H264EncodingSpec;
}

export interface JobSpecBase extends JobSpecCommon {
  upscaleMode: UpscaleMode;
  model: string;
  tile: number;
  gpuId?: GpuId;
  aiScale?: AiScaleSetting;
  batchSize?: BatchSize;
  interpolation?: Partial<LegacyInterpolationSpec>;
}

export interface LanczosUpscaleSpecV4 {
  backend: "lanczos";
  model: "lanczos";
}

export interface RealEsrganUpscaleSpecV4 {
  backend: "realesrgan-ncnn-vulkan";
  model: "realesr-animevideov3" | "realesrgan-x4plus";
  tile?: number;
  gpuId?: GpuId;
  aiScale?: AiScaleSetting;
  batchSize?: BatchSize;
}

export type UpscaleSpecV4 = LanczosUpscaleSpecV4 | RealEsrganUpscaleSpecV4;

type InterpolationEngineSpecV4 = { backend: "rife-ncnn-vulkan"; model: "rife-v4.6" };

type InterpolationModeSpecV4 =
  | { mode: "none"; factor: 1 }
  | { mode: "rife"; factor: 2 };

export type InterpolationSpecV4 = InterpolationEngineSpecV4 & InterpolationModeSpecV4 & {
  memoryMode: RifeMemoryMode;
  sceneCutMode: SceneCutMode;
};

export interface JobSpecV1 extends JobSpecBase {
  version: typeof LEGACY_JOB_SPEC_VERSION;
  sourceRange?: undefined;
}

export interface JobSpecV2 extends JobSpecBase {
  version: typeof INTERPOLATION_JOB_SPEC_VERSION;
  sourceRange?: undefined;
}

export interface JobSpecV3 extends JobSpecBase {
  version: typeof SOURCE_RANGE_JOB_SPEC_VERSION;
  sourceRange: SourceFrameRange;
}

export interface JobSpecV4 extends JobSpecCommon {
  version: typeof JOB_SPEC_VERSION;
  sourceRange: SourceFrameRange;
  upscale: UpscaleSpecV4;
  interpolation: InterpolationSpecV4;
}

export type JobSpec = JobSpecV1 | JobSpecV2 | JobSpecV3 | JobSpecV4;

export interface NormalizedH264EncodingSpec extends H264EncodingSpec {
  encoder: H264Encoder;
}

export interface NormalizedJobSpecBase extends JobSpecCommon {
  upscaleMode: UpscaleMode;
  upscaleBackend: UpscaleBackend;
  model: string;
  tile: number;
  gpuId: GpuId;
  aiScale: AiScaleSetting;
  batchSize: BatchSize;
  interpolation: NormalizedInterpolationSpec;
  encoding: NormalizedH264EncodingSpec;
}

export type NormalizedJobSpec = NormalizedJobSpecBase & (
  | {
      version: typeof LEGACY_JOB_SPEC_VERSION | typeof INTERPOLATION_JOB_SPEC_VERSION;
      sourceRange?: undefined;
    }
  | {
      version: typeof SOURCE_RANGE_JOB_SPEC_VERSION | typeof JOB_SPEC_VERSION;
      sourceRange: SourceFrameRange;
    }
);

export interface FrameStorageBudget {
  existingBytes: number;
  estimatedTotalBytes: number;
  remainingBytes: number;
  frameCount: number;
  measured: boolean;
}

export interface SpaceBudget {
  workDirectory: string;
  outputDirectory: string;
  sameVolume: boolean;
  source: FrameStorageBudget;
  interpolated: FrameStorageBudget;
  enhanced: FrameStorageBudget;
  sequenceRemainingBytes: number;
  batchOverheadBytes: number;
  workRequiredBytes: number;
  outputRequiredBytes: number;
  combinedRequiredBytes: number;
}

export interface FrameCacheMetadata {
  schemaVersion: 1;
  createdAt: string;
  lastAccessAt: string;
  sizeBytes: number;
  status: CacheEntryStatus;
  activeJobIds: string[];
  recoverableJobIds?: string[];
  frameCacheKey: string;
  inputFingerprint: {
    path: string;
    size: number;
    modifiedMs: number;
  } | null;
}

export interface CacheMaintenanceResult {
  workDirectory: string;
  cacheDirectory: string;
  policy: CachePolicy;
  limitBytes: number;
  totalBytes: number;
  releasedBytes: number;
  remainingBytes: number;
  removedKeys: string[];
  legacyCount: number;
  entries: FrameCacheMetadata[];
  errors: string[];
}

export interface VideoStreamInfo {
  index: number;
  codec: string;
  width: number;
  height: number;
  sampleAspectRatio?: string;
  displayAspectRatio?: string;
  pixelFormat?: string;
  colorSpace?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorRange?: string;
  frameRate: number;
  frameRateMode?: "constant" | "variable" | "unknown";
  frameCount: number;
  durationSeconds: number;
}

export interface AudioStreamInfo {
  index: number;
  codec: string;
}

export interface MediaInfo {
  path: string;
  format: string;
  durationSeconds: number;
  sizeBytes: number;
  video: VideoStreamInfo;
  audio: AudioStreamInfo[];
}

export type ProgressPhase =
  | "prepare"
  | "inspect"
  | "extract"
  | "interpolate"
  | "upscale"
  | "sequence"
  | "encode"
  | "verify"
  | "complete";

export interface ProgressEvent {
  jobId: string;
  phase: ProgressPhase;
  current: number;
  total: number;
  percent: number;
  etaMs: number | null;
  message: string;
}

export type ProgressListener = (event: ProgressEvent) => void;

export interface VerificationExpectation {
  width?: number;
  height?: number;
  sampleAspectRatio?: "1:1";
  frameRate?: number;
  frameCount?: number;
  durationSeconds?: number;
  codec?: "h264";
  pixelFormat?: "yuv420p";
  colorSpace?: "bt709";
  colorPrimaries?: "bt709";
  colorTransfer?: "bt709";
  colorRange?: "tv";
  audio?: "none" | "any";
  durationToleranceSeconds?: number;
  frameRateTolerance?: number;
}

export interface VerificationCheck {
  name: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

export interface VerificationHealthSegment {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

export interface VerificationHealth {
  fullDecodeCompleted: boolean;
  blackSegments: VerificationHealthSegment[];
  freezeSegments: VerificationHealthSegment[];
  catastrophicBlack: boolean;
  catastrophicFreeze: boolean;
  decodeError?: string;
}

export interface VerificationDecodeReference {
  inputPath: string;
  media: MediaInfo;
  sourceRange?: SourceFrameRange;
  sourceRanges?: SourceFrameRange[];
}

export type FullDecodeVerification = boolean | {
  reference: VerificationDecodeReference;
};

export interface VerificationResult {
  passed: boolean;
  media: MediaInfo;
  checks: VerificationCheck[];
  health?: VerificationHealth;
  referenceHealth?: VerificationHealth;
}

export interface BinaryPaths {
  ffmpeg: string;
  ffprobe: string;
  realesrgan: string;
  rife: string;
}

export interface ToolStatus {
  name: keyof BinaryPaths;
  available: boolean;
  path: string | null;
  version: string | null;
  error?: string;
}

export interface DoctorReport {
  ok: boolean;
  platform: NodeJS.Platform;
  arch: string;
  cacheDirectory: string;
  cacheWritable: boolean;
  tools: ToolStatus[];
  recommendations: string[];
  capabilities?: DoctorCapabilities;
}

export interface DoctorCapabilities {
  jobSpecVersions: JobSpecVersion[];
  previewModes: PreviewMode[];
  h264Nvenc: {
    available: boolean;
    maxDimension: 4096;
    error?: string;
  };
}

export interface PreviewOptions {
  centerSeconds?: number;
  frameCount?: number;
  outputPath?: string;
  previewMode?: PreviewMode;
  turn?: LoopTurn;
}

export interface PreviewBoundary {
  type: "pingpong-start" | "pingpong-end" | "direct-seam";
  /** Zero-based output frame at which the inspected loop boundary is shown. */
  outputFrame: number;
}

export interface ProcessResult {
  jobId: string;
  outputPath: string;
  media: MediaInfo;
  verification: VerificationResult;
  resumed: boolean;
  workDirectory: string;
  frameCacheKey: string;
  actualAiScale: number;
  sourceRange: SourceFrameRange;
  sourceFrameCount: number;
  frameRiskAnalysis?: import("./frame-risk.js").FrameRiskAnalysis;
  cacheMaintenance?: CacheMaintenanceResult;
}

export interface PreviewResult {
  jobId: string;
  outputPath: string;
  startFrame: number;
  frameCount: number;
  sourceFrameCount: number;
  media: MediaInfo;
  verification: VerificationResult;
  workDirectory: string;
  frameCacheKey: string;
  actualAiScale: number;
  previewMode: PreviewMode;
  turn?: LoopTurn;
  sourceRanges: SourceFrameRange[];
  boundary?: PreviewBoundary;
  frameRiskAnalysis?: import("./frame-risk.js").FrameRiskAnalysis;
  selectedRiskPreview?: import("./frame-risk.js").FrameRiskPreview;
}

export type DiagnosticVariantId = "A" | "B" | "C" | "D";

export interface DiagnosticPreviewVariant {
  id: DiagnosticVariantId;
  label: string;
  description: string;
  outputPath: string;
  durationMs: number;
  cacheSizeBytes: number;
  frameCacheKey: string;
  actualAiScale: number;
  media: MediaInfo;
  verification: VerificationResult;
}

export interface DiagnosticPreviewResult {
  workDirectory: string;
  outputDirectory: string;
  sourceFrameCount: number;
  totalDurationMs: number;
  variants: DiagnosticPreviewVariant[];
  cache: CacheMaintenanceResult;
  previewMode: PreviewMode;
  turn?: LoopTurn;
  sourceRanges: SourceFrameRange[];
  boundary?: PreviewBoundary;
  frameRiskAnalysis?: import("./frame-risk.js").FrameRiskAnalysis;
  selectedRiskPreview?: import("./frame-risk.js").FrameRiskPreview;
}

export type LoopPreviewVariantId = "pingpong-end" | "pingpong-start" | "direct-seam";

export interface LoopPreviewVariant {
  id: LoopPreviewVariantId;
  label: string;
  description: string;
  loopMode: LoopMode;
  outputPath: string;
  durationMs: number;
  media: MediaInfo;
  verification: VerificationResult;
  sourceRanges: SourceFrameRange[];
  boundary: PreviewBoundary;
}

export interface LoopPreviewResult {
  workDirectory: string;
  outputDirectory: string;
  sourceFrameCount: number;
  totalDurationMs: number;
  target: TargetSize;
  variants: LoopPreviewVariant[];
  cache: CacheMaintenanceResult;
}
