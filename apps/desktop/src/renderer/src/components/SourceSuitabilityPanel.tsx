import type { AspectMode } from "../../../shared/contracts";
import type { SourceSuitability } from "../source-suitability";
import { createSemanticIcon } from "./SemanticIcon";

const AlertCircle = createSemanticIcon("warning");

interface SourceSuitabilityPanelProps {
  value: SourceSuitability | null;
  aspectMode: AspectMode;
  disabled?: boolean;
  onUseBlurBackground(): void;
}
function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function SourceSuitabilityPanel({ value, aspectMode, disabled = false, onUseBlurBackground }: SourceSuitabilityPanelProps): React.JSX.Element | null {
  if (!value) return null;
  const cropWarning = aspectMode === "cover" && value.cropFraction > 0.2;
  const scaleWarning = value.requiredScale > 2;
  return <div className={`source-suitability${cropWarning || scaleWarning ? " has-warning" : ""}`} aria-label="源素材适配评估">
    <div className="suitability-metrics numeric-data">
      {aspectMode === "cover" ? <span><strong>{percent(value.retainedFraction)}</strong><small>画面保留</small></span>
        : aspectMode === "contain" ? <span><strong>{percent(value.paddingFraction)}</strong><small>输出留边</small></span>
          : <span><strong>100%</strong><small>前景保留</small></span>}
      <span><strong>{value.requiredScale.toFixed(2)}×</strong><small>线性放大</small></span>
      <span><strong>{value.actualAiScale > 1 ? `${value.actualAiScale}×` : "关闭"}</strong><small>AI 倍率</small></span>
      <span><strong>{value.remainingLanczosScale.toFixed(2)}×</strong><small>剩余缩放</small></span>
    </div>
    {(cropWarning || scaleWarning) && <div className="suitability-warning" role="note">
      <AlertCircle aria-hidden="true" />
      <span>{cropWarning ? `当前构图会裁掉 ${percent(value.cropFraction)}；` : ""}建议素材接近目标比例且至少为 {value.recommendedMinimum.width} × {value.recommendedMinimum.height}。</span>
      {cropWarning && <button className="button secondary" type="button" disabled={disabled} onClick={onUseBlurBackground}>改用模糊背景</button>}
    </div>}
  </div>;
}
