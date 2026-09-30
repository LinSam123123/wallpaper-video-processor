import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoStage } from "./VideoStage";

const commonProps = {
  url: "wallpaper-media://local/source",
  label: "源视频",
  target: { width: 2560, height: 1600 },
  focus: { x: 0.5, y: 0.5 },
  disabled: false,
  onBrowse: vi.fn(),
  onFocusChange: vi.fn(),
};

describe("VideoStage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("applies seek requests to foreground and blurred background videos", () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const { container, rerender } = render(<VideoStage
      {...commonProps}
      aspectMode="blur-background"
      seekRequest={{ seconds: 2.5, id: 1 }}
    />);
    const videos = [...container.querySelectorAll("video")];
    expect(videos).toHaveLength(2);
    expect(videos.map((video) => video.currentTime)).toEqual([2.5, 2.5]);

    rerender(<VideoStage
      {...commonProps}
      aspectMode="blur-background"
      seekRequest={{ seconds: 2.5, id: 2 }}
    />);
    expect(videos.map((video) => video.currentTime)).toEqual([2.5, 2.5]);
  });

  it("wraps at the exclusive play-range end and reports the effective time", () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const onCurrentTimeChange = vi.fn();
    const { container } = render(<VideoStage
      {...commonProps}
      aspectMode="blur-background"
      playRange={{ startSeconds: 1.25, endSeconds: 4 }}
      onCurrentTimeChange={onCurrentTimeChange}
    />);
    const background = container.querySelector(".video-background") as HTMLVideoElement;
    const foreground = container.querySelector(".video-foreground") as HTMLVideoElement;

    foreground.currentTime = 4;
    background.currentTime = 3.8;
    fireEvent.timeUpdate(foreground);
    expect(foreground.currentTime).toBe(1.25);
    expect(background.currentTime).toBe(1.25);
    expect(onCurrentTimeChange).toHaveBeenLastCalledWith(1.25);

    foreground.currentTime = 2.5;
    background.currentTime = 1.25;
    fireEvent.timeUpdate(foreground);
    expect(background.currentTime).toBe(2.5);
    expect(onCurrentTimeChange).toHaveBeenLastCalledWith(2.5);
  });
});
