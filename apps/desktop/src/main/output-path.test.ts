import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAvailableOutputPath } from "./output-path.js";

describe("available output paths", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), "wallpaper-output-path-"));
    roots.push(value);
    return value;
  }

  it("keeps an unused preferred path", async () => {
    const directory = await root();
    const preferred = join(directory, "视频.wallpaper.mp4");
    await expect(resolveAvailableOutputPath(preferred)).resolves.toBe(preferred);
  });

  it("uses the first free number without overwriting or skipping a gap", async () => {
    const directory = await root();
    const preferred = join(directory, "视频.wallpaper.mp4");
    await writeFile(preferred, "first");
    await writeFile(join(directory, "视频.wallpaper (2).mp4"), "second");
    await writeFile(join(directory, "视频.wallpaper (4).mp4"), "fourth");

    await expect(resolveAvailableOutputPath(preferred)).resolves.toBe(join(directory, "视频.wallpaper (3).mp4"));
    await expect(stat(preferred)).resolves.toMatchObject({ size: 5 });
  });

  it("continues an existing numbered name instead of nesting suffixes", async () => {
    const directory = await root();
    const numbered = join(directory, "clip.final.wallpaper (2).mp4");
    await writeFile(numbered, "second");

    await expect(resolveAvailableOutputPath(numbered)).resolves.toBe(join(directory, "clip.final.wallpaper (3).mp4"));
  });

  it("treats an unsafe numeric suffix as part of the literal filename", async () => {
    const directory = await root();
    const preferred = join(directory, "clip (999999999999999999999).mp4");
    await writeFile(preferred, "occupied");

    await expect(resolveAvailableOutputPath(preferred))
      .resolves.toBe(join(directory, "clip (999999999999999999999) (2).mp4"));
  });

  it.runIf(process.platform === "win32")("uses Windows case-insensitive collision rules", async () => {
    const directory = await root();
    await writeFile(join(directory, "CASE.WALLPAPER.MP4"), "first");

    await expect(resolveAvailableOutputPath(join(directory, "case.wallpaper.mp4")))
      .resolves.toBe(join(directory, "case.wallpaper (2).mp4"));
  });

  it("propagates filesystem errors instead of treating them as availability", async () => {
    const directory = await root();
    const fileAsDirectory = join(directory, "not-a-directory");
    await writeFile(fileAsDirectory, "occupied");

    await expect(resolveAvailableOutputPath(join(fileAsDirectory, "output.mp4"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("rejects an empty path", async () => {
    await expect(resolveAvailableOutputPath("  ")).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
  });
});
