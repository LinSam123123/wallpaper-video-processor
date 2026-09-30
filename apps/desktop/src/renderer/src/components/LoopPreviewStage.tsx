import type { LoopMode, LoopPreviewVariant, LoopPreviewVariantId } from "../../../shared/contracts";
import { formatFrameRate, formatMediaDuration } from "../media-format";
import { MetadataRow } from "./MetadataRow";
import { SegmentedControl } from "./SegmentedControl";
import { createSemanticIcon } from "./SemanticIcon";

const Check = createSemanticIcon("confirm");
const RotateCcw = createSemanticIcon("reset");
const ScanLine = createSemanticIcon("diagnostic");

interface LoopVariantWithUrl extends LoopPreviewVariant {
  url: string;
}

interface LoopPreviewStageProps {
  variants: LoopVariantWithUrl[];
  selected: LoopPreviewVariantId;
  currentLoopMode: LoopMode;
  onSelect(id: LoopPreviewVariantId): void;
  onUse(loopMode: LoopMode): void;
}

export function LoopPreviewStage({ variants, selected, currentLoopMode, onSelect, onUse }: LoopPreviewStageProps): React.JSX.Element {
  const active = variants.find((variant) => variant.id === selected) ?? variants[0];
  if (!active) return <div className="empty-stage">快速循环预览尚未生成</div>;
  const applied = active.loopMode === currentLoopMode;
  const strategy = active.loopMode;
  const pingpongVariants = variants.filter((variant) => variant.loopMode === "pingpong");
  const selectStrategy = (next: LoopMode): void => {
    if (next === "none") {
      onSelect("direct-seam");
      return;
    }
    onSelect(pingpongVariants.some((variant) => variant.id === selected) ? selected : "pingpong-end");
  };

  return (
    <div className="loop-preview-stage">
      <div className="diagnostic-toolbar loop-preview-toolbar">
        <div className="loop-preview-selectors">
          <SegmentedControl<LoopMode>
            label="预览循环方式"
            value={strategy}
            options={[
              { value: "pingpong", label: "乒乓往返", icon: <RotateCcw aria-hidden="true" /> },
              { value: "none", label: "尾首衔接", icon: <ScanLine aria-hidden="true" /> },
            ]}
            onChange={selectStrategy}
          />
          {strategy === "pingpong" && <SegmentedControl<"pingpong-end" | "pingpong-start">
            label="乒乓折返点"
            value={active.id === "pingpong-start" ? "pingpong-start" : "pingpong-end"}
            options={[
              { value: "pingpong-end", label: "片尾折返" },
              { value: "pingpong-start", label: "片头折返" },
            ]}
            onChange={onSelect}
          />}
        </div>
        <button className={applied ? "button ghost" : "button secondary"} type="button" disabled={applied} onClick={() => onUse(active.loopMode)}>
          <Check aria-hidden="true" />{applied ? "当前循环方式" : "使用此循环方式"}
        </button>
      </div>
      <div className="diagnostic-video" style={{ aspectRatio: `${active.media.video.width} / ${active.media.video.height}` }}>
        <video key={active.id} src={active.url} controls autoPlay loop muted playsInline preload="auto" aria-label={active.label} />
        <div className="stage-label">{active.label}</div>
      </div>
      <p className="loop-preview-description">{strategy === "pingpong" ? "乒乓往返包含两个折返点，请分别检查片尾折返和片头折返。" : "尾首衔接只包含一个接缝：片尾直接回到片头。"}</p>
      <MetadataRow className="preview-output-metadata" label="快速预览" icon={<ScanLine aria-hidden="true" />} items={[
        { key: "resolution", content: `${active.media.video.width} × ${active.media.video.height}`, priority: "key" },
        { key: "duration", content: formatMediaDuration(active.media.video.durationSeconds), priority: "key" },
        { key: "fps", content: formatFrameRate(active.media.video.frameRate) },
        { key: "method", content: "Lanczos · 无 AI 插帧" },
      ]} />
    </div>
  );
}
