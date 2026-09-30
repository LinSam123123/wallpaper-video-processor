import { useEffect, useRef } from "react";
import { createSemanticIcon } from "./SemanticIcon";

const Play = createSemanticIcon("play");

interface SourceSampleStripProps {
  url: string | null;
  startFrame: number;
  endFrameExclusive: number;
  frameRate: number;
  disabled?: boolean;
  onSelect(frame: number): void;
}
interface Sample {
  frame: number;
  label: string;
}

function SampleVideo({ url, sample, frameRate, disabled, onSelect }: { url: string; sample: Sample; frameRate: number; disabled: boolean; onSelect(frame: number): void }): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  const seek = (): void => {
    if (!ref.current) return;
    ref.current.currentTime = frameRate > 0 ? sample.frame / frameRate : 0;
  };
  useEffect(() => { seek(); }, [url, sample.frame, frameRate]);
  return (
    <button className="source-sample" type="button" aria-label={`查看片段${sample.label}`} disabled={disabled} onClick={() => onSelect(sample.frame)}>
      <video ref={ref} src={url} muted playsInline preload="metadata" onLoadedMetadata={seek} tabIndex={-1} aria-hidden="true" />
      <span><Play aria-hidden="true" />{sample.label}<small>{(sample.frame / Math.max(frameRate, 1)).toFixed(2)}s</small></span>
    </button>
  );
}

export function SourceSampleStrip({ url, startFrame, endFrameExclusive, frameRate, disabled = false, onSelect }: SourceSampleStripProps): React.JSX.Element | null {
  if (!url || endFrameExclusive <= startFrame) return null;
  const frames = [
    { frame: startFrame, label: "开头" },
    { frame: Math.floor((startFrame + endFrameExclusive - 1) / 2), label: "中间" },
    { frame: endFrameExclusive - 1, label: "结尾" },
  ];
  const samples = frames.filter((sample, index) => frames.findIndex((candidate) => candidate.frame === sample.frame) === index);
  return <div className="source-sample-strip" aria-label="片段首中尾抽样">
    {samples.map((sample) => <SampleVideo key={sample.frame} url={url} sample={sample} frameRate={frameRate} disabled={disabled} onSelect={onSelect} />)}
  </div>;
}
