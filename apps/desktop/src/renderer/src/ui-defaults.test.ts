import { describe, expect, it } from "vitest";
import { DEFAULT_UI_SETTINGS } from "./ui-defaults";

describe("desktop defaults", () => {
  it("starts with cover framing and CPU quality encoding", () => {
    expect(DEFAULT_UI_SETTINGS).toEqual({
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
    });
  });
});
