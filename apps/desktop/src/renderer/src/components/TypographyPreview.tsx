import type { TypographyTitleScope } from "../appearance";

export interface TypographyPreviewProps {
  titleScope: TypographyTitleScope;
  uiFamilies: string;
  displayFamilies: string;
}

export function TypographyPreview({ titleScope, uiFamilies, displayFamilies }: TypographyPreviewProps): React.JSX.Element {
  return (
    <div className="typography-preview" aria-label="排版预览" data-preview-title-scope={titleScope}>
      <strong className="display-title">AI 视频壁纸处理器</strong>
      <span className="major-section-title">清晰度与循环</span>
      <span className="minor-section-title">工作文件与缓存</span>
      <span className="field-label typography-preview-label">输出分辨率</span>
      <code className="numeric-data">2560 × 1600 · 48 fps · 1.4 GB</code>
      <p className="typography-preview-english">
        <span className="major-section-title">The quick brown fox</span>
        <span className="ui-body">jumps over the lazy dog</span>
      </p>
      <p className="typography-preview-families">展示：{displayFamilies} · 界面：{uiFamilies}</p>
    </div>
  );
}
