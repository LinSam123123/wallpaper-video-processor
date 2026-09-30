import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LoopPreviewVariant } from "../../../shared/contracts";
import { LoopPreviewStage } from "./LoopPreviewStage";

const media = {
  path: "D:\\preview.mp4", format: "mp4", durationSeconds: 2, sizeBytes: 10,
  video: { streamIndex: 0, codec: "h264", width: 960, height: 600, frameRate: 24, frameRateMode: "constant" as const, frameCount: 48, durationSeconds: 2, pixelFormat: "yuv420p", sampleAspectRatio: "1:1", colorSpace: "bt709", colorPrimaries: "bt709", colorTransfer: "bt709", colorRange: "tv" },
  audio: [],
};

function variant(id: LoopPreviewVariant["id"], loopMode: LoopPreviewVariant["loopMode"]): LoopPreviewVariant & { url: string } {
  return { id, loopMode, label: id, description: id, outputPath: `${id}.mp4`, url: `media://${id}`, durationMs: 1, media, sourceRanges: [{ startFrame: 0, endFrameExclusive: 48 }], boundary: { type: id, outputFrame: 24 } };
}

afterEach(cleanup);

it("switches seam videos without changing the loop mode and applies only on command", () => {
  const onSelect = vi.fn();
  const onUse = vi.fn();
  const variants = [variant("pingpong-end", "pingpong"), variant("pingpong-start", "pingpong"), variant("direct-seam", "none")];
  const { rerender } = render(<LoopPreviewStage variants={variants} selected="pingpong-end" currentLoopMode="pingpong" onSelect={onSelect} onUse={onUse} />);
  expect(screen.getByRole("group", { name: "预览循环方式" })).toBeVisible();
  expect(screen.getByRole("group", { name: "乒乓折返点" })).toBeVisible();
  expect(screen.getByText(/包含两个折返点/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "尾首衔接" }));
  expect(onSelect).toHaveBeenCalledWith("direct-seam");
  expect(onUse).not.toHaveBeenCalled();
  rerender(<LoopPreviewStage variants={variants} selected="direct-seam" currentLoopMode="pingpong" onSelect={onSelect} onUse={onUse} />);
  expect(screen.queryByRole("group", { name: "乒乓折返点" })).not.toBeInTheDocument();
  expect(screen.getByText(/只包含一个接缝/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "使用此循环方式" }));
  expect(onUse).toHaveBeenCalledWith("none");
});
