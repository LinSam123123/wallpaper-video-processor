import type { AiScaleSetting, AspectMode, LegacyUpscaleModel, MediaInfo, UpscaleMode } from "../../shared/contracts";

export interface SourceSuitability {
  requiredScale: number;
  retainedFraction: number;
  cropFraction: number;
  paddingFraction: number;
  actualAiScale: number;
  remainingLanczosScale: number;
  recommendedMinimum: { width: number; height: number };
}
function supportedScales(model: LegacyUpscaleModel): Array<2 | 3 | 4> {
  return model === "realesr-animevideov3" ? [2, 3, 4] : [4];
}

function resolveAiScale(
  requiredScale: number,
  mode: UpscaleMode,
  model: LegacyUpscaleModel,
  requested: AiScaleSetting,
): number {
  if (mode === "lanczos") return 1;
  if (requested !== "auto") return requested;
  const scales = supportedScales(model);
  return scales.find((scale) => requiredScale / scale <= 1.2) ?? scales.at(-1) ?? 4;
}

function evenCeil(value: number): number {
  return Math.max(2, Math.ceil(value / 2) * 2);
}

export function sourceSuitability(
  media: MediaInfo | null,
  target: { width: number; height: number },
  aspectMode: AspectMode,
  upscaleMode: UpscaleMode,
  model: LegacyUpscaleModel,
  requestedAiScale: AiScaleSetting,
): SourceSuitability | null {
  if (!media || media.video.width <= 0 || media.video.height <= 0 || target.width <= 0 || target.height <= 0) return null;
  const source = { width: media.video.width, height: media.video.height };
  const widthRatio = target.width / source.width;
  const heightRatio = target.height / source.height;
  const coverScale = Math.max(widthRatio, heightRatio);
  const containScale = Math.min(widthRatio, heightRatio);
  const requiredScale = aspectMode === "cover" ? coverScale : containScale;
  const scaleForLayout = aspectMode === "cover" ? coverScale : containScale;
  const scaledWidth = source.width * scaleForLayout;
  const scaledHeight = source.height * scaleForLayout;
  const retainedFraction = aspectMode === "cover"
    ? Math.min(1, (target.width * target.height) / (scaledWidth * scaledHeight))
    : 1;
  const paddingFraction = aspectMode === "contain"
    ? Math.max(0, 1 - (scaledWidth * scaledHeight) / (target.width * target.height))
    : 0;
  const actualAiScale = resolveAiScale(requiredScale, upscaleMode, model, requestedAiScale);
  return {
    requiredScale,
    retainedFraction,
    cropFraction: 1 - retainedFraction,
    paddingFraction,
    actualAiScale,
    remainingLanczosScale: Math.max(1, requiredScale / actualAiScale),
    recommendedMinimum: {
      width: evenCeil(target.width / 2),
      height: evenCeil(target.height / 2),
    },
  };
}
