import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticPreviewVariant } from "../../../shared/contracts";
import { DiagnosticPreviewStage } from "./DiagnosticPreviewStage";

function variant(id: DiagnosticPreviewVariant["id"], label: string, scale: number): DiagnosticPreviewVariant & { url: string } {
  return {
    id,
    label,
    description: `${id} description`,
    outputPath: `D:\\${id}.mp4`,
    url: `wallpaper-media://local/${id}`,
    durationMs: scale * 1000,
    cacheSizeBytes: scale * 1024,
    frameCacheKey: id.toLowerCase().repeat(64),
    actualAiScale: scale,
    media: {
      path: `D:\\${id}.mp4`,
      format: "mp4",
      durationSeconds: 2,
      sizeBytes: 100,
      video: { codec: "h264", width: 2560, height: 1600, frameRate: id === "D" ? 48 : 24, frameCount: id === "D" ? 96 : 48, durationSeconds: 2 },
      audio: [],
    },
  };
}

describe("DiagnosticPreviewStage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("quick-switches variants and exposes synchronized playback", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const variants = [
      variant("A", "Lanczos", 1),
      variant("B", "AI 2x", 2),
      variant("C", "AI 3x", 3),
      variant("D", "RIFE + AI 2x", 2),
    ];
    render(<DiagnosticPreviewStage
      variants={variants}
      target={{ width: 2560, height: 1600 }}
    />);

    expect(screen.getByRole("switch", { name: "同步播放" })).toHaveAttribute("aria-checked", "true");
    const first = screen.getByLabelText("A A description") as HTMLVideoElement;
    const third = screen.getByLabelText("C C description") as HTMLVideoElement;
    expect(first.controls).toBe(true);
    expect(third.controls).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "C · AI 3x" }));
    expect(first.controls).toBe(false);
    expect(third.controls).toBe(true);
    expect(screen.getByText("24 fps")).toBeVisible();
    expect(screen.getByText("预览输出")).toBeVisible();

    fireEvent.play(third);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});
