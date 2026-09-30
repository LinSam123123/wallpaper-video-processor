import type { DoctorCapabilities, JobSpec } from "./contracts.js";

export type EncoderPreference = "auto" | JobSpec["encoding"]["encoder"];

export interface ResolvedEncoder {
  encoder: JobSpec["encoding"]["encoder"];
  reason: "automatic-cpu" | "automatic-unavailable" | "manual-nvidia" | "manual-cpu";
  label: string;
}

export function resolveEncoderPreference(
  preference: EncoderPreference,
  target: { width: number; height: number },
  capabilities?: DoctorCapabilities,
): ResolvedEncoder {
  const nvenc = capabilities?.h264Nvenc;
  void target;
  if (preference === "libx264") {
    return { encoder: "libx264", reason: "manual-cpu", label: "高质量 CPU" };
  }
  if (preference === "h264_nvenc") {
    if (nvenc?.available === false) {
      return { encoder: "libx264", reason: "automatic-unavailable", label: "CPU，未检测到可用 NVENC" };
    }
    return { encoder: "h264_nvenc", reason: "manual-nvidia", label: "NVIDIA RTX 编码" };
  }
  return { encoder: "libx264", reason: "automatic-cpu", label: "质量 / 小体积 · CPU" };
}
