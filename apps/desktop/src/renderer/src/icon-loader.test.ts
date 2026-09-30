import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperApi } from "../../shared/contracts";
import { loadIconOverride, releaseIconOverride } from "./icon-loader";

describe("icon override loader", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn().mockReturnValue("blob:validated-icon") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  it("loads validated PNG bytes once per resource ID and revokes the blob URL", async () => {
    const id = `icon-${"d".repeat(32)}`;
    const readIconOverrideResource = vi.fn().mockResolvedValue({ kind: "png", data: new Uint8Array([1, 2, 3]), width: 32, height: 24 });
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: { readIconOverrideResource } as Partial<WallpaperApi> });
    const metadata = { id, semanticName: "appLogo" as const, kind: "png" as const, sizeBytes: 3, width: 32, height: 24, warnings: [] };

    expect(await loadIconOverride(metadata)).toMatchObject({ kind: "png", url: "blob:validated-icon", width: 32, height: 24 });
    expect(await loadIconOverride(metadata)).toMatchObject({ kind: "png", url: "blob:validated-icon" });
    expect(readIconOverrideResource).toHaveBeenCalledTimes(1);
    releaseIconOverride(id);
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:validated-icon"));
  });
});
