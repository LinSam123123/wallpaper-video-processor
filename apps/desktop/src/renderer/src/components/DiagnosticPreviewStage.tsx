import { useEffect, useRef, useState } from "react";
import type { DiagnosticPreviewVariant } from "../../../shared/contracts";
import { formatFrameRate, formatMediaDuration, formatMetadataBytes } from "../media-format";
import { SegmentedControl } from "./SegmentedControl";
import { MetadataRow } from "./MetadataRow";
import { Switch } from "./Switch";
import { createSemanticIcon } from "./SemanticIcon";

const Play = createSemanticIcon("play");
const ScanLine = createSemanticIcon("diagnostic");
const Sparkles = createSemanticIcon("processedVideo");

interface DiagnosticVariantWithUrl extends DiagnosticPreviewVariant {
  url: string;
}

interface DiagnosticPreviewStageProps {
  variants: DiagnosticVariantWithUrl[];
  target: { width: number; height: number };
}

export function DiagnosticPreviewStage({
  variants,
  target,
}: DiagnosticPreviewStageProps): React.JSX.Element {
  const [selected, setSelected] = useState<DiagnosticPreviewVariant["id"]>(variants[0]?.id ?? "A");
  const [synchronized, setSynchronized] = useState(true);
  const refs = useRef(new Map<DiagnosticPreviewVariant["id"], HTMLVideoElement>());

  useEffect(() => {
    if (!variants.some((variant) => variant.id === selected)) setSelected(variants[0]?.id ?? "A");
  }, [selected, variants]);

  const active = variants.find((variant) => variant.id === selected) ?? variants[0];

  const syncTime = (source: HTMLVideoElement): void => {
    if (!synchronized) return;
    for (const video of refs.current.values()) {
      if (video === source || !Number.isFinite(source.currentTime)) continue;
      if (Math.abs(video.currentTime - source.currentTime) > 0.06) video.currentTime = source.currentTime;
    }
  };

  const playAll = (source: HTMLVideoElement): void => {
    if (!synchronized) return;
    syncTime(source);
    for (const video of refs.current.values()) if (video !== source) void video.play().catch(() => undefined);
  };

  const pauseAll = (source: HTMLVideoElement): void => {
    if (!synchronized) return;
    for (const video of refs.current.values()) if (video !== source) video.pause();
  };

  const switchVariant = (next: DiagnosticPreviewVariant["id"]): void => {
    const previousVideo = refs.current.get(selected);
    const nextVideo = refs.current.get(next);
    const time = previousVideo?.currentTime ?? 0;
    const wasPlaying = previousVideo ? !previousVideo.paused : false;
    if (!synchronized) previousVideo?.pause();
    if (nextVideo && Number.isFinite(time)) nextVideo.currentTime = time;
    setSelected(next);
    if (!synchronized && wasPlaying && nextVideo) void nextVideo.play().catch(() => undefined);
  };

  return (
    <div className="diagnostic-preview">
      <div className="diagnostic-toolbar">
        <SegmentedControl<DiagnosticPreviewVariant["id"]>
          label="诊断方案"
          value={selected}
          options={variants.map((variant) => ({
            value: variant.id,
            label: `${variant.id} · ${variant.label}`,
            icon: variant.id === "A" ? <ScanLine aria-hidden="true" /> : <Sparkles aria-hidden="true" />,
          }))}
          onChange={switchVariant}
        />
        <Switch
          checked={synchronized}
          label="同步播放"
          icon={<Play aria-hidden="true" />}
          tooltip="同步播放四个诊断方案"
          onChange={setSynchronized}
        />
      </div>
      <div className="diagnostic-video" style={{ aspectRatio: `${target.width} / ${target.height}` }}>
        {variants.map((variant) => (
          <video
            key={variant.id}
            ref={(node) => {
              if (node) refs.current.set(variant.id, node);
              else refs.current.delete(variant.id);
            }}
            className={variant.id === selected ? "is-active" : ""}
            src={variant.url}
            controls={variant.id === selected}
            muted
            playsInline
            preload="auto"
            aria-label={`${variant.id} ${variant.description}`}
            onPlay={(event) => playAll(event.currentTarget)}
            onPause={(event) => pauseAll(event.currentTarget)}
            onSeeked={(event) => syncTime(event.currentTarget)}
            onTimeUpdate={(event) => syncTime(event.currentTarget)}
          />
        ))}
        {active && <div className="stage-label">{active.id} · {active.description}</div>}
      </div>
      {active && (
        <MetadataRow className="diagnostic-metrics preview-output-metadata" label="预览输出" icon={<ScanLine aria-hidden="true" />} items={[
          { key: "resolution", content: `${active.media.video.width} × ${active.media.video.height}`, priority: "key" },
          { key: "duration", content: formatMediaDuration(active.durationMs / 1_000), priority: "key" },
          { key: "fps", content: formatFrameRate(active.media.video.frameRate) },
          { key: "frames", content: active.media.video.frameCount > 0 ? `${active.media.video.frameCount} 帧` : null },
          { key: "method", content: active.actualAiScale === 1 ? "Lanczos" : `AI ${active.actualAiScale}×` },
          { key: "cache", content: formatMetadataBytes(active.cacheSizeBytes) },
        ]} />
      )}
    </div>
  );
}
