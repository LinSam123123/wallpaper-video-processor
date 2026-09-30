import { describe, expect, it } from "vitest";
import { physicalDisplaySize } from "./display";

describe("physicalDisplaySize", () => {
  it("recovers even physical pixels from fractional DPI dimensions", () => {
    expect(physicalDisplaySize({ width: 1707, height: 1067 }, 1.5)).toEqual({ width: 2560, height: 1600 });
  });

  it("keeps an unscaled display unchanged", () => {
    expect(physicalDisplaySize({ width: 1920, height: 1080 }, 1)).toEqual({ width: 1920, height: 1080 });
  });
});
