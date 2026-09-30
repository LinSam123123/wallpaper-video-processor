import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeEntry, validateManifest } from "./dependency-installer";

const artifact = {
  id: "ffmpeg",
  displayName: "FFmpeg",
  version: "8.0.1",
  sourcePage: "https://example.test/source",
  downloadUrl: "https://example.test/archive.zip",
  license: "GPL-3.0-or-later",
  licenseUrl: "https://example.test/license",
  approximateSizeBytes: 100,
  sha256: "a".repeat(64),
  archive: "zip",
  executablePaths: ["bin/ffmpeg.exe"],
};

describe("desktop dependency manifest", () => {
  it("accepts a pinned HTTPS artifact", () => {
    const value = validateManifest({ schemaVersion: 1, platform: "win32-x64", artifacts: [artifact] });
    expect(value.artifacts[0]?.version).toBe("8.0.1");
  });

  it("accepts the pinned RIFE dependency id", () => {
    const rife = {
      ...artifact,
      id: "rife",
      displayName: "RIFE ncnn Vulkan",
      executablePaths: ["rife-ncnn-vulkan.exe"],
    };
    const value = validateManifest({ schemaVersion: 1, platform: "win32-x64", artifacts: [rife] });
    expect(value.artifacts[0]?.id).toBe("rife");
  });

  it("rejects paths that escape or abuse Windows names", () => {
    const root = join(tmpdir(), "wallpaper-tools");
    expect(() => safeEntry("../outside.exe", root)).toThrow();
    expect(() => safeEntry("C:\\outside.exe", root)).toThrow();
    expect(() => safeEntry("bin/file:stream", root)).toThrow();
    expect(() => safeEntry("NUL.txt", root)).toThrow();
  });
});
