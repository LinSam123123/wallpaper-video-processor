import type { AiScaleSetting, AspectMode, BatchSize, GpuId, InterpolationSpec } from "../../shared/contracts";
import type { EncoderPreference } from "../../shared/encoder-selection";

export const DEFAULT_UI_SETTINGS: {
  aspectMode: AspectMode;
  gpuId: GpuId;
  aiScale: AiScaleSetting;
  encoder: EncoderPreference;
  batchSize: BatchSize;
  interpolation: InterpolationSpec;
} = {
  aspectMode: "cover",
  gpuId: "auto",
  aiScale: "auto",
  encoder: "libx264",
  batchSize: 64,
  interpolation: {
    mode: "none",
    factor: 1,
    model: "rife-v4.6",
    memoryMode: "auto",
    sceneCutMode: "hold",
  },
};
