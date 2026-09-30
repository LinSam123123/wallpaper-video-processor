export type AspectMode = "blur-background" | "cover" | "contain";
export type LoopMode = "pingpong" | "none";
export type UpscaleMode = "realesrgan" | "lanczos";
export type UpscaleBackend = "lanczos" | "realesrgan-ncnn-vulkan";
export type UpscaleModel = "lanczos" | "realesr-animevideov3" | "realesrgan-x4plus";
export type LegacyUpscaleModel = "realesr-animevideov3" | "realesrgan-x4plus";
export type AiScale = 2 | 3 | 4;
export type AiScaleSetting = "auto" | AiScale;
export type GpuId = "auto" | number;
export type BatchSize = 32 | 64;
export type InterpolationBackend = "rife-ncnn-vulkan";
export type RifeModel = "rife-v4.6";
export type PreviewMode = "segment" | "loop-boundary";
export type LoopTurn = "start" | "end";
export type FrameRiskKind = "exact-duplicate" | "cadence" | "near-duplicate" | "hard-cut" | "flash" | "gradual-transition" | "high-variation";

export interface FrameRiskPreview {
  frame: number;
  ptsTime?: number;
  score: number;
  kinds: FrameRiskKind[];
}

export interface FrameRiskAnalysis {
  detectorRevision: string;
  frameCount: number;
  exactDuplicateIntervals: unknown[];
  cadenceRisks: unknown[];
  nearDuplicateRisks: unknown[];
  hardCuts: unknown[];
  flashRisks: unknown[];
  gradualTransitionRisks: unknown[];
  highVariationRisks: unknown[];
  previewFrames: FrameRiskPreview[];
}
export type TaskKind = "preview" | "loop-preview" | "diagnostic-preview" | "process";
export type CachePolicy = "cleanup-on-success" | "keep-24-hours" | "keep-all";
export type DependencyId = "ffmpeg" | "realesrgan" | "rife";
export type ToolName = "ffmpeg" | "ffprobe" | "realesrgan" | "rife";

export interface FocusPoint {
  x: number;
  y: number;
}

interface JobSpecCommon {
  inputPath: string;
  outputPath: string;
  target: { width: number; height: number };
  aspectMode: AspectMode;
  focus: FocusPoint;
  loopMode: LoopMode;
  sourceFps: "auto" | number;
  encoding: {
    codec: "h264";
    encoder: "libx264" | "h264_nvenc";
    profile: "high";
    crf: number;
    preset: "medium" | "slow" | "slower";
    pixelFormat: "yuv420p";
    removeAudio: true;
  };
}

interface JobSpecBase extends JobSpecCommon {
  upscaleMode: UpscaleMode;
  model: LegacyUpscaleModel;
  tile: number;
  gpuId: GpuId;
  aiScale: AiScaleSetting;
  batchSize: BatchSize;
}

export interface InterpolationSpec {
  mode: "none" | "rife";
  factor: 1 | 2;
  model: "rife-v4.6";
  memoryMode: "auto" | "standard" | "uhd";
  sceneCutMode: "hold";
}

export interface LanczosUpscaleSpecV4 {
  backend: "lanczos";
  model: "lanczos";
}

export interface RealEsrganUpscaleSpecV4 {
  backend: "realesrgan-ncnn-vulkan";
  model: LegacyUpscaleModel;
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
  memoryMode: "auto" | "standard" | "uhd";
  sceneCutMode: "hold";
};

export interface SourceFrameRange {
  startFrame: number;
  endFrameExclusive: number;
}

export interface JobSpecV1 extends JobSpecBase {
  version: 1;
  sourceRange?: undefined;
}

export interface JobSpecV2 extends JobSpecBase {
  version: 2;
  interpolation: InterpolationSpec;
  sourceRange?: undefined;
}

export interface JobSpecV3 extends JobSpecBase {
  version: 3;
  interpolation: InterpolationSpec;
  sourceRange: SourceFrameRange;
}

export interface JobSpecV4 extends JobSpecCommon {
  version: 4;
  sourceRange: SourceFrameRange;
  upscale: UpscaleSpecV4;
  interpolation: InterpolationSpecV4;
}

export type JobSpec = JobSpecV1 | JobSpecV2 | JobSpecV3 | JobSpecV4;

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
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

export interface MediaInfo {
  path: string;
  format: string;
  durationSeconds: number;
  sizeBytes: number;
  video: VideoStreamInfo;
  audio: Array<{ index: number; codec: string }>;
}

export interface ToolStatus {
  name: ToolName;
  available: boolean;
  path: string | null;
  version: string | null;
  error?: string;
}

export interface DoctorCapabilities {
  jobSpecVersions: Array<1 | 2 | 3 | 4>;
  previewModes: PreviewMode[];
  h264Nvenc?: {
    available: boolean;
    maxDimension: 4096;
    error?: string;
  };
}

export interface DoctorReport {
  ok: boolean;
  platform: string;
  arch: string;
  cacheDirectory: string;
  cacheWritable: boolean;
  tools: ToolStatus[];
  recommendations: string[];
  capabilities?: DoctorCapabilities;
}

export interface DependencyCatalogEntry {
  id: DependencyId;
  displayName: string;
  version: string;
  sourcePage: string;
  license: string;
  licenseUrl: string;
  approximateSizeBytes: number;
  installable: boolean;
}

export interface DesktopBootstrap {
  appVersion: string;
  cacheDirectory: string;
  display: { width: number; height: number; scaleFactor: number };
  dependencyCatalog: DependencyCatalogEntry[];
  cacheSettings: CacheSettings;
}

export interface CacheSettings {
  policy: CachePolicy;
  limitBytes: number;
}

export interface FrameCacheMetadata {
  schemaVersion: 1;
  createdAt: string;
  lastAccessAt: string;
  sizeBytes: number;
  status: "active" | "recoverable" | "complete" | "legacy";
  activeJobIds: string[];
  recoverableJobIds?: string[];
  frameCacheKey: string;
  inputFingerprint: { path: string; size: number; modifiedMs: number } | null;
}

export interface CacheOverview {
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

export interface DiagnosticPreviewVariant {
  id: "A" | "B" | "C" | "D";
  label: string;
  description: string;
  outputPath: string;
  durationMs: number;
  cacheSizeBytes: number;
  frameCacheKey: string;
  actualAiScale: number;
  media: MediaInfo;
}

export interface DiagnosticPreviewResult {
  workDirectory: string;
  outputDirectory: string;
  sourceFrameCount: number;
  previewMode: PreviewMode;
  turn?: LoopTurn;
  sourceRanges: SourceFrameRange[];
  boundary?: PreviewBoundary;
  frameRiskAnalysis?: FrameRiskAnalysis;
  selectedRiskPreview?: FrameRiskPreview;
  totalDurationMs: number;
  variants: DiagnosticPreviewVariant[];
  cache: CacheOverview;
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
  sourceRanges: SourceFrameRange[];
  boundary: PreviewBoundary;
}

export interface LoopPreviewResult {
  workDirectory: string;
  outputDirectory: string;
  sourceFrameCount: number;
  totalDurationMs: number;
  target: { width: number; height: number };
  variants: LoopPreviewVariant[];
  cache: CacheOverview;
}

export interface PreviewBoundary {
  type: "pingpong-start" | "pingpong-end" | "direct-seam";
  outputFrame: number;
}

export interface ProgressEvent {
  jobId: string;
  phase: "prepare" | "inspect" | "extract" | "interpolate" | "upscale" | "sequence" | "encode" | "verify" | "complete";
  current: number;
  total: number;
  percent: number;
  etaMs: number | null;
  message: string;
}

export interface SerializedError {
  code: string;
  message: string;
  details?: unknown;
}

export type TaskEvent =
  | { taskId: string; kind: TaskKind; type: "progress"; progress: ProgressEvent }
  | { taskId: string; kind: TaskKind; type: "log"; message: string }
  | { taskId: string; kind: TaskKind; type: "complete"; result: Record<string, unknown> }
  | { taskId: string; kind: TaskKind; type: "cancelled" }
  | { taskId: string; kind: TaskKind; type: "error"; error: SerializedError };

export interface StartTaskRequest {
  spec: JobSpec;
  centerSeconds?: number;
  previewMode?: PreviewMode;
  turn?: LoopTurn;
  workDirectory?: string;
  cachePolicy?: CachePolicy;
  cacheLimitBytes?: number;
}

export interface CacheRequest {
  workDirectory: string;
  policy: CachePolicy;
  limitBytes: number;
}

export interface CacheCleanupRequest extends CacheRequest {
  force: boolean;
}

export type CleanupRequest =
  | {
    target: "job";
    taskId: string;
    jobId: string;
  }
  | {
    target: "frame-cache";
    taskId: string;
    jobId: string;
  };

export interface CleanupStatusRequest {
  taskId: string;
  jobId: string;
}

export interface CleanupStatus {
  workDirectory: string;
  jobFilesAvailable: boolean;
  frameCacheAvailable: boolean;
  frameCacheReference: string | null;
}

export interface InstallDependenciesRequest {
  ids: DependencyId[];
  consent: true;
}

export interface InstallDependenciesResult {
  installed: Array<{ id: DependencyId; version: string }>;
}

export type FontResourceFormat = "ttf" | "otf" | "woff2";

export interface FontResourceMetadata {
  id: string;
  familyName: string;
  fullName: string;
  format: FontResourceFormat;
  sizeBytes: number;
  hasChineseCoverage: boolean;
  warnings: string[];
}

export interface FontImportPreview extends Omit<FontResourceMetadata, "id"> {
  importId: string;
  previewData: Uint8Array;
}

export interface AppearanceResourceCatalog {
  fonts: FontResourceMetadata[];
  iconPacks: IconPackMetadata[];
  iconOverrides: IconOverrideMetadata[];
}

export type SafeVectorTag = "g" | "path" | "circle" | "ellipse" | "line" | "polyline" | "polygon" | "rect";
export type SafeVectorAttributeName =
  | "d" | "cx" | "cy" | "r" | "rx" | "ry" | "x" | "y" | "x1" | "y1" | "x2" | "y2"
  | "width" | "height" | "points" | "fill" | "stroke" | "strokeWidth" | "strokeLinecap"
  | "strokeLinejoin" | "strokeMiterlimit" | "fillRule" | "clipRule" | "opacity" | "fillOpacity"
  | "strokeOpacity" | "transform";

export interface SafeVectorNode {
  tag: SafeVectorTag;
  attributes: Partial<Record<SafeVectorAttributeName, string | number>>;
  children: SafeVectorNode[];
}

export interface SafeVectorIcon {
  viewBox: [number, number, number, number];
  attributes: Partial<Record<SafeVectorAttributeName, string | number>>;
  nodes: SafeVectorNode[];
  warnings: string[];
}

export interface SanitizedIconPack {
  schemaVersion: 1;
  name: string;
  version: string;
  defaultSize: number;
  icons: Partial<Record<import("./appearance-icons.js").SemanticIconName, SafeVectorIcon>>;
  warnings: string[];
}

export interface IconPackMetadata {
  id: string;
  name: string;
  version: string;
  defaultSize: number;
  iconNames: import("./appearance-icons.js").SemanticIconName[];
  warnings: string[];
}

export interface IconPackImportPreview extends Omit<IconPackMetadata, "id"> {
  importId: string;
  pack: SanitizedIconPack;
}

export type IconOverrideKind = "vector" | "png";

export interface IconOverrideMetadata {
  id: string;
  semanticName: import("./appearance-icons.js").SemanticIconName;
  kind: IconOverrideKind;
  sizeBytes: number;
  width?: number;
  height?: number;
  warnings: string[];
}

export type IconOverrideImportPreview =
  | (Omit<IconOverrideMetadata, "id" | "sizeBytes" | "width" | "height"> & { importId: string; kind: "vector"; sizeBytes: number; icon: SafeVectorIcon })
  | (Omit<IconOverrideMetadata, "id" | "sizeBytes"> & { importId: string; kind: "png"; sizeBytes: number; width: number; height: number; previewData: Uint8Array });

export type IconOverrideResource =
  | { kind: "vector"; icon: SafeVectorIcon }
  | { kind: "png"; data: Uint8Array; width: number; height: number };

export interface IconConfigSnapshot {
  schemaVersion: 1;
  preset: "fine-outline" | "soft-outline" | "custom";
  packId: string | null;
  overrides: Partial<Record<import("./appearance-icons.js").SemanticIconName, string>>;
}

export interface AppearanceImportProgress {
  importId: string;
  kind: "font" | "icon-pack" | "icon-override";
  stage: "reading" | "validating" | "sanitizing" | "ready" | "cancelled";
  percent: number;
  message: string;
}

export interface WallpaperApi {
  getBootstrap(): Promise<DesktopBootstrap>;
  doctor(): Promise<DoctorReport>;
  inspect(inputPath: string): Promise<MediaInfo>;
  selectInput(): Promise<string | null>;
  selectOutput(inputPath: string): Promise<string | null>;
  resolveAvailableOutputPath(preferredPath: string): Promise<string>;
  selectWorkDirectory(initialPath?: string): Promise<string | null>;
  registerMedia(inputPath: string): Promise<string>;
  startPreview(request: StartTaskRequest): Promise<{ taskId: string }>;
  startLoopPreview(request: StartTaskRequest): Promise<{ taskId: string }>;
  startDiagnosticPreview(request: StartTaskRequest): Promise<{ taskId: string }>;
  startProcess(request: StartTaskRequest): Promise<{ taskId: string }>;
  cancel(taskId: string): Promise<void>;
  getCleanupStatus(request: CleanupStatusRequest): Promise<CleanupStatus>;
  cleanup(request: CleanupRequest): Promise<void>;
  getCacheOverview(request: CacheRequest): Promise<CacheOverview>;
  cleanupCaches(request: CacheCleanupRequest): Promise<CacheOverview>;
  saveCacheSettings(settings: CacheSettings): Promise<CacheSettings>;
  installDependencies(request: InstallDependenciesRequest): Promise<InstallDependenciesResult>;
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  copyText(text: string): Promise<void>;
  getAppearanceResources(): Promise<AppearanceResourceCatalog>;
  previewFontImport(): Promise<FontImportPreview | null>;
  previewIconPackImport(): Promise<IconPackImportPreview | null>;
  previewIconOverrideImport(semanticName: import("./appearance-icons.js").SemanticIconName): Promise<IconOverrideImportPreview | null>;
  cancelAppearanceImport(importId: string): Promise<void>;
  commitFontImport(importId: string): Promise<FontResourceMetadata>;
  commitIconPackImport(importId: string): Promise<IconPackMetadata>;
  commitIconOverrideImport(importId: string): Promise<IconOverrideMetadata>;
  readFontResource(fontId: string): Promise<Uint8Array>;
  readIconPackResource(packId: string): Promise<SanitizedIconPack>;
  readIconOverrideResource(iconId: string): Promise<IconOverrideResource>;
  deleteFontResource(fontId: string): Promise<void>;
  deleteIconPackResource(packId: string): Promise<void>;
  deleteIconOverrideResource(iconId: string): Promise<void>;
  exportIconConfig(config: IconConfigSnapshot): Promise<boolean>;
  pathForFile(file: File): string;
  onTaskEvent(listener: (event: TaskEvent) => void): () => void;
  onAppearanceImportProgress(listener: (event: AppearanceImportProgress) => void): () => void;
}
