import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { AspectMode, FocusPoint } from "../../../shared/contracts";
import { createSemanticIcon } from "./SemanticIcon";

const FileVideo = createSemanticIcon("sourceVideo");
const FolderOpen = createSemanticIcon("openFolder");
const UploadCloud = createSemanticIcon("emptyState");

interface VideoStageProps {
  url: string | null;
  label: string;
  target: { width: number; height: number };
  aspectMode: AspectMode;
  focus: FocusPoint;
  disabled: boolean;
  seekRequest?: { seconds: number; id: number } | null;
  playRange?: { startSeconds: number; endSeconds: number } | null;
  onBrowse(): void;
  onFocusChange(focus: FocusPoint): void;
  onCurrentTimeChange?(seconds: number): void;
}

export function VideoStage({
  url,
  label,
  target,
  aspectMode,
  focus,
  disabled,
  seekRequest = null,
  playRange = null,
  onBrowse,
  onFocusChange,
  onCurrentTimeChange,
}: VideoStageProps): React.JSX.Element {
  const foreground = useRef<HTMLVideoElement>(null);
  const background = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    foreground.current?.load();
    background.current?.load();
  }, [url]);

  useEffect(() => {
    if (!seekRequest) return;
    if (foreground.current) foreground.current.currentTime = seekRequest.seconds;
    if (background.current) background.current.currentTime = seekRequest.seconds;
  }, [seekRequest?.id, seekRequest?.seconds]);

  const syncBackground = (): void => {
    const front = foreground.current;
    const back = background.current;
    if (!front || !back) return;
    if (Math.abs(back.currentTime - front.currentTime) > 0.08) back.currentTime = front.currentTime;
  };

  const syncPlaybackRange = (): void => {
    const front = foreground.current;
    if (!front) return;
    if (playRange && front.currentTime >= playRange.endSeconds) {
      front.currentTime = playRange.startSeconds;
      if (background.current) background.current.currentTime = playRange.startSeconds;
    }
    onCurrentTimeChange?.(front.currentTime);
    syncBackground();
  };

  const updateFocus = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (aspectMode !== "cover" || disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    onFocusChange({
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    });
  };

  if (!url) {
    return (
      <button className="video-empty" type="button" onClick={onBrowse} disabled={disabled}>
        <UploadCloud aria-hidden="true" />
        <strong className="display-title">载入一段视频开始处理</strong>
        <span>支持 MP4、MOV、MKV 与 WebM，也可以直接拖入此处</span>
        <span className="video-empty-action"><FolderOpen aria-hidden="true" />选择视频</span>
      </button>
    );
  }

  const objectPosition = `${Math.round(focus.x * 100)}% ${Math.round(focus.y * 100)}%`;
  return (
    <div
      className={`video-stage mode-${aspectMode}`}
      style={{ aspectRatio: `${target.width} / ${target.height}` }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFocus(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFocus(event);
      }}
    >
      {aspectMode === "blur-background" && (
        <video ref={background} className="video-background" src={url} muted playsInline tabIndex={-1} aria-hidden="true" />
      )}
      <video
        ref={foreground}
        className="video-foreground"
        src={url}
        controls
        muted
        playsInline
        style={{ objectPosition }}
        onLoadedMetadata={() => {
          if (playRange && foreground.current && (foreground.current.currentTime < playRange.startSeconds || foreground.current.currentTime >= playRange.endSeconds)) {
            foreground.current.currentTime = playRange.startSeconds;
          }
        }}
        onPlay={() => {
          if (playRange && foreground.current && (foreground.current.currentTime < playRange.startSeconds || foreground.current.currentTime >= playRange.endSeconds)) {
            foreground.current.currentTime = playRange.startSeconds;
          }
          void background.current?.play();
        }}
        onPause={() => background.current?.pause()}
        onSeeked={syncBackground}
        onTimeUpdate={syncPlaybackRange}
      />
      <div className="stage-label"><FileVideo aria-hidden="true" />{label}</div>
      {aspectMode === "cover" && (
        <div
          className="focus-marker"
          aria-hidden="true"
          style={{ left: `${focus.x * 100}%`, top: `${focus.y * 100}%` }}
        />
      )}
    </div>
  );
}
