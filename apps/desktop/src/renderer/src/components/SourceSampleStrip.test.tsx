import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceSampleStrip } from "./SourceSampleStrip";

describe("SourceSampleStrip", () => {
  afterEach(cleanup);

  it("samples the first, middle, and last frames and reports the selected frame", () => {
    const onSelect = vi.fn();
    const { container } = render(<SourceSampleStrip
      url="wallpaper-media://local/source"
      startFrame={10}
      endFrameExclusive={21}
      frameRate={10}
      onSelect={onSelect}
    />);

    expect(screen.getByRole("button", { name: "查看片段开头" })).toHaveTextContent("1.00s");
    expect(screen.getByRole("button", { name: "查看片段中间" })).toHaveTextContent("1.50s");
    expect(screen.getByRole("button", { name: "查看片段结尾" })).toHaveTextContent("2.00s");
    expect([...container.querySelectorAll("video")].map((video) => video.currentTime)).toEqual([1, 1.5, 2]);

    fireEvent.click(screen.getByRole("button", { name: "查看片段中间" }));
    expect(onSelect).toHaveBeenCalledWith(15);
  });

  it("deduplicates samples for one- and two-frame clips", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<SourceSampleStrip
      url="wallpaper-media://local/source"
      startFrame={4}
      endFrameExclusive={5}
      frameRate={24}
      onSelect={onSelect}
    />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "查看片段开头" }));
    expect(onSelect).toHaveBeenLastCalledWith(4);

    rerender(<SourceSampleStrip
      url="wallpaper-media://local/source"
      startFrame={4}
      endFrameExclusive={6}
      frameRate={24}
      onSelect={onSelect}
    />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "查看片段中间" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看片段结尾" }));
    expect(onSelect).toHaveBeenLastCalledWith(5);
  });
});
