import type { CSSProperties } from "react";
import { createSemanticIcon } from "./SemanticIcon";
import { Tooltip } from "./Tooltip";

const RotateCcw = createSemanticIcon("reset");

export interface SourceFrameRange {
  startFrame: number;
  endFrameExclusive: number;
}
interface TrimRangeProps {
  range: SourceFrameRange;
  totalFrames: number;
  frameRate: number;
  currentFrame: number;
  loopMode: "pingpong" | "none";
  disabled?: boolean;
  onChange(range: SourceFrameRange, seekFrame: number): void;
  onReset(): void;
}

function formatFrameTime(frame: number, frameRate: number): string {
  const seconds = frameRate > 0 ? frame / frameRate : 0;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

export function TrimRange({ range, totalFrames, frameRate, currentFrame, loopMode, disabled = false, onChange, onReset }: TrimRangeProps): React.JSX.Element {
  const safeTotal = Math.max(1, totalFrames);
  const startPercent = range.startFrame / safeTotal * 100;
  const endPercent = range.endFrameExclusive / safeTotal * 100;
  const selectedFrames = Math.max(1, range.endFrameExclusive - range.startFrame);
  const selectedSeconds = frameRate > 0 ? selectedFrames / frameRate : 0;
  const outputFrames = loopMode === "pingpong" ? Math.max(1, selectedFrames * 2 - 2) : selectedFrames;
  const outputSeconds = frameRate > 0 ? outputFrames / frameRate : 0;
  const setStart = (): void => {
    const startFrame = Math.min(Math.max(0, currentFrame), range.endFrameExclusive - 1);
    onChange({ ...range, startFrame }, startFrame);
  };
  const setEnd = (): void => {
    const endFrameExclusive = Math.max(range.startFrame + 1, Math.min(safeTotal, currentFrame + 1));
    onChange({ ...range, endFrameExclusive }, endFrameExclusive - 1);
  };

  return (
    <div className="trim-editor">
      <div
        className="trim-slider"
        style={{ "--trim-start": `${startPercent}%`, "--trim-end": `${endPercent}%` } as CSSProperties}
      >
        <div className="trim-track" aria-hidden="true"><span /></div>
        <input
          className="trim-handle trim-handle-start"
          type="range"
          aria-label="片段入点"
          min={0}
          max={Math.max(0, safeTotal - 1)}
          step={1}
          value={range.startFrame}
          disabled={disabled}
          onChange={(event) => {
            const startFrame = Math.min(Number(event.target.value), range.endFrameExclusive - 1);
            onChange({ ...range, startFrame }, startFrame);
          }}
        />
        <input
          className="trim-handle trim-handle-end"
          type="range"
          aria-label="片段出点"
          min={1}
          max={safeTotal}
          step={1}
          value={range.endFrameExclusive}
          disabled={disabled}
          onChange={(event) => {
            const endFrameExclusive = Math.max(Number(event.target.value), range.startFrame + 1);
            onChange({ ...range, endFrameExclusive }, endFrameExclusive - 1);
          }}
        />
      </div>
      <div className="trim-time-row numeric-data">
        <span>入点 {formatFrameTime(range.startFrame, frameRate)}</span>
        <span>出点 {formatFrameTime(range.endFrameExclusive, frameRate)}</span>
      </div>
      <div className="trim-summary">
        <span><strong>{selectedSeconds.toFixed(2)} 秒</strong><small>{selectedFrames} 帧片段</small></span>
        <span><strong>{outputSeconds.toFixed(2)} 秒</strong><small>预计成片</small></span>
      </div>
      <div className="trim-actions">
        <button className="button secondary" type="button" disabled={disabled} onClick={setStart}>设为入点</button>
        <button className="button secondary" type="button" disabled={disabled} onClick={setEnd}>设为出点</button>
        <Tooltip content="恢复完整片段">
          <button className="icon-button" type="button" aria-label="重置片段范围" disabled={disabled || (range.startFrame === 0 && range.endFrameExclusive === safeTotal)} onClick={onReset}>
            <RotateCcw aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
