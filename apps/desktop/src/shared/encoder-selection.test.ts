import { describe, expect, it } from "vitest";
import type { DoctorCapabilities } from "./contracts";
import { resolveEncoderPreference } from "./encoder-selection";

const nvenc: DoctorCapabilities = {
  jobSpecVersions: [1, 2, 3, 4],
  previewModes: ["segment", "loop-boundary"],
  h264Nvenc: { available: true, maxDimension: 4096 },
};

describe("encoder preference resolution", () => {
  it("keeps legacy automatic preferences on CPU quality mode", () => {
    expect(resolveEncoderPreference("auto", { width: 2560, height: 1600 }, nvenc)).toMatchObject({ encoder: "libx264", reason: "automatic-cpu" });
    expect(resolveEncoderPreference("auto", { width: 3840, height: 2160 }, nvenc)).toMatchObject({ encoder: "libx264", reason: "automatic-cpu" });
  });

  it("does not let capability probing silently enable NVENC", () => {
    expect(resolveEncoderPreference("auto", { width: 5120, height: 3200 }, nvenc)).toMatchObject({ encoder: "libx264", reason: "automatic-cpu" });
    expect(resolveEncoderPreference("auto", { width: 2560, height: 1600 })).toMatchObject({ encoder: "libx264", reason: "automatic-cpu" });
    expect(resolveEncoderPreference("auto", { width: 2560, height: 1600 }, {
      ...nvenc,
      h264Nvenc: { available: false, maxDimension: 4096, error: "driver unavailable" },
    })).toMatchObject({ encoder: "libx264", reason: "automatic-cpu" });
  });

  it("keeps explicit CPU and NVIDIA choices deterministic", () => {
    expect(resolveEncoderPreference("libx264", { width: 2560, height: 1600 }, nvenc)).toMatchObject({ encoder: "libx264", reason: "manual-cpu" });
    expect(resolveEncoderPreference("h264_nvenc", { width: 5120, height: 3200 }, nvenc)).toMatchObject({ encoder: "h264_nvenc", reason: "manual-nvidia" });
  });
});
