import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type {
  AspectMode,
  CacheOverview,
  CachePolicy,
  DependencyId,
  DependencyCatalogEntry,
  DesktopBootstrap,
  DoctorReport,
  DiagnosticPreviewResult,
  LoopPreviewResult,
  LoopPreviewVariantId,
  FocusPoint,
  InterpolationSpec,
  JobSpec,
  LegacyUpscaleModel,
  MediaInfo,
  AppearanceResourceCatalog,
  FontImportPreview,
  FontResourceMetadata,
  IconPackImportPreview,
  IconPackMetadata,
  IconOverrideImportPreview,
  IconOverrideMetadata,
  IconConfigSnapshot,
  AppearanceImportProgress,
  AiScaleSetting,
  GpuId,
  SanitizedIconPack,
  SerializedError,
  TaskEvent,
  TaskKind,
  UpscaleMode,
} from "../../shared/contracts";
import { encoderResolutionDetails } from "../../shared/job-validation";
import { SegmentedControl } from "./components/SegmentedControl";
import { VideoStage } from "./components/VideoStage";
import { CleanupDialog } from "./components/CleanupDialog";
import { DiagnosticPreviewStage } from "./components/DiagnosticPreviewStage";
import { LoopPreviewStage } from "./components/LoopPreviewStage";
import { formatSerializedError } from "./error-format";
import { DEFAULT_UI_SETTINGS } from "./ui-defaults";
import {
  ACCENT_PRESETS,
  DEFAULT_APPEARANCE,
  DEFAULT_ICONS,
  DEFAULT_TYPOGRAPHY,
  TYPOGRAPHY_PRESETS,
  applyAppearance,
  customAccentError,
  loadAppearance,
  resolveTheme,
  saveAppearance,
  type AccentPreset,
  type AppearanceSettings,
  type ResolvedTheme,
  type ThemeMode,
  type TypographyPreset,
  type TypographyTitleScope,
} from "./appearance";
import { AdvancedSection } from "./components/AdvancedSection";
import { ToastRegion, type ToastMessage } from "./components/ToastRegion";
import { Select } from "./components/Select";
import { Tooltip } from "./components/Tooltip";
import { MetadataRow } from "./components/MetadataRow";
import { formatFrameRate, formatMediaDuration, formatMetadataBytes, normalizeCodec } from "./media-format";
import { applyCustomTypography, builtinTypographyResult, loadPreviewFont, releasePreviewFont, type AppliedTypographyResult } from "./font-loader";
import { createSemanticIcon, SemanticIcon, SemanticIconProvider } from "./components/SemanticIcon";
import { SEMANTIC_ICON_LABELS, SEMANTIC_ICON_NAMES, type SemanticIconName } from "../../shared/appearance-icons";
import { loadIconOverride, loadIconOverrides, releaseIconOverride, type RendererIconOverride } from "./icon-loader";
import { CacheControls } from "./components/CacheControls";
import { TypographyPreview } from "./components/TypographyPreview";
import { TaskDock, phaseLabel, translateTaskMessage, type UiTask } from "./components/TaskDock";
import { TrimRange, type SourceFrameRange } from "./components/TrimRange";
import { SourceSampleStrip } from "./components/SourceSampleStrip";
import { SourceSuitabilityPanel } from "./components/SourceSuitabilityPanel";
import { sourceSuitability } from "./source-suitability";
import { resolveEncoderPreference, type EncoderPreference } from "../../shared/encoder-selection";

export { phaseLabel } from "./components/TaskDock";

const AlertCircle = createSemanticIcon("warning");
const BookOpen = createSemanticIcon("editorial");
const Check = createSemanticIcon("confirm");
const CheckCircle2 = createSemanticIcon("success");
const Cpu = createSemanticIcon("cpu");
const Crop = createSemanticIcon("crop");
const Download = createSemanticIcon("download");
const ExternalLink = createSemanticIcon("externalLink", true);
const FileVideo = createSemanticIcon("sourceVideo");
const FolderOpen = createSemanticIcon("openFolder");
const Gauge = createSemanticIcon("performance");
const HardDrive = createSemanticIcon("workDirectory");
const LoaderCircle = createSemanticIcon("loading");
const Maximize2 = createSemanticIcon("contain");
const Monitor = createSemanticIcon("display");
const Moon = createSemanticIcon("themeDark");
const Palette = createSemanticIcon("palette");
const PanelTop = createSemanticIcon("blurBackground");
const Play = createSemanticIcon("play");
const RotateCcw = createSemanticIcon("reset");
const Save = createSemanticIcon("saveOutput");
const ScanLine = createSemanticIcon("diagnostic");
const Sparkles = createSemanticIcon("processedVideo");
const Sun = createSemanticIcon("themeLight");
const Trash2 = createSemanticIcon("delete");
const WandSparkles = createSemanticIcon("appLogo");
const Wrench = createSemanticIcon("tools");
const Settings2 = createSemanticIcon("settings");
const Laptop = createSemanticIcon("themeSystem");
const ImportIcon = createSemanticIcon("importResource");
const TypeIcon = createSemanticIcon("typography");
const X = createSemanticIcon("close");

type ViewMode = "source" | "processed" | "loop" | "diagnostic";
type ResolutionPreset = "display" | "wide-2k" | "qhd" | "uhd" | "custom";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "--:--";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function defaultOutputPath(inputPath: string): string {
  const withoutExtension = inputPath.replace(/\.[^./\\]+$/, "");
  return `${withoutExtension}.wallpaper.mp4`;
}

function inferredWorkDirectory(outputPath: string, selected: string): string {
  if (selected.trim()) return selected.trim();
  const directory = outputPath.replace(/[\\/][^\\/]+$/, "");
  return directory ? `${directory}\\.ai-video-wallpaper-work` : "";
}

function evenDimension(value: number): number {
  const rounded = Math.max(2, Math.min(16_384, Math.round(value || 2)));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function readError(error: unknown): SerializedError {
  const message = error instanceof Error ? error.message : String(error);
  const marker = "WALLPAPER_ERROR:";
  const start = message.indexOf(marker);
  if (start >= 0) {
    try {
      return JSON.parse(message.slice(start + marker.length)) as SerializedError;
    } catch {
      // Fall through to the original message.
    }
  }
  return { code: "E_IO", message };
}

function initialTask(kind: TaskKind, workDirectory = "", outputPath = ""): UiTask {
  return {
    id: "pending",
    kind,
    status: "starting",
    progress: null,
    jobId: null,
    logs: [],
    result: null,
    error: null,
    workDirectory,
    outputPath,
    frameCacheReference: null,
    jobFilesAvailable: false,
    frameCacheAvailable: false,
    jobFilesCleaned: false,
    frameCacheCleaned: false,
  };
}

function dependencyAvailable(entry: DependencyCatalogEntry, report: DoctorReport | null): boolean {
  if (!report) return false;
  if (entry.id === "ffmpeg") {
    return ["ffmpeg", "ffprobe"].every((name) => report.tools.some((tool) => tool.name === name && tool.available));
  }
  return report.tools.some((tool) => tool.name === entry.id && tool.available);
}

function SettingsDialog({
  open,
  tab,
  catalog,
  report,
  installing,
  appearance,
  appliedTypography,
  resolvedTheme,
  fontResources,
  fontBusy,
  iconPacks,
  iconOverrides,
  iconBusy,
  importProgress,
  onClose,
  onTabChange,
  onAppearanceChange,
  onImportFont,
  onDeleteFont,
  onResetTypography,
  onImportIconPack,
  onImportIconOverride,
  onRemoveIconOverride,
  onDeleteIconPack,
  onResetIcons,
  onResetAll,
  onExportIconConfig,
  onCancelImport,
  onInstall,
  onOpenLink,
}: {
  open: boolean;
  tab: "appearance" | "tools";
  catalog: DependencyCatalogEntry[];
  report: DoctorReport | null;
  installing: boolean;
  appearance: AppearanceSettings;
  appliedTypography: AppliedTypographyResult;
  resolvedTheme: ResolvedTheme;
  fontResources: FontResourceMetadata[];
  fontBusy: boolean;
  iconPacks: IconPackMetadata[];
  iconOverrides: IconOverrideMetadata[];
  iconBusy: boolean;
  importProgress: AppearanceImportProgress | null;
  onClose(): void;
  onTabChange(tab: "appearance" | "tools"): void;
  onAppearanceChange(settings: AppearanceSettings): void;
  onImportFont(role: "ui" | "display"): void;
  onDeleteFont(font: FontResourceMetadata): void;
  onResetTypography(): void;
  onImportIconPack(): void;
  onImportIconOverride(name: SemanticIconName): void;
  onRemoveIconOverride(name: SemanticIconName): void;
  onDeleteIconPack(pack: IconPackMetadata): void;
  onResetIcons(): void;
  onResetAll(): void;
  onExportIconConfig(): void;
  onCancelImport(importId: string): void;
  onInstall(ids: DependencyId[]): void;
  onOpenLink(url: string): void;
}): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement>(null);
  const missing = useMemo(() => catalog.filter((entry) => !dependencyAvailable(entry, report)).map((entry) => entry.id), [catalog, report]);
  const [selected, setSelected] = useState<DependencyId[]>([]);
  const [consented, setConsented] = useState(false);
  const [customDraft, setCustomDraft] = useState(appearance.customAccent);
  const [selectedIconName, setSelectedIconName] = useState<SemanticIconName>("settings");
  const fontOptions = [{ value: "system", label: "系统默认字体" }, ...fontResources.map((font) => ({ value: font.id, label: font.familyName }))];
  const iconOptions = [
    { value: "fine-outline", label: "精细线性", icon: <Sparkles aria-hidden="true" /> },
    { value: "soft-outline", label: "柔和线性", icon: <Sparkles aria-hidden="true" /> },
    ...iconPacks.map((pack) => ({ value: pack.id, label: `${pack.name} · ${pack.iconNames.length} 个图标`, icon: <Sparkles aria-hidden="true" /> })),
  ];

  useEffect(() => {
    if (open) {
      setSelected(missing);
      setConsented(false);
      setCustomDraft(appearance.customAccent);
    }
  }, [open, missing.join(","), appearance.customAccent]);

  useEffect(() => {
    if (!open || installing) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
      if (dialogs.item(dialogs.length - 1) === dialogRef.current) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [installing, onClose, open]);

  if (!open) return null;
  const selectedEntries = catalog.filter((entry) => selected.includes(entry.id));
  const canInstall = selectedEntries.length > 0 && selectedEntries.every((entry) => entry.installable) && consented && !installing;
  return (
    <div className="modal-backdrop" role="presentation">
      <section ref={dialogRef} className="dependency-dialog settings-dialog" role="dialog" aria-modal="true" aria-label={tab === "tools" ? "处理工具" : "外观设置"}>
        <header className="dialog-header">
          <div>
            <h2 id="settings-title" className="display-title">设置</h2>
            <p>{tab === "appearance" ? "调整界面外观，不会中断正在运行的任务。" : "管理视频处理所需的本地工具。"}</p>
          </div>
          <Tooltip content="关闭">
            <button className="icon-button" type="button" aria-label="关闭" onClick={onClose} disabled={installing}>
              <X aria-hidden="true" />
            </button>
          </Tooltip>
        </header>
        <div className="settings-tabs" role="tablist" aria-label="设置分类">
          <button type="button" role="tab" aria-selected={tab === "appearance"} className={tab === "appearance" ? "is-selected" : ""} onClick={() => onTabChange("appearance")}><Palette aria-hidden="true" />外观</button>
          <button type="button" role="tab" aria-selected={tab === "tools"} className={tab === "tools" ? "is-selected" : ""} onClick={() => onTabChange("tools")}><Wrench aria-hidden="true" />处理工具</button>
        </div>
        {tab === "appearance" ? (
          <div className="appearance-panel" role="tabpanel">
            <section className="appearance-group">
              <div><strong>外观模式</strong><span>跟随系统时会实时响应 Windows 颜色模式。</span></div>
              <div className="appearance-mode" role="group" aria-label="外观模式">
                {([
                  ["system", "跟随系统", Laptop],
                  ["light", "浅色", Sun],
                  ["dark", "深色", Moon],
                ] as const).map(([value, label, Icon]) => (
                  <button key={value} type="button" className={appearance.themeMode === value ? "is-selected" : ""} aria-pressed={appearance.themeMode === value} onClick={() => onAppearanceChange({ ...appearance, themeMode: value as ThemeMode })}>
                    <Icon aria-hidden="true" /><span>{label}</span>{appearance.themeMode === value && <Check aria-hidden="true" />}
                  </button>
                ))}
              </div>
            </section>
            <section className="appearance-group">
              <div><strong>强调色</strong><span>应用于主操作、选中状态和键盘焦点。</span></div>
              <div className="accent-swatches" role="group" aria-label="强调色">
                {(Object.entries(ACCENT_PRESETS) as Array<[Exclude<AccentPreset, "custom">, (typeof ACCENT_PRESETS)[Exclude<AccentPreset, "custom">]]>).map(([value, preset]) => (
                  <button key={value} type="button" className={appearance.accent === value ? "is-selected" : ""} aria-label={preset.label} aria-pressed={appearance.accent === value} onClick={() => onAppearanceChange({ ...appearance, accent: value })}>
                    <span style={{ backgroundColor: preset[resolvedTheme] }} />{appearance.accent === value && <Check aria-hidden="true" />}
                  </button>
                ))}
                <button type="button" className={`custom-swatch ${appearance.accent === "custom" ? "is-selected" : ""}`} aria-label="自定义颜色" aria-pressed={appearance.accent === "custom"} onClick={() => {
                  if (!customAccentError(customDraft, resolvedTheme)) onAppearanceChange({ ...appearance, accent: "custom", customAccent: customDraft.toLowerCase() });
                }}>
                  <Palette aria-hidden="true" />{appearance.accent === "custom" && <Check aria-hidden="true" />}
                </button>
              </div>
              <label className="custom-color-field" htmlFor="custom-accent">自定义 HEX
                <div><input id="custom-accent" value={customDraft} maxLength={7} spellCheck={false} onChange={(event) => setCustomDraft(event.target.value)} onBlur={() => {
                  if (!customAccentError(customDraft, resolvedTheme)) onAppearanceChange({ ...appearance, accent: "custom", customAccent: customDraft.toLowerCase() });
                }} /><span style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(customDraft) ? customDraft : appearance.customAccent }} /></div>
              </label>
              {customAccentError(customDraft, resolvedTheme) && <p className="appearance-error" role="alert">{customAccentError(customDraft, resolvedTheme)}</p>}
            </section>
            <section className="appearance-group typography-settings">
              <div><strong className="major-section-title">排版</strong><span>选择字体气质，不改变控件尺寸和处理参数。</span></div>
              <label className="appearance-field-label" htmlFor="typography-preset">排版风格</label>
              <Select<TypographyPreset>
                id="typography-preset"
                ariaLabel="排版风格"
                value={appearance.typography.preset}
                options={[
                  ...Object.entries(TYPOGRAPHY_PRESETS).map(([value, preset]) => ({ value: value as Exclude<TypographyPreset, "custom">, label: preset.label, icon: value === "warm-editorial" ? <BookOpen aria-hidden="true" /> : <TypeIcon aria-hidden="true" /> })),
                  { value: "custom", label: "自定义", icon: <TypeIcon aria-hidden="true" /> },
                ]}
                onChange={(preset) => onAppearanceChange({ ...appearance, typography: { ...appearance.typography, preset } })}
              />
              <TypographyPreview
                titleScope={appearance.typography.titleScope}
                uiFamilies={appliedTypography.uiFamilies}
                displayFamilies={appliedTypography.displayFamilies}
              />
              <AdvancedSection label="高级排版">
                <label className="appearance-field-label" htmlFor="typography-title-scope">标题排版范围</label>
                <Select<TypographyTitleScope>
                  id="typography-title-scope"
                  ariaLabel="标题排版范围"
                  value={appearance.typography.titleScope}
                  options={[
                    { value: "product-only", label: "仅产品标题" },
                    { value: "product-and-major", label: "产品标题与主要章节" },
                    { value: "all-titles", label: "所有标题" },
                  ]}
                  onChange={(titleScope) => onAppearanceChange({ ...appearance, typography: { ...appearance.typography, titleScope } })}
                />
              </AdvancedSection>
              <div className={`custom-typography-reveal${appearance.typography.preset === "custom" ? " is-open" : ""}`} aria-hidden={appearance.typography.preset !== "custom"} inert={appearance.typography.preset !== "custom"}>
                <div>
                  <label className="appearance-field-label" htmlFor="custom-ui-font">界面字体</label>
                  <div className="font-field-row">
                    <Select<string>
                      id="custom-ui-font"
                      ariaLabel="界面字体"
                      value={appearance.typography.uiFontId ?? "system"}
                      options={fontOptions}
                      onChange={(value) => onAppearanceChange({ ...appearance, typography: { ...appearance.typography, preset: "custom", uiFontId: value === "system" ? null : value } })}
                    />
                    <button className="button secondary" type="button" disabled={fontBusy && importProgress?.kind !== "font"} onClick={() => importProgress?.kind === "font" ? onCancelImport(importProgress.importId) : onImportFont("ui")}>{importProgress?.kind === "font" ? <X aria-hidden="true" /> : <ImportIcon aria-hidden="true" />}{importProgress?.kind === "font" ? "取消" : "导入"}</button>
                  </div>
                  <label className="appearance-field-label" htmlFor="custom-display-font">展示字体</label>
                  <div className="font-field-row">
                    <Select<string>
                      id="custom-display-font"
                      ariaLabel="展示字体"
                      value={appearance.typography.displayFontId ?? "system"}
                      options={fontOptions}
                      onChange={(value) => onAppearanceChange({ ...appearance, typography: { ...appearance.typography, preset: "custom", displayFontId: value === "system" ? null : value } })}
                    />
                    <button className="button secondary" type="button" disabled={fontBusy && importProgress?.kind !== "font"} onClick={() => importProgress?.kind === "font" ? onCancelImport(importProgress.importId) : onImportFont("display")}>{importProgress?.kind === "font" ? <X aria-hidden="true" /> : <ImportIcon aria-hidden="true" />}{importProgress?.kind === "font" ? "取消" : "导入"}</button>
                  </div>
                  {fontResources.length > 0 && <div className="font-resource-list" aria-label="已导入字体">
                    {fontResources.map((font) => <div className="font-resource-row" key={font.id}>
                      <Tooltip content={font.fullName}><span tabIndex={0}>{font.familyName}<small>{font.format.toUpperCase()} · {formatBytes(font.sizeBytes)}</small></span></Tooltip>
                      <Tooltip content="删除字体"><button className="icon-button" type="button" aria-label={`删除字体 ${font.familyName}`} onClick={() => onDeleteFont(font)}><Trash2 aria-hidden="true" /></button></Tooltip>
                    </div>)}
                  </div>}
                </div>
              </div>
              <button className="button ghost appearance-reset" type="button" onClick={onResetTypography}><RotateCcw aria-hidden="true" />恢复默认排版</button>
            </section>
            <section className="appearance-group icon-settings">
              <div><strong className="major-section-title">图标</strong><span>使用一致的语义图标，切换时不改变控件尺寸。</span></div>
              <label className="appearance-field-label" htmlFor="icon-preset">图标风格</label>
              <Select<string>
                id="icon-preset"
                ariaLabel="图标风格"
                value={appearance.icons.preset === "custom" && appearance.icons.packId ? appearance.icons.packId : appearance.icons.preset === "soft-outline" ? "soft-outline" : "fine-outline"}
                options={iconOptions}
                onChange={(value) => onAppearanceChange({
                  ...appearance,
                  icons: value === "fine-outline" || value === "soft-outline"
                    ? { ...appearance.icons, preset: value, packId: null }
                    : { ...appearance.icons, preset: "custom", packId: value },
                })}
              />
              <button className="button secondary icon-pack-import" type="button" disabled={iconBusy && importProgress?.kind !== "icon-pack"} onClick={() => importProgress?.kind === "icon-pack" ? onCancelImport(importProgress.importId) : onImportIconPack()}>
                {importProgress?.kind === "icon-pack" ? <X aria-hidden="true" /> : iconBusy ? <LoaderCircle className="spin" aria-hidden="true" /> : <ImportIcon aria-hidden="true" />}{importProgress?.kind === "icon-pack" ? "取消导入" : iconBusy ? "正在检查" : "导入图标包"}
              </button>
              {importProgress && <div className="appearance-import-progress" role="status"><span>{importProgress.message}</span><strong>{Math.round(importProgress.percent)}%</strong><i style={{ width: `${importProgress.percent}%` }} /></div>}
              {iconPacks.length > 0 && <div className="icon-resource-list" aria-label="已导入图标包">
                {iconPacks.map((pack) => <div className="icon-resource-row" key={pack.id}>
                  <span>{pack.name}<small>v{pack.version} · {pack.iconNames.length} 个图标</small></span>
                  <Tooltip content="删除图标包"><button className="icon-button" type="button" aria-label={`删除图标包 ${pack.name}`} onClick={() => onDeleteIconPack(pack)}><Trash2 aria-hidden="true" /></button></Tooltip>
                </div>)}
              </div>}
              <div className="icon-style-preview" aria-label="图标风格预览">
                <Settings2 aria-hidden="true" />
                <FileVideo aria-hidden="true" />
                <Sparkles aria-hidden="true" />
                <CheckCircle2 aria-hidden="true" />
                <AlertCircle aria-hidden="true" />
              </div>
              <AdvancedSection label="单图标覆盖">
                <label className="appearance-field-label" htmlFor="semantic-icon-name">语义图标</label>
                <div className="icon-override-picker">
                  <Select<SemanticIconName>
                    id="semantic-icon-name"
                    ariaLabel="要替换的语义图标"
                    value={selectedIconName}
                    options={SEMANTIC_ICON_NAMES.map((name) => ({ value: name, label: SEMANTIC_ICON_LABELS[name], icon: <SemanticIcon name={name} aria-hidden="true" /> }))}
                    onChange={setSelectedIconName}
                  />
                  <button className="button secondary" type="button" disabled={iconBusy && importProgress?.kind !== "icon-override"} onClick={() => importProgress?.kind === "icon-override" ? onCancelImport(importProgress.importId) : onImportIconOverride(selectedIconName)}>{importProgress?.kind === "icon-override" ? <X aria-hidden="true" /> : <ImportIcon aria-hidden="true" />}{importProgress?.kind === "icon-override" ? "取消" : "替换"}</button>
                </div>
                {(Object.entries(appearance.icons.overrides) as Array<[SemanticIconName, string]>).length > 0 && <div className="icon-resource-list" aria-label="单图标覆盖列表">
                  {(Object.entries(appearance.icons.overrides) as Array<[SemanticIconName, string]>).map(([name, id]) => {
                    const resource = iconOverrides.find((entry) => entry.id === id);
                    return <div className="icon-resource-row" key={name}><span><SemanticIcon name={name} aria-hidden="true" />{SEMANTIC_ICON_LABELS[name]}<small>{resource?.kind === "png" ? "PNG" : "SVG"}</small></span><Tooltip content="恢复此图标"><button className="icon-button" type="button" aria-label={`恢复图标 ${SEMANTIC_ICON_LABELS[name]}`} onClick={() => onRemoveIconOverride(name)}><RotateCcw aria-hidden="true" /></button></Tooltip></div>;
                  })}
                </div>}
              </AdvancedSection>
              <div className="appearance-management-actions">
                <button className="button ghost" type="button" onClick={onExportIconConfig}><Save aria-hidden="true" />导出图标配置</button>
                <button className="button ghost" type="button" onClick={onResetIcons}><RotateCcw aria-hidden="true" />恢复图标</button>
                <button className="button ghost" type="button" onClick={onResetAll}><RotateCcw aria-hidden="true" />恢复全部外观</button>
              </div>
            </section>
          </div>
        ) : <div className="tools-panel" role="tabpanel">
        <div className="dependency-list">
          {catalog.map((entry) => {
            const available = dependencyAvailable(entry, report);
            return (
              <div className="dependency-row" key={entry.id}>
                <label className="dependency-check">
                  <input
                    type="checkbox"
                    checked={selected.includes(entry.id)}
                    disabled={available || installing}
                    onChange={(event) => setSelected((current) => event.target.checked
                      ? [...current, entry.id]
                      : current.filter((id) => id !== entry.id))}
                  />
                  <span className={available ? "status-dot available" : "status-dot missing"} />
                </label>
                <div className="dependency-copy">
                  <strong>{entry.displayName}</strong>
                  <span>v{entry.version} · {formatBytes(entry.approximateSizeBytes)} · {entry.license}</span>
                  <div className="link-row">
                    <button type="button" className="text-link" onClick={() => onOpenLink(entry.sourcePage)}>
                      来源 <ExternalLink aria-hidden="true" />
                    </button>
                    <button type="button" className="text-link" onClick={() => onOpenLink(entry.licenseUrl)}>
                      许可证 <ExternalLink aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <span className={available ? "tool-state is-ready" : "tool-state"}>{available ? "已就绪" : "缺失"}</span>
              </div>
            );
          })}
        </div>
        {!catalog.every((entry) => entry.installable) && (
          <div className="inline-warning">
            <AlertCircle aria-hidden="true" />
            当前开发包未附带固定校验清单，缺少清单的工具不会下载。
          </div>
        )}
        <label className="consent-row">
          <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} disabled={installing} />
          <span>我已核对来源、版本、体积和许可证，并同意下载所选工具。</span>
        </label>
        <footer className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={installing}>取消</button>
          <button className="button primary" type="button" onClick={() => onInstall(selected)} disabled={!canInstall}>
            {installing ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
            {installing ? "正在安装" : "确认下载"}
          </button>
        </footer>
        </div>}
      </section>
    </div>
  );
}

interface ActiveFontPreview {
  role: "ui" | "display";
  preview: FontImportPreview;
  family: string;
}

function FontImportDialog({ value, busy, onCancel, onConfirm }: {
  value: ActiveFontPreview | null;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}): React.JSX.Element | null {
  if (!value) return null;
  const style = { fontFamily: `"${value.family}", var(--font-ui-standard)` };
  return <div className="modal-backdrop resource-preview-backdrop" role="presentation">
    <section className="dependency-dialog font-import-dialog" role="dialog" aria-modal="true" aria-label="字体导入预览">
      <header className="dialog-header"><div><h2>字体导入预览</h2><p>{value.preview.fullName}</p></div></header>
      <div className="font-import-content">
        <div className="font-preview-size font-preview-body" style={style}><span>14px 正文</span>视频处理 · 清晰度 · 输出 · 缓存 · The quick brown fox · 0123456789</div>
        <div className="font-preview-size font-preview-section" style={style}><span>16px 分组标题</span>清晰度与循环 · 输出与编码</div>
        <div className="font-preview-size font-preview-display" style={style}><span>20px 展示标题</span>AI 视频壁纸处理器</div>
        <dl className="font-preview-meta"><div><dt>格式</dt><dd>{value.preview.format.toUpperCase()}</dd></div><div><dt>大小</dt><dd>{formatBytes(value.preview.sizeBytes)}</dd></div><div><dt>应用位置</dt><dd>{value.role === "ui" ? "界面字体" : "展示字体"}</dd></div></dl>
        {value.preview.warnings.map((warning) => <div className="inline-warning" key={warning}><AlertCircle aria-hidden="true" />{warning}</div>)}
      </div>
      <footer className="dialog-actions"><button className="button secondary" type="button" disabled={busy} onClick={onCancel}>取消</button><button className="button primary" type="button" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}{busy ? "正在导入" : "确认并应用"}</button></footer>
    </section>
  </div>;
}

function FontDeleteDialog({ font, active, busy, onCancel, onConfirm }: {
  font: FontResourceMetadata | null;
  active: boolean;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}): React.JSX.Element | null {
  if (!font) return null;
  return <div className="modal-backdrop resource-preview-backdrop" role="presentation">
    <section className="dependency-dialog confirm-dialog" role="dialog" aria-modal="true" aria-label="删除字体">
      <header className="dialog-header"><div><h2>删除“{font.familyName}”</h2><p>{active ? "该字体正在使用，删除后会自动恢复对应的默认字体。" : "字体文件将从本机资源目录删除。"}</p></div></header>
      <footer className="dialog-actions"><button className="button secondary" type="button" disabled={busy} onClick={onCancel}>取消</button><button className="button danger" type="button" disabled={busy} onClick={onConfirm}><Trash2 aria-hidden="true" />删除字体</button></footer>
    </section>
  </div>;
}

function IconPackImportDialog({ value, busy, onCancel, onConfirm }: {
  value: IconPackImportPreview | null;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}): React.JSX.Element | null {
  if (!value) return null;
  const names = value.iconNames.slice(0, 10);
  return <div className="modal-backdrop resource-preview-backdrop" role="presentation">
    <section className="dependency-dialog icon-pack-dialog" role="dialog" aria-modal="true" aria-label="图标包导入预览">
      <header className="dialog-header"><div><h2>{value.name}</h2><p>v{value.version} · {value.iconNames.length} 个语义图标 · 默认 {value.defaultSize}px</p></div></header>
      <div className="icon-pack-preview-content">
        <SemanticIconProvider preset="custom" pack={value.pack}>
          <div className="icon-pack-preview-grid">
            <div className="icon-preview-surface is-light"><span>浅色 · 18px</span><div>{names.map((name) => <SemanticIcon key={name} name={name} width={18} height={18} aria-hidden="true" />)}</div></div>
            <div className="icon-preview-surface is-dark"><span>深色 · 20px</span><div>{names.map((name) => <SemanticIcon key={name} name={name} width={20} height={20} aria-hidden="true" />)}</div></div>
          </div>
          <div className="icon-state-preview" aria-label="常见图标状态">
            <span><SemanticIcon name="settings" aria-hidden="true" />普通</span>
            <span className="is-accent"><SemanticIcon name="confirm" aria-hidden="true" />选中</span>
            <span className="is-muted"><SemanticIcon name="loading" aria-hidden="true" />禁用</span>
          </div>
        </SemanticIconProvider>
        {value.warnings.length > 0 && <div className="icon-pack-warnings">{value.warnings.map((warning) => <div className="inline-warning" key={warning}><AlertCircle aria-hidden="true" />{warning}</div>)}</div>}
      </div>
      <footer className="dialog-actions"><button className="button secondary" type="button" disabled={busy} onClick={onCancel}>取消</button><button className="button primary" type="button" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}{busy ? "正在保存" : "确认并应用"}</button></footer>
    </section>
  </div>;
}

function IconOverrideGraphic({ value, size }: { value: IconOverrideImportPreview; size: number }): React.JSX.Element | null {
  const [pngUrl, setPngUrl] = useState<string | null>(null);
  useEffect(() => {
    if (value.kind !== "png") { setPngUrl(null); return; }
    const url = URL.createObjectURL(new Blob([new Uint8Array(value.previewData).slice()], { type: "image/png" }));
    setPngUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);
  if (value.kind === "png") return pngUrl ? <img className="semantic-icon-image" src={pngUrl} width={size} height={size} alt="" /> : null;
  const pack: SanitizedIconPack = { schemaVersion: 1, name: "Override Preview", version: "1", defaultSize: size, icons: { [value.semanticName]: value.icon }, warnings: value.warnings };
  return <SemanticIconProvider preset="custom" pack={pack}><SemanticIcon name={value.semanticName} width={size} height={size} aria-hidden="true" /></SemanticIconProvider>;
}

function IconOverrideImportDialog({ value, busy, onCancel, onConfirm }: {
  value: IconOverrideImportPreview | null;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}): React.JSX.Element | null {
  if (!value) return null;
  return <div className="modal-backdrop resource-preview-backdrop" role="presentation">
    <section className="dependency-dialog icon-override-dialog" role="dialog" aria-modal="true" aria-label="单图标替换预览">
      <header className="dialog-header"><div><h2>{SEMANTIC_ICON_LABELS[value.semanticName]}</h2><p>{value.kind === "png" ? `PNG · ${value.width} × ${value.height}` : "已清理 SVG"} · {formatBytes(value.sizeBytes)}</p></div></header>
      <div className="icon-override-preview-grid">
        <div className="icon-preview-surface is-light"><span>浅色 · 18px</span><IconOverrideGraphic value={value} size={18} /></div>
        <div className="icon-preview-surface is-dark"><span>深色 · 20px</span><IconOverrideGraphic value={value} size={20} /></div>
      </div>
      {value.warnings.length > 0 && <div className="icon-pack-warnings">{value.warnings.map((warning) => <div className="inline-warning" key={warning}><AlertCircle aria-hidden="true" />{warning}</div>)}</div>}
      <footer className="dialog-actions"><button className="button secondary" type="button" disabled={busy} onClick={onCancel}>取消</button><button className="button primary" type="button" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}{busy ? "正在保存" : "确认替换"}</button></footer>
    </section>
  </div>;
}

function IconPackDeleteDialog({ pack, active, busy, onCancel, onConfirm }: { pack: IconPackMetadata | null; active: boolean; busy: boolean; onCancel(): void; onConfirm(): void }): React.JSX.Element | null {
  if (!pack) return null;
  return <div className="modal-backdrop resource-preview-backdrop" role="presentation"><section className="dependency-dialog confirm-dialog" role="dialog" aria-modal="true" aria-label="删除图标包"><header className="dialog-header"><div><h2>删除“{pack.name}”</h2><p>{active ? "该图标包正在使用，删除后将自动恢复精细线性图标，单图标覆盖不受影响。" : "已清理的图标包资源将从本机删除。"}</p></div></header><footer className="dialog-actions"><button className="button secondary" type="button" disabled={busy} onClick={onCancel}>取消</button><button className="button danger" type="button" disabled={busy} onClick={onConfirm}><Trash2 aria-hidden="true" />删除图标包</button></footer></section></div>;
}

export default function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<DesktopBootstrap | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [doctorError, setDoctorError] = useState<SerializedError | null>(null);
  const [inputPath, setInputPath] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [workDirectory, setWorkDirectory] = useState("");
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [diagnosticResult, setDiagnosticResult] = useState<DiagnosticPreviewResult | null>(null);
  const [diagnosticUrls, setDiagnosticUrls] = useState<Record<string, string>>({});
  const [loopPreviewResult, setLoopPreviewResult] = useState<LoopPreviewResult | null>(null);
  const [loopPreviewUrls, setLoopPreviewUrls] = useState<Record<string, string>>({});
  const [selectedLoopPreview, setSelectedLoopPreview] = useState<LoopPreviewVariantId>("pingpong-end");
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("source");
  const [resolutionPreset, setResolutionPreset] = useState<ResolutionPreset>("display");
  const [target, setTarget] = useState({ width: 2560, height: 1600 });
  const [aspectMode, setAspectMode] = useState<AspectMode>(DEFAULT_UI_SETTINGS.aspectMode);
  const [focus, setFocus] = useState<FocusPoint>({ x: 0.5, y: 0.5 });
  const [upscaleMode, setUpscaleMode] = useState<UpscaleMode>("realesrgan");
  const [model, setModel] = useState<LegacyUpscaleModel>("realesr-animevideov3");
  const [gpuId, setGpuId] = useState<GpuId>(DEFAULT_UI_SETTINGS.gpuId);
  const [aiScale, setAiScale] = useState<AiScaleSetting>(DEFAULT_UI_SETTINGS.aiScale);
  const [encoderPreference, setEncoderPreference] = useState<EncoderPreference>(DEFAULT_UI_SETTINGS.encoder);
  const [interpolationMode, setInterpolationMode] = useState<InterpolationSpec["mode"]>(DEFAULT_UI_SETTINGS.interpolation.mode);
  const interpolationEnabled = interpolationMode === "rife";
  const [loopMode, setLoopMode] = useState<"pingpong" | "none">("pingpong");
  const [sourceRange, setSourceRange] = useState<SourceFrameRange>({ startFrame: 0, endFrameExclusive: 1 });
  const [currentSourceFrame, setCurrentSourceFrame] = useState(0);
  const [seekRequest, setSeekRequest] = useState<{ seconds: number; id: number } | null>(null);
  const [lastPreviewMode, setLastPreviewMode] = useState<"segment" | "loop-boundary">("segment");
  const [previewCenter, setPreviewCenter] = useState(15);
  const [task, setTask] = useState<UiTask | null>(null);
  const [pageError, setPageError] = useState<SerializedError | null>(null);
  const [dependencyOpen, setDependencyOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState<"job" | "frame-cache" | null>(null);
  const [cachePolicy, setCachePolicy] = useState<CachePolicy>("cleanup-on-success");
  const [cacheLimitGiB, setCacheLimitGiB] = useState(50);
  const [cacheOverview, setCacheOverview] = useState<CacheOverview | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [lastReleasedBytes, setLastReleasedBytes] = useState(0);
  const [appearance, setAppearance] = useState<AppearanceSettings>(() => loadAppearance());
  const [appliedTypography, setAppliedTypography] = useState<AppliedTypographyResult>(() => builtinTypographyResult(appearance.typography.preset));
  const [appearanceResources, setAppearanceResources] = useState<AppearanceResourceCatalog>({ fonts: [], iconPacks: [], iconOverrides: [] });
  const [appearanceResourcesLoaded, setAppearanceResourcesLoaded] = useState(false);
  const [fontBusy, setFontBusy] = useState(false);
  const [fontPreview, setFontPreview] = useState<ActiveFontPreview | null>(null);
  const [fontDeleteCandidate, setFontDeleteCandidate] = useState<FontResourceMetadata | null>(null);
  const [iconBusy, setIconBusy] = useState(false);
  const [iconPackPreview, setIconPackPreview] = useState<IconPackImportPreview | null>(null);
  const [activeIconPack, setActiveIconPack] = useState<SanitizedIconPack | null>(null);
  const [iconOverridePreview, setIconOverridePreview] = useState<IconOverrideImportPreview | null>(null);
  const [activeIconOverrides, setActiveIconOverrides] = useState<Partial<Record<SemanticIconName, RendererIconOverride>>>({});
  const [iconPackDeleteCandidate, setIconPackDeleteCandidate] = useState<IconPackMetadata | null>(null);
  const [appearanceImportProgress, setAppearanceImportProgress] = useState<AppearanceImportProgress | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(loadAppearance().themeMode, window.matchMedia("(prefers-color-scheme: dark)").matches));
  const [settingsTab, setSettingsTab] = useState<"appearance" | "tools">("appearance");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const taskJobIds = useRef(new Map<string, string>());
  const toastTimers = useRef(new Map<string, number>());
  const logDetailsRef = useRef<HTMLDetailsElement>(null);
  const inputLoadGeneration = useRef(0);
  const cacheLimitBytes = Math.round(cacheLimitGiB * 1024 ** 3);
  const activeWorkDirectory = inferredWorkDirectory(outputPath, workDirectory);

  const dismissToast = useCallback((id: string): void => {
    const timer = toastTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    toastTimers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((toast: Omit<ToastMessage, "id">): void => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => {
      const filtered = toast.dedupeKey ? current.filter((item) => item.dedupeKey !== toast.dedupeKey) : current;
      return [...filtered.slice(-2), { ...toast, id }];
    });
    const duration = toast.kind === "error" ? 6_000 : 3_200;
    toastTimers.current.set(id, window.setTimeout(() => dismissToast(id), duration));
  }, [dismissToast]);

  useEffect(() => () => {
    for (const timer of toastTimers.current.values()) window.clearTimeout(timer);
  }, []);

  useEffect(() => window.wallpaperApi.onAppearanceImportProgress((progress) => setAppearanceImportProgress(progress)), []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => setResolvedTheme(applyAppearance(appearance, media.matches));
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [appearance]);

  const updateAppearance = useCallback((next: AppearanceSettings): void => {
    setAppearance(next);
    saveAppearance(next);
    setResolvedTheme(applyAppearance(next));
    pushToast({ kind: "success", title: "外观已更新", dedupeKey: "appearance" });
  }, [pushToast]);

  const refreshAppearanceResources = useCallback(async (): Promise<AppearanceResourceCatalog> => {
    const resources = await window.wallpaperApi.getAppearanceResources();
    setAppearanceResources(resources);
    setAppearanceResourcesLoaded(true);
    return resources;
  }, []);

  useEffect(() => {
    void refreshAppearanceResources().catch((error) => {
      setAppearanceResourcesLoaded(true);
      pushToast({ kind: "error", title: "外观资源读取失败", message: readError(error).message, dedupeKey: "appearance-resources" });
    });
  }, [pushToast, refreshAppearanceResources]);

  useEffect(() => {
    if (!appearanceResourcesLoaded) return;
    let active = true;
    const availableFonts = new Set(appearanceResources.fonts.map((font) => font.id));
    const availableIconPacks = new Set(appearanceResources.iconPacks.map((pack) => pack.id));
    const missingUi = appearance.typography.uiFontId && !availableFonts.has(appearance.typography.uiFontId);
    const missingDisplay = appearance.typography.displayFontId && !availableFonts.has(appearance.typography.displayFontId);
    const missingIconPack = appearance.icons.packId && !availableIconPacks.has(appearance.icons.packId);
    const missingOverrides = Object.entries(appearance.icons.overrides).filter(([name, id]) =>
      !appearanceResources.iconOverrides.some((icon) => icon.id === id && icon.semanticName === name),
    ).map(([name]) => name as SemanticIconName);
    if (missingUi || missingDisplay || missingIconPack || missingOverrides.length > 0) {
      const validOverrides = Object.fromEntries(Object.entries(appearance.icons.overrides).filter(([name]) => !missingOverrides.includes(name as SemanticIconName)));
      const next = {
        ...appearance,
        typography: { ...appearance.typography, uiFontId: missingUi ? null : appearance.typography.uiFontId, displayFontId: missingDisplay ? null : appearance.typography.displayFontId },
        icons: { ...(missingIconPack ? { ...appearance.icons, preset: "fine-outline" as const, packId: null } : appearance.icons), overrides: validOverrides },
      };
      updateAppearance(next);
      pushToast({ kind: "warning", title: "外观资源已回退", message: missingIconPack ? "保存的图标包不存在，已恢复精细线性图标。" : missingOverrides.length > 0 ? "部分单图标资源不存在，已使用当前图标风格回退。" : "保存的字体资源不存在，已恢复默认字体。", dedupeKey: "appearance-fallback" });
      return;
    }
    void applyCustomTypography(appearance, appearanceResources).then((result) => {
      if (!active) return;
      setAppliedTypography(result);
      if (result.warnings.length > 0) pushToast({ kind: "warning", title: "部分字体未能加载", message: result.warnings.join("；"), dedupeKey: "font-load" });
    });
    return () => { active = false; };
  }, [appearance, appearanceResources, appearanceResourcesLoaded, pushToast, updateAppearance]);

  useEffect(() => {
    let active = true;
    if (appearance.icons.preset !== "custom" || !appearance.icons.packId) {
      setActiveIconPack(null);
      return () => { active = false; };
    }
    void window.wallpaperApi.readIconPackResource(appearance.icons.packId).then((pack) => {
      if (active) setActiveIconPack(pack);
    }).catch((error) => {
      if (!active) return;
      setActiveIconPack(null);
      updateAppearance({ ...appearance, icons: { ...appearance.icons, preset: "fine-outline", packId: null } });
      const parsed = readError(error);
      pushToast({ kind: "error", title: "图标包加载失败", message: parsed.message, copyText: formatSerializedError(parsed), showLogs: true, dedupeKey: "icon-pack-load" });
    });
    return () => { active = false; };
  }, [appearance.icons.packId, appearance.icons.preset]);

  useEffect(() => {
    let active = true;
    void loadIconOverrides(appearance.icons.overrides, appearanceResources.iconOverrides).then((result) => {
      if (!active) return;
      setActiveIconOverrides(result.overrides);
      if (result.failed.length > 0) pushToast({ kind: "warning", title: "部分图标覆盖加载失败", message: result.failed.map((name) => SEMANTIC_ICON_LABELS[name]).join("、"), dedupeKey: "icon-override-load" });
    });
    return () => { active = false; };
  }, [appearance.icons.overrides, appearanceResources.iconOverrides, pushToast]);

  const previewFontImport = async (role: "ui" | "display"): Promise<void> => {
    setFontBusy(true);
    try {
      const preview = await window.wallpaperApi.previewFontImport();
      if (!preview) return;
      const family = await loadPreviewFont(preview);
      setFontPreview({ role, preview, family });
    } catch (error) {
      const parsed = readError(error);
      if (parsed.code !== "E_IMPORT_CANCELLED") pushToast({ kind: "error", title: "字体导入失败", message: parsed.message, copyText: formatSerializedError(parsed), showLogs: true, dedupeKey: "font-import" });
    } finally {
      setFontBusy(false);
      setAppearanceImportProgress(null);
    }
  };

  const commitFontImport = async (): Promise<void> => {
    if (!fontPreview) return;
    setFontBusy(true);
    try {
      const resource = await window.wallpaperApi.commitFontImport(fontPreview.preview.importId);
      const resources = await refreshAppearanceResources();
      const typography = { ...appearance.typography, preset: "custom" as const, [fontPreview.role === "ui" ? "uiFontId" : "displayFontId"]: resource.id };
      const next = { ...appearance, typography };
      setAppliedTypography(await applyCustomTypography(next, resources));
      updateAppearance(next);
      pushToast({ kind: "success", title: "字体已导入并应用", message: resource.familyName, dedupeKey: "font-import" });
      releasePreviewFont(fontPreview.preview.importId);
      setFontPreview(null);
    } catch (error) {
      const parsed = readError(error);
      pushToast({ kind: "error", title: "字体导入失败", message: parsed.message, copyText: formatSerializedError(parsed), showLogs: true, dedupeKey: "font-import" });
    } finally {
      setFontBusy(false);
    }
  };

  const deleteFontResource = async (): Promise<void> => {
    if (!fontDeleteCandidate) return;
    setFontBusy(true);
    try {
      await window.wallpaperApi.deleteFontResource(fontDeleteCandidate.id);
      const typography = {
        ...appearance.typography,
        uiFontId: appearance.typography.uiFontId === fontDeleteCandidate.id ? null : appearance.typography.uiFontId,
        displayFontId: appearance.typography.displayFontId === fontDeleteCandidate.id ? null : appearance.typography.displayFontId,
      };
      updateAppearance({ ...appearance, typography });
      await refreshAppearanceResources();
      pushToast({ kind: "success", title: "字体已删除", message: fontDeleteCandidate.familyName, dedupeKey: "font-delete" });
      setFontDeleteCandidate(null);
    } catch (error) {
      const parsed = readError(error);
      pushToast({ kind: "error", title: "字体删除失败", message: parsed.message, copyText: formatSerializedError(parsed), showLogs: true, dedupeKey: "font-delete" });
    } finally {
      setFontBusy(false);
    }
  };

  const previewIconPackImport = async (): Promise<void> => {
    setIconBusy(true);
    try {
      const preview = await window.wallpaperApi.previewIconPackImport();
      if (preview) setIconPackPreview(preview);
    } catch (error) {
      const parsed = readError(error);
      if (parsed.code !== "E_IMPORT_CANCELLED") pushToast({ kind: "error", title: "图标包导入失败", message: parsed.message, copyText: formatSerializedError(parsed), showLogs: true, dedupeKey: "icon-pack-import" });
    } finally {
      setIconBusy(false);
      setAppearanceImportProgress(null);
    }
  };

  const commitIconPackImport = async (): Promise<void> => {
    if (!iconPackPreview) return;
    setIconBusy(true);
    try {
      const resource = await window.wallpaperApi.commitIconPackImport(iconPackPreview.importId);
      await refreshAppearanceResources();
      setActiveIconPack(iconPackPreview.pack);
      updateAppearance({ ...appearance, icons: { ...appearance.icons, preset: "custom", packId: resource.id } });
      pushToast({ kind: "success", title: "图标包已导入并应用", message: resource.name, dedupeKey: "icon-pack-import" });
      setIconPackPreview(null);
    } catch (error) {
      const parsed = readError(error);
      pushToast({ kind: "error", title: "图标包导入失败", message: parsed.message, copyText: formatSerializedError(parsed), showLogs: true, dedupeKey: "icon-pack-import" });
    } finally {
      setIconBusy(false);
    }
  };

  const previewIconOverrideImport = async (semanticName: SemanticIconName): Promise<void> => {
    setIconBusy(true);
    try {
      const preview = await window.wallpaperApi.previewIconOverrideImport(semanticName);
      if (preview) setIconOverridePreview(preview);
    } catch (error) {
      const parsed = readError(error);
      if (parsed.code !== "E_IMPORT_CANCELLED") pushToast({ kind: "error", title: "图标替换失败", message: parsed.message, copyText: formatSerializedError(parsed), showLogs: true, dedupeKey: "icon-override-import" });
    } finally {
      setIconBusy(false);
      setAppearanceImportProgress(null);
    }
  };

  const commitIconOverrideImport = async (): Promise<void> => {
    if (!iconOverridePreview) return;
    setIconBusy(true);
    try {
      const previousId = appearance.icons.overrides[iconOverridePreview.semanticName];
      const resource = await window.wallpaperApi.commitIconOverrideImport(iconOverridePreview.importId);
      const resources = await refreshAppearanceResources();
      const metadata = resources.iconOverrides.find((entry) => entry.id === resource.id) ?? resource;
      const loaded = await loadIconOverride(metadata);
      setActiveIconOverrides((current) => ({ ...current, [resource.semanticName]: loaded }));
      updateAppearance({ ...appearance, icons: { ...appearance.icons, overrides: { ...appearance.icons.overrides, [resource.semanticName]: resource.id } } });
      if (previousId && previousId !== resource.id) {
        releaseIconOverride(previousId);
        await window.wallpaperApi.deleteIconOverrideResource(previousId).catch(() => undefined);
        await refreshAppearanceResources();
      }
      pushToast({ kind: "success", title: "单图标已替换", message: SEMANTIC_ICON_LABELS[resource.semanticName], dedupeKey: "icon-override-import" });
      setIconOverridePreview(null);
    } catch (error) {
      const parsed = readError(error);
      pushToast({ kind: "error", title: "图标替换失败", message: parsed.message, copyText: formatSerializedError(parsed), showLogs: true, dedupeKey: "icon-override-import" });
    } finally {
      setIconBusy(false);
    }
  };

  const removeIconOverride = async (semanticName: SemanticIconName): Promise<void> => {
    const id = appearance.icons.overrides[semanticName];
    if (!id) return;
    const overrides = { ...appearance.icons.overrides };
    delete overrides[semanticName];
    updateAppearance({ ...appearance, icons: { ...appearance.icons, overrides } });
    setActiveIconOverrides((current) => { const next = { ...current }; delete next[semanticName]; return next; });
    releaseIconOverride(id);
    try {
      await window.wallpaperApi.deleteIconOverrideResource(id);
      await refreshAppearanceResources();
      pushToast({ kind: "success", title: "单图标已恢复", message: SEMANTIC_ICON_LABELS[semanticName], dedupeKey: "icon-override-remove" });
    } catch (error) {
      pushToast({ kind: "error", title: "图标资源删除失败", message: readError(error).message, dedupeKey: "icon-override-remove" });
    }
  };

  const deleteIconPack = async (): Promise<void> => {
    if (!iconPackDeleteCandidate) return;
    setIconBusy(true);
    try {
      await window.wallpaperApi.deleteIconPackResource(iconPackDeleteCandidate.id);
      if (appearance.icons.packId === iconPackDeleteCandidate.id) updateAppearance({ ...appearance, icons: { ...appearance.icons, preset: "fine-outline", packId: null } });
      await refreshAppearanceResources();
      setIconPackDeleteCandidate(null);
      pushToast({ kind: "success", title: "图标包已删除", message: iconPackDeleteCandidate.name, dedupeKey: "icon-pack-delete" });
    } catch (error) {
      pushToast({ kind: "error", title: "图标包删除失败", message: readError(error).message, dedupeKey: "icon-pack-delete" });
    } finally {
      setIconBusy(false);
    }
  };

  const exportIconConfig = async (): Promise<void> => {
    const snapshot: IconConfigSnapshot = { schemaVersion: 1, preset: appearance.icons.preset, packId: appearance.icons.packId, overrides: { ...appearance.icons.overrides } };
    try {
      if (await window.wallpaperApi.exportIconConfig(snapshot)) pushToast({ kind: "success", title: "图标配置已导出", dedupeKey: "icon-config-export" });
    } catch (error) {
      pushToast({ kind: "error", title: "图标配置导出失败", message: readError(error).message, dedupeKey: "icon-config-export" });
    }
  };

  const cancelAppearanceImport = async (importId: string): Promise<void> => {
    try { await window.wallpaperApi.cancelAppearanceImport(importId); } finally {
      setAppearanceImportProgress(null);
    }
  };

  const refreshCacheOverview = useCallback(async (): Promise<void> => {
    if (!activeWorkDirectory) {
      setCacheOverview(null);
      return;
    }
    try {
      const result = await window.wallpaperApi.getCacheOverview({
        workDirectory: activeWorkDirectory,
        policy: cachePolicy,
        limitBytes: cacheLimitBytes,
      });
      setCacheOverview(result);
    } catch (error) {
      setPageError(readError(error));
    }
  }, [activeWorkDirectory, cacheLimitBytes, cachePolicy]);

  const refreshDoctor = useCallback(async (): Promise<void> => {
    try {
      setDoctorError(null);
      setDoctor(await window.wallpaperApi.doctor());
    } catch (error) {
      setDoctorError(readError(error));
    }
  }, []);

  const refreshCleanupStatus = useCallback(async (taskId: string, jobId: string): Promise<void> => {
    try {
      const status = await window.wallpaperApi.getCleanupStatus({ taskId, jobId });
      setTask((current) => current && current.id === taskId && current.jobId === jobId ? {
        ...current,
        workDirectory: status.workDirectory,
        jobFilesAvailable: status.jobFilesAvailable,
        frameCacheAvailable: status.frameCacheAvailable,
        frameCacheReference: status.frameCacheReference,
      } : current);
    } catch (error) {
      setPageError(readError(error));
    }
  }, []);

  const onTaskEvent = useCallback((event: TaskEvent): void => {
    const taskError = event.type === "error" && event.kind === "process" && event.error.code === "E_OUTPUT_EXISTS"
      ? {
          ...event.error,
          message: "输出文件刚刚被其他程序占用。旧文件没有被覆盖，请重新点击开始处理以获取下一个编号。",
          details: event.error,
        }
      : event.type === "error" ? event.error : null;
    if (event.type === "progress" && /^[a-f0-9]{20}$/.test(event.progress.jobId)) {
      taskJobIds.current.set(event.taskId, event.progress.jobId);
    }
    if (event.type === "complete" && typeof event.result.jobId === "string") {
      taskJobIds.current.set(event.taskId, event.result.jobId);
    }
    setTask((current) => {
      if (current && current.id !== "pending" && current.id !== event.taskId) return current;
      const base = current?.kind === event.kind ? current : initialTask(event.kind);
      if (event.type === "progress") {
        return {
          ...base,
          id: event.taskId,
          status: "running",
          progress: event.progress,
          jobId: event.progress.jobId,
          logs: [...base.logs, `${phaseLabel(event.progress.phase, event.kind)} · ${translateTaskMessage(event.progress.message)}`].slice(-120),
        };
      }
      if (event.type === "log") return { ...base, id: event.taskId, logs: [...base.logs, event.message].slice(-120) };
      if (event.type === "cancelled") return { ...base, id: event.taskId, status: "cancelled" };
      if (event.type === "error") return { ...base, id: event.taskId, status: "error", error: taskError };
      return {
        ...base,
        id: event.taskId,
        status: "complete",
        result: event.result,
        progress: base.progress,
        jobId: typeof event.result.jobId === "string" ? event.result.jobId : base.jobId,
        workDirectory: typeof event.result.workDirectory === "string" ? event.result.workDirectory : base.workDirectory,
      };
    });
    if (event.type === "complete" && typeof event.result.outputPath === "string") {
      void window.wallpaperApi.registerMedia(event.result.outputPath).then((url) => {
        setProcessedUrl(url);
        setViewMode("processed");
      });
    }
    if (event.type === "complete" && event.kind === "diagnostic-preview" && Array.isArray(event.result.variants)) {
      const result = event.result as unknown as DiagnosticPreviewResult;
      void Promise.all(result.variants.map(async (variant) => [
        variant.id,
        await window.wallpaperApi.registerMedia(variant.outputPath),
      ] as const)).then((entries) => {
        setDiagnosticResult(result);
        setDiagnosticUrls(Object.fromEntries(entries));
        if (result.selectedRiskPreview) {
          const seconds = result.selectedRiskPreview.ptsTime ??
            result.selectedRiskPreview.frame / Math.max(result.variants[0]?.media.video.frameRate ?? 1, 1);
          setPreviewCenter(seconds);
          pushToast({
            kind: "info",
            title: "诊断已定位风险帧",
            message: `${seconds.toFixed(2)} 秒 · ${result.selectedRiskPreview.kinds.join(" / ")}`,
            dedupeKey: "diagnostic-risk-location",
          });
        }
        setViewMode("diagnostic");
        setCacheOverview(result.cache);
      }).catch((error) => setPageError(readError(error)));
    }
    if (event.type === "complete" && event.kind === "loop-preview" && Array.isArray(event.result.variants)) {
      const result = event.result as unknown as LoopPreviewResult;
      void Promise.all(result.variants.map(async (variant) => [
        variant.id,
        await window.wallpaperApi.registerMedia(variant.outputPath),
      ] as const)).then((entries) => {
        setLoopPreviewResult(result);
        setLoopPreviewUrls(Object.fromEntries(entries));
        setSelectedLoopPreview("pingpong-end");
        setViewMode("loop");
        setCacheOverview(result.cache);
      }).catch((error) => setPageError(readError(error)));
    }
    if (event.type === "complete" || event.type === "error" || event.type === "cancelled") {
      const jobId = taskJobIds.current.get(event.taskId);
      if (jobId && event.kind !== "diagnostic-preview" && event.kind !== "loop-preview") void refreshCleanupStatus(event.taskId, jobId);
      void refreshCacheOverview();
    }
    if (event.type === "complete") {
      pushToast({ kind: "success", title: event.kind === "process" ? "壁纸视频处理完成" : event.kind === "preview" ? "最终效果预览已生成" : event.kind === "loop-preview" ? "循环检查已生成" : "四方案诊断已生成", dedupeKey: `task-${event.kind}` });
    } else if (event.type === "error") {
      const details = formatSerializedError(taskError!);
      pushToast({ kind: "error", title: "任务失败", message: taskError!.message, copyText: details, showLogs: true, dedupeKey: "task-error" });
    } else if (event.type === "cancelled") {
      pushToast({ kind: "warning", title: "任务已取消", message: "可从保留的缓存恢复。", dedupeKey: "task-cancelled" });
    }
  }, [pushToast, refreshCacheOverview, refreshCleanupStatus]);

  useEffect(() => window.wallpaperApi.onTaskEvent(onTaskEvent), [onTaskEvent]);

  useEffect(() => {
    void window.wallpaperApi.getBootstrap().then((value) => {
      setBootstrap(value);
      setTarget({ width: evenDimension(value.display.width), height: evenDimension(value.display.height) });
      setCachePolicy(value.cacheSettings.policy);
      setCacheLimitGiB(Math.max(1, Math.round(value.cacheSettings.limitBytes / 1024 ** 3)));
    }).catch((error) => setPageError(readError(error)));
    void refreshDoctor();
  }, [refreshDoctor]);

  useEffect(() => {
    if (!activeWorkDirectory) return;
    const timer = window.setTimeout(() => { void refreshCacheOverview(); }, 150);
    return () => window.clearTimeout(timer);
  }, [activeWorkDirectory, refreshCacheOverview]);

  const loadInput = useCallback(async (path: string): Promise<void> => {
    if (!path) return;
    const generation = ++inputLoadGeneration.current;
    setInputPath(path);
    setOutputPath("");
    setProcessedUrl(null);
    setDiagnosticResult(null);
    setDiagnosticUrls({});
    setViewMode("source");
    setMedia(null);
    setPageError(null);
    setInspecting(true);
    const preferredOutputPath = defaultOutputPath(path);
    const [urlResult, inspectResult, outputResult] = await Promise.allSettled([
      window.wallpaperApi.registerMedia(path),
      window.wallpaperApi.inspect(path),
      window.wallpaperApi.resolveAvailableOutputPath(preferredOutputPath),
    ]);
    if (generation !== inputLoadGeneration.current) return;
    if (urlResult.status === "fulfilled") setSourceUrl(urlResult.value);
    else setPageError(readError(urlResult.reason));
    if (inspectResult.status === "fulfilled") {
      const inspected = inspectResult.value;
      const totalFrames = Math.max(1, inspected.video.frameCount);
      setMedia(inspected);
      setSourceRange({ startFrame: 0, endFrameExclusive: totalFrames });
      setCurrentSourceFrame(0);
      setSeekRequest({ seconds: 0, id: Date.now() });
      setPreviewCenter(inspected.durationSeconds / 2);
      if (inspected.video.frameRateMode !== "constant") {
        setPageError({
          code: "E_UNSUPPORTED_MEDIA",
          message: inspected.video.frameRateMode === "variable"
            ? "检测到可变帧率视频。v0.4 的帧精确选段需要先将源视频转换为恒定帧率。"
            : "无法确认源视频为恒定帧率。请先转换为 CFR 后再进行帧精确选段。",
        });
      }
      pushToast({ kind: "success", title: "视频已载入", message: path.replace(/^.*[\\/]/, ""), dedupeKey: "input-path" });
    } else {
      setPageError(readError(inspectResult.reason));
    }
    if (outputResult.status === "fulfilled") {
      setOutputPath(outputResult.value);
    } else {
      setOutputPath("");
      setPageError(readError(outputResult.reason));
    }
    setInspecting(false);
  }, [pushToast]);

  const browseInput = async (): Promise<void> => {
    const path = await window.wallpaperApi.selectInput();
    if (path) await loadInput(path);
  };

  const selectResolution = (preset: ResolutionPreset): void => {
    setResolutionPreset(preset);
    if (preset === "display" && bootstrap) setTarget({ width: evenDimension(bootstrap.display.width), height: evenDimension(bootstrap.display.height) });
    if (preset === "wide-2k") setTarget({ width: 2560, height: 1600 });
    if (preset === "qhd") setTarget({ width: 2560, height: 1440 });
    if (preset === "uhd") setTarget({ width: 3840, height: 2160 });
  };

  const seekSourceFrame = useCallback((frame: number): void => {
    if (!media) return;
    const clamped = Math.max(sourceRange.startFrame, Math.min(sourceRange.endFrameExclusive - 1, Math.round(frame)));
    const seconds = clamped / Math.max(media.video.frameRate, 1);
    setCurrentSourceFrame(clamped);
    setPreviewCenter(seconds);
    setSeekRequest((current) => ({ seconds, id: (current?.id ?? 0) + 1 }));
  }, [media, sourceRange]);

  const updateSourceRange = useCallback((next: SourceFrameRange, seekFrame: number): void => {
    if (!media) return;
    const total = Math.max(1, media.video.frameCount);
    const startFrame = Math.max(0, Math.min(total - 1, Math.round(next.startFrame)));
    const endFrameExclusive = Math.max(startFrame + 1, Math.min(total, Math.round(next.endFrameExclusive)));
    const resolved = { startFrame, endFrameExclusive };
    setSourceRange(resolved);
    setProcessedUrl(null);
    setDiagnosticResult(null);
    setDiagnosticUrls({});
    setLoopPreviewResult(null);
    setLoopPreviewUrls({});
    setLoopPreviewResult(null);
    setLoopPreviewUrls({});
    setViewMode("source");
    const midpoint = (startFrame + endFrameExclusive - 1) / 2;
    setPreviewCenter(midpoint / Math.max(media.video.frameRate, 1));
    const clampedSeek = Math.max(startFrame, Math.min(endFrameExclusive - 1, Math.round(seekFrame)));
    setCurrentSourceFrame(clampedSeek);
    setSeekRequest((current) => ({ seconds: clampedSeek / Math.max(media.video.frameRate, 1), id: (current?.id ?? 0) + 1 }));
  }, [media]);

  const buildSpec = (loopModeOverride = loopMode, outputPathOverride = outputPath): JobSpec => ({
    version: 4,
    inputPath,
    outputPath: outputPathOverride,
    target,
    aspectMode,
    focus,
    loopMode: loopModeOverride,
    sourceRange,
    upscale: upscaleMode === "lanczos"
      ? { backend: "lanczos", model: "lanczos" }
      : {
          backend: "realesrgan-ncnn-vulkan",
          model,
          tile: 384,
          gpuId,
          aiScale,
          batchSize: DEFAULT_UI_SETTINGS.batchSize,
        },
    sourceFps: "auto",
    interpolation: interpolationEnabled ? {
      backend: "rife-ncnn-vulkan",
      model: "rife-v4.6",
      mode: "rife",
      factor: 2,
      memoryMode: "auto",
      sceneCutMode: "hold",
    } : {
      backend: "rife-ncnn-vulkan",
      model: "rife-v4.6",
      mode: "none",
      factor: 1,
      memoryMode: "auto",
      sceneCutMode: "hold",
    },
    encoding: {
      codec: "h264",
      encoder: resolvedEncoder.encoder,
      profile: "high",
      crf: 17,
      preset: "slow",
      pixelFormat: "yuv420p",
      removeAudio: true,
    },
  });

  const taskBusy = task?.status === "starting" || task?.status === "running";
  const ffmpegReady = doctor?.tools.some((tool) => tool.name === "ffmpeg" && tool.available) === true &&
    doctor.tools.some((tool) => tool.name === "ffprobe" && tool.available);
  const aiReady = doctor?.tools.some((tool) => tool.name === "realesrgan" && tool.available) === true;
  const rifeReady = doctor?.tools.some((tool) => tool.name === "rife" && tool.available) === true;
  const resolvedEncoder = resolveEncoderPreference(encoderPreference, target, doctor?.capabilities);
  const resolutionIssue = encoderResolutionDetails({ target, encoding: { encoder: resolvedEncoder.encoder } });
  const validSourceRange = Boolean(media && sourceRange.startFrame >= 0 && sourceRange.endFrameExclusive > sourceRange.startFrame && sourceRange.endFrameExclusive <= media.video.frameCount);
  const unsupportedFrameRate = Boolean(media && media.video.frameRateMode !== "constant");
  const canStart = Boolean(inputPath && outputPath && validSourceRange && !unsupportedFrameRate && !inspecting && !taskBusy && !resolutionIssue);

  const startTask = async (kind: TaskKind): Promise<void> => {
    setPageError(null);
    if (!inputPath || !outputPath) {
      setPageError({ code: "E_INVALID_CONFIG", message: "请先选择源视频和输出位置" });
      return;
    }
    if (unsupportedFrameRate) {
      setPageError({
        code: "E_UNSUPPORTED_MEDIA",
        message: "源视频不是已确认的恒定帧率。请先转换为 CFR，再重新载入并选择帧范围。",
      });
      return;
    }
    if (resolutionIssue) {
      setPageError({
        code: "E_ENCODER_UNSUPPORTED_RESOLUTION",
        message: `H.264 NVIDIA 编码器不支持 ${target.width} × ${target.height} 输出`,
        details: resolutionIssue,
      });
      return;
    }
    const diagnostic = kind === "diagnostic-preview";
    const lightweight = kind === "loop-preview";
    if (!ffmpegReady || (!lightweight && (diagnostic || upscaleMode === "realesrgan")) && !aiReady ||
        (!lightweight && (diagnostic || interpolationEnabled)) && !rifeReady) {
      setSettingsTab("tools");
      setDependencyOpen(true);
      setPageError({ code: "E_DEPENDENCY_MISSING", message: "当前处理模式所需工具尚未就绪" });
      return;
    }
    taskJobIds.current.clear();
    setCleanupOpen(false);
    setTask(initialTask(kind, workDirectory, outputPath));
    try {
      let taskOutputPath = outputPath;
      if (kind === "process") {
        taskOutputPath = await window.wallpaperApi.resolveAvailableOutputPath(outputPath);
        if (taskOutputPath !== outputPath) {
          setOutputPath(taskOutputPath);
          setTask((current) => current ? { ...current, outputPath: taskOutputPath } : current);
          pushToast({
            kind: "info",
            title: "已保留旧文件",
            message: `输出改为 ${taskOutputPath}`,
            dedupeKey: "output-renumbered",
          });
        }
      }
      const selectedVariant = viewMode === "loop"
        ? loopPreviewResult?.variants.find((variant) => variant.id === selectedLoopPreview)
        : undefined;
      const boundaryPreview = kind === "preview" && selectedVariant !== undefined;
      if (kind === "preview") setLastPreviewMode(boundaryPreview ? "loop-boundary" : "segment");
      const previewRequest = kind === "preview" && boundaryPreview ? {
        previewMode: "loop-boundary" as const,
        ...(selectedVariant.loopMode === "pingpong" ? { turn: selectedVariant.id === "pingpong-start" ? "start" as const : "end" as const } : {}),
      } : kind === "diagnostic-preview" ? {
        previewMode: "segment" as const,
      } : kind === "preview" ? {
        previewMode: "segment" as const,
        centerSeconds: previewCenter,
      } : {};
      const request = {
        spec: buildSpec(boundaryPreview ? selectedVariant.loopMode : loopMode, taskOutputPath),
        ...previewRequest,
        ...(workDirectory.trim() ? { workDirectory: workDirectory.trim() } : {}),
        cachePolicy,
        cacheLimitBytes,
      };
      const result = kind === "preview"
        ? await window.wallpaperApi.startPreview(request)
        : kind === "loop-preview"
          ? await window.wallpaperApi.startLoopPreview(request)
        : kind === "diagnostic-preview"
          ? await window.wallpaperApi.startDiagnosticPreview(request)
          : await window.wallpaperApi.startProcess(request);
      setTask((current) => current ? {
        ...current,
        id: result.taskId,
        status: current.status === "starting" ? "running" : current.status,
      } : current);
    } catch (error) {
      const parsed = readError(error);
      setTask((current) => current ? { ...current, status: "error", error: parsed } : current);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const path = window.wallpaperApi.pathForFile(file);
    if (path) void loadInput(path);
  };

  const handleInstall = async (ids: DependencyId[]): Promise<void> => {
    setInstalling(true);
    setPageError(null);
    try {
      await window.wallpaperApi.installDependencies({ ids, consent: true });
      await refreshDoctor();
      setDependencyOpen(false);
    } catch (error) {
      setPageError(readError(error));
      setDependencyOpen(false);
    } finally {
      setInstalling(false);
    }
  };

  const cleanupJobFiles = async (): Promise<void> => {
    if (!task?.jobId || task.id === "pending" || !task.jobFilesAvailable) return;
    setCleanupBusy("job");
    try {
      await window.wallpaperApi.cleanup({
        target: "job",
        taskId: task.id,
        jobId: task.jobId,
      });
      setTask((current) => current ? { ...current, jobFilesCleaned: true, jobFilesAvailable: false } : current);
    } catch (error) {
      setPageError(readError(error));
    } finally {
      setCleanupBusy(null);
    }
  };

  const cleanupSharedFrameCache = async (): Promise<void> => {
    if (!task?.jobId || task.id === "pending" || !task.frameCacheAvailable) return;
    setCleanupBusy("frame-cache");
    try {
      await window.wallpaperApi.cleanup({
        target: "frame-cache",
        taskId: task.id,
        jobId: task.jobId,
      });
      setTask((current) => current ? {
        ...current,
        jobFilesCleaned: true,
        jobFilesAvailable: false,
        frameCacheCleaned: true,
        frameCacheAvailable: false,
      } : current);
    } catch (error) {
      setPageError(readError(error));
    } finally {
      setCleanupBusy(null);
    }
  };

  const updateCacheSettings = async (policy: CachePolicy, limitGiB: number): Promise<void> => {
    const normalizedLimit = Math.max(1, Math.min(1024, Math.round(limitGiB || 1)));
    const previous = { policy: cachePolicy, limitGiB: cacheLimitGiB };
    setCachePolicy(policy);
    setCacheLimitGiB(normalizedLimit);
    try {
      const saved = await window.wallpaperApi.saveCacheSettings({
        policy,
        limitBytes: normalizedLimit * 1024 ** 3,
      });
      setCachePolicy(saved.policy);
      setCacheLimitGiB(Math.max(1, Math.round(saved.limitBytes / 1024 ** 3)));
    } catch (error) {
      setCachePolicy(previous.policy);
      setCacheLimitGiB(previous.limitGiB);
      setPageError(readError(error));
    }
  };

  const cleanupAllCaches = async (): Promise<void> => {
    if (!activeWorkDirectory) return;
    setCacheBusy(true);
    setPageError(null);
    try {
      const result = await window.wallpaperApi.cleanupCaches({
        workDirectory: activeWorkDirectory,
        policy: cachePolicy,
        limitBytes: cacheLimitBytes,
        force: true,
      });
      setLastReleasedBytes(result.releasedBytes);
      setCacheOverview(result);
      pushToast({ kind: "success", title: "缓存清理完成", message: `已释放 ${formatBytes(result.releasedBytes)}`, dedupeKey: "cache-cleanup" });
    } catch (error) {
      setPageError(readError(error));
    } finally {
      setCacheBusy(false);
    }
  };

  const readyToolCount = doctor?.tools.filter((tool) => tool.available).length ?? 0;
  const totalToolCount = 4;
  const activeUrl = viewMode === "processed" && processedUrl ? processedUrl : sourceUrl;
  const activeLabel = viewMode === "processed" && processedUrl ? lastPreviewMode === "loop-boundary" ? "循环边界预览" : "处理预览" : "源视频";
  const interpolationFactor = interpolationEnabled ? 2 : 1;
  const sourceFrameRate = media?.video.frameRate ?? null;
  const suitability = useMemo(
    () => sourceSuitability(media, target, aspectMode, upscaleMode, model, aiScale),
    [aiScale, aspectMode, media, model, target, upscaleMode],
  );
  const sourcePlayRange = media ? {
    startSeconds: sourceRange.startFrame / Math.max(media.video.frameRate, 1),
    endSeconds: sourceRange.endFrameExclusive / Math.max(media.video.frameRate, 1),
  } : null;
  const diagnosticVariants = diagnosticResult?.variants
    .map((variant) => ({ ...variant, url: diagnosticUrls[variant.id] }))
    .filter((variant): variant is typeof variant & { url: string } => typeof variant.url === "string") ?? [];
  const loopPreviewVariants = loopPreviewResult?.variants
    .map((variant) => ({ ...variant, url: loopPreviewUrls[variant.id] }))
    .filter((variant): variant is typeof variant & { url: string } => typeof variant.url === "string") ?? [];

  return (
    <SemanticIconProvider preset={appearance.icons.preset} pack={activeIconPack} overrides={activeIconOverrides}>
    <div
      className={dragging ? "app-shell is-dragging" : "app-shell"}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={handleDrop}
    >
      <header className="app-header">
        <div className="brand-block">
          <WandSparkles aria-hidden="true" />
          <div>
            <h1 className="display-title">AI 视频壁纸处理器</h1>
            <span>{bootstrap ? `v${bootstrap.appVersion}` : "正在初始化"}</span>
          </div>
        </div>
        <button className="tool-status-button" type="button" onClick={() => { setSettingsTab("appearance"); setDependencyOpen(true); }}>
          <Settings2 aria-hidden="true" />
          <span>设置</span>
          <strong className={readyToolCount === totalToolCount ? "all-ready" : "needs-tools"}>{readyToolCount}/{totalToolCount}</strong>
        </button>
      </header>

      <main className="workspace">
        <section className="preview-pane" aria-label="视频预览">
          <div className="preview-toolbar">
            <SegmentedControl<ViewMode>
              label="预览内容"
              value={viewMode === "processed" && !processedUrl ? "source" : viewMode === "loop" && loopPreviewVariants.length === 0 ? "source" : viewMode === "diagnostic" && diagnosticVariants.length === 0 ? "source" : viewMode}
              options={[
                { value: "source", label: "源视频", icon: <FileVideo aria-hidden="true" /> },
                { value: "processed", label: "处理预览", icon: <Sparkles aria-hidden="true" /> },
                ...(loopPreviewVariants.length > 0 ? [{ value: "loop" as const, label: "循环检查", icon: <RotateCcw aria-hidden="true" /> }] : []),
                ...(diagnosticVariants.length > 0 ? [{ value: "diagnostic" as const, label: "四方案诊断", icon: <ScanLine aria-hidden="true" /> }] : []),
              ]}
              disabled={!processedUrl && loopPreviewVariants.length === 0 && diagnosticVariants.length === 0}
              onChange={setViewMode}
            />
            <Tooltip content={`当前输出目标：主显示器 · ${target.width} × ${target.height}`}>
              <div className="target-readout" tabIndex={0}><Monitor aria-hidden="true" /><span>{target.width} × {target.height}</span></div>
            </Tooltip>
          </div>
          <div className="stage-wrap">
            {viewMode === "loop" && loopPreviewVariants.length > 0 ? (
              <LoopPreviewStage
                variants={loopPreviewVariants}
                selected={selectedLoopPreview}
                currentLoopMode={loopMode}
                onSelect={setSelectedLoopPreview}
                onUse={(next) => {
                  setLoopMode(next);
                  pushToast({ kind: "success", title: next === "pingpong" ? "已使用乒乓往返" : "已使用尾首直接衔接", dedupeKey: "loop-mode" });
                }}
              />
            ) : viewMode === "diagnostic" && diagnosticVariants.length > 0 ? (
              <DiagnosticPreviewStage
                variants={diagnosticVariants}
                target={target}
              />
            ) : (
              <VideoStage
                url={activeUrl}
                label={activeLabel}
                target={target}
                aspectMode={aspectMode}
                focus={focus}
                disabled={Boolean(taskBusy)}
                seekRequest={viewMode === "source" ? seekRequest : null}
                playRange={viewMode === "source" ? sourcePlayRange : null}
                onBrowse={() => { void browseInput(); }}
                onFocusChange={setFocus}
                onCurrentTimeChange={(seconds) => {
                  if (viewMode !== "source" || !media) return;
                  setCurrentSourceFrame(Math.max(sourceRange.startFrame, Math.min(sourceRange.endFrameExclusive - 1, Math.floor(seconds * media.video.frameRate))));
                }}
              />
            )}
            {dragging && (
              <div className="drop-overlay">
                <FileVideo aria-hidden="true" />
                <strong>松开以载入视频</strong>
              </div>
            )}
          </div>
          {viewMode === "source" && media && <SourceSampleStrip
            url={sourceUrl}
            startFrame={sourceRange.startFrame}
            endFrameExclusive={sourceRange.endFrameExclusive}
            frameRate={media.video.frameRate}
            disabled={Boolean(taskBusy)}
            onSelect={seekSourceFrame}
          />}
          {inspecting ? (
            <MetadataRow className="media-strip source-metadata" label="源视频" icon={<FileVideo aria-hidden="true" />} items={[{ key: "loading", content: <><LoaderCircle className="spin" aria-hidden="true" />正在读取视频信息</>, priority: "key" }]} />
          ) : (
            <MetadataRow
              className="media-strip source-metadata"
              label="源视频"
              icon={<FileVideo aria-hidden="true" />}
              items={media ? [
                { key: "resolution", content: media.video.width > 0 && media.video.height > 0 ? `${media.video.width} × ${media.video.height}` : null, priority: "key" },
                { key: "duration", content: formatMediaDuration(media.durationSeconds), priority: "key" },
                { key: "fps", content: formatFrameRate(media.video.frameRate) },
                { key: "frame-rate-mode", content: media.video.frameRateMode === "variable" ? "VFR" : media.video.frameRateMode === "constant" ? "CFR" : "帧率未确认" },
                { key: "frames", content: media.video.frameCount > 0 ? `${media.video.frameCount} 帧` : null },
                { key: "codec", content: normalizeCodec(media.video.codec) },
                { key: "size", content: formatMetadataBytes(media.sizeBytes) },
                { key: "audio", content: media.audio.length > 0 ? `${normalizeCodec(media.audio[0]?.codec) ?? "音轨"} 已移除` : "无音轨" },
              ] : []}
              empty="载入视频后显示编码、帧率、时长和音轨信息"
            />
          )}
        </section>

        <aside className="controls-pane" aria-label="处理设置">
          <div className="control-section source-section">
            <div className="section-heading">
              <div><span className="step-number">1</span><h2 className="major-section-title">文件</h2></div>
            </div>
            <label className="field-label" htmlFor="input-path">源视频</label>
            <div className="path-field">
              <Tooltip content={inputPath || "尚未选择视频"}><input id="input-path" value={inputPath} readOnly placeholder="尚未选择视频" /></Tooltip>
              <Tooltip content="选择源视频">
                <button className="icon-button" type="button" aria-label="选择源视频" onClick={() => { void browseInput(); }} disabled={Boolean(taskBusy)}>
                  <FolderOpen aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
          </div>

          <div className="control-section trim-section">
            <div className="section-heading">
              <div><span className="step-number">2</span><h2 className="major-section-title">片段</h2></div>
            </div>
            {media ? <TrimRange
              range={sourceRange}
              totalFrames={Math.max(1, media.video.frameCount)}
              frameRate={media.video.frameRate}
              currentFrame={currentSourceFrame}
              loopMode={loopMode}
              disabled={Boolean(taskBusy) || unsupportedFrameRate}
              onChange={updateSourceRange}
              onReset={() => updateSourceRange({ startFrame: 0, endFrameExclusive: Math.max(1, media.video.frameCount) }, 0)}
            /> : <p className="field-note">载入视频后可按帧设置入点和出点。</p>}
            {unsupportedFrameRate && <div className="quality-warning" role="alert">
              <AlertCircle aria-hidden="true" />
              <span>{media?.video.frameRateMode === "variable" ? "可变帧率会让时间预览与帧号抽取不一致" : "当前素材无法确认恒定帧间隔"}，请先将源视频转换为 CFR。</span>
            </div>}
          </div>

          <div className="control-section">
            <div className="section-heading">
              <div><span className="step-number">3</span><h2 className="major-section-title">画面</h2></div>
              {aspectMode === "cover" && <span className="focus-readout">焦点 {Math.round(focus.x * 100)}%, {Math.round(focus.y * 100)}%</span>}
            </div>
            <label className="field-label" htmlFor="resolution">输出分辨率</label>
            <Select<ResolutionPreset>
              id="resolution"
              value={resolutionPreset}
              options={[
                { value: "display", label: `主显示器 · ${bootstrap ? `${bootstrap.display.width} × ${bootstrap.display.height}` : "检测中"}` },
                { value: "wide-2k", label: "2.5K · 2560 × 1600" },
                { value: "qhd", label: "QHD · 2560 × 1440" },
                { value: "uhd", label: "4K · 3840 × 2160" },
                { value: "custom", label: "自定义" },
              ]}
              onChange={selectResolution}
              disabled={Boolean(taskBusy)}
            />
            {resolutionPreset === "custom" && (
              <div className="dimension-row">
                <label>宽 <input type="number" min="2" max="16384" step="2" value={target.width} onChange={(event) => setTarget((current) => ({ ...current, width: Number(event.target.value) }))} onBlur={() => setTarget((current) => ({ ...current, width: evenDimension(current.width) }))} /></label>
                <X aria-hidden="true" />
                <label>高 <input type="number" min="2" max="16384" step="2" value={target.height} onChange={(event) => setTarget((current) => ({ ...current, height: Number(event.target.value) }))} onBlur={() => setTarget((current) => ({ ...current, height: evenDimension(current.height) }))} /></label>
              </div>
            )}
            <label className="field-label">画幅方式</label>
            <SegmentedControl<AspectMode>
              label="画幅方式"
              value={aspectMode}
              disabled={Boolean(taskBusy)}
              options={[
                { value: "blur-background", label: "模糊背景", icon: <PanelTop aria-hidden="true" /> },
                { value: "cover", label: "裁切填满", icon: <Crop aria-hidden="true" /> },
                { value: "contain", label: "完整留边", icon: <Maximize2 aria-hidden="true" /> },
              ]}
              onChange={setAspectMode}
            />
            {aspectMode === "cover" && <p className="field-note">在预览画面上拖动以设置裁切焦点。</p>}
            <SourceSuitabilityPanel value={suitability} aspectMode={aspectMode} disabled={Boolean(taskBusy)} onUseBlurBackground={() => setAspectMode("blur-background")} />
          </div>

          <div className="control-section">
            <div className="section-heading">
              <div><span className="step-number">4</span><h2 className="major-section-title">清晰度与循环</h2></div>
            </div>
            <label className="field-label">放大方式</label>
            <SegmentedControl<UpscaleMode>
              label="放大方式"
              value={upscaleMode}
              disabled={Boolean(taskBusy)}
              options={[
                { value: "realesrgan", label: "AI 超分", icon: <Sparkles aria-hidden="true" /> },
                { value: "lanczos", label: "稳定缩放", icon: <ScanLine aria-hidden="true" /> },
              ]}
              onChange={setUpscaleMode}
            />
            {upscaleMode === "realesrgan" && (
              <>
                <label className="field-label" htmlFor="model">AI 模型</label>
                <Select<LegacyUpscaleModel>
                  id="model"
                  value={model}
                  options={[
                    { value: "realesr-animevideov3", label: "动漫与插画" },
                    { value: "realesrgan-x4plus", label: "通用与实拍" },
                  ]}
                  onChange={(nextModel) => {
                    setModel(nextModel);
                    if (nextModel === "realesrgan-x4plus" && aiScale !== "auto" && aiScale !== 4) setAiScale(4);
                  }}
                  disabled={Boolean(taskBusy)}
                />
                <AdvancedSection label="AI 性能设置">
                <div className="compact-field-grid">
                  <label className="compact-field" htmlFor="gpu-id">
                    <span>Vulkan GPU</span>
                    <Select<"auto" | "0"> id="gpu-id" value={String(gpuId) as "auto" | "0"} options={[{ value: "auto", label: "自动选择" }, { value: "0", label: "Vulkan GPU 0" }]} onChange={(next) => setGpuId(next === "auto" ? "auto" : Number(next))} disabled={Boolean(taskBusy)} />
                  </label>
                  <label className="compact-field" htmlFor="ai-scale">
                    <span>AI 倍率</span>
                    <Select<"auto" | "2" | "3" | "4">
                      id="ai-scale"
                      value={String(aiScale) as "auto" | "2" | "3" | "4"}
                      options={[
                        { value: "auto", label: "自动" },
                        { value: "2", label: "2×", disabled: model !== "realesr-animevideov3" },
                        { value: "3", label: "3×", disabled: model !== "realesr-animevideov3" },
                        { value: "4", label: "4×" },
                      ]}
                      onChange={(next) => setAiScale(next === "auto" ? "auto" : Number(next) as 2 | 3 | 4)}
                      disabled={Boolean(taskBusy)}
                    />
                  </label>
                </div>
                </AdvancedSection>
              </>
            )}
            <label className="field-label">插帧</label>
            <SegmentedControl<InterpolationSpec["mode"]>
              label="插帧"
              value={interpolationMode}
              disabled={Boolean(taskBusy)}
              options={[
                { value: "none", label: "关闭", icon: <ScanLine aria-hidden="true" /> },
                { value: "rife", label: "AI 2×", icon: <Sparkles aria-hidden="true" /> },
              ]}
              onChange={setInterpolationMode}
            />
            <p className="interpolation-readout" aria-live="polite">
              <span>RIFE v4.6</span>
              <span>{sourceFrameRate === null
                ? `输出帧率 ${interpolationFactor}×`
                : `${sourceFrameRate.toFixed(2)} → ${(sourceFrameRate * interpolationFactor).toFixed(2)} fps`}</span>
              <span>处理帧量约 {interpolationFactor}×</span>
            </p>
            {interpolationEnabled && upscaleMode === "realesrgan" && (
              <div className="quality-warning" role="note">
                <AlertCircle aria-hidden="true" />
                <span>插帧可能放大原视频中的拖尾、双线和遮挡错误，请先检查代表性预览。</span>
              </div>
            )}
            <label className="field-label">循环方式</label>
            <SegmentedControl<"pingpong" | "none">
              label="循环方式"
              value={loopMode}
              disabled={Boolean(taskBusy)}
              options={[
                { value: "pingpong", label: "乒乓往返", icon: <RotateCcw aria-hidden="true" /> },
                { value: "none", label: "尾首直接衔接", icon: <ScanLine aria-hidden="true" /> },
              ]}
              onChange={setLoopMode}
            />
            <p className="field-note">{loopMode === "pingpong" ? "包含 2 个折返点：片尾折返 + 片头折返。" : "包含 1 个接缝：片尾 → 片头。"}</p>
          </div>

          <div className="control-section output-section">
            <div className="section-heading">
              <div><span className="step-number">5</span><h2 className="major-section-title">输出与编码</h2></div>
            </div>
            <label className="field-label" htmlFor="output-path">输出位置</label>
            <div className="path-field">
              <Tooltip content={outputPath || "选择源视频后自动生成"}><input id="output-path" value={outputPath} readOnly placeholder="选择源视频后自动生成" /></Tooltip>
              <Tooltip content="选择输出位置">
                <button
                  className="icon-button"
                  type="button"
                  aria-label="选择输出位置"
                  onClick={() => { void window.wallpaperApi.selectOutput(inputPath).then((path) => {
                    if (path) {
                      setOutputPath(path);
                      pushToast({ kind: "info", title: "输出位置已更新", message: path, dedupeKey: "output-path" });
                    }
                  }).catch((error) => setPageError(readError(error))); }}
                  disabled={!inputPath || Boolean(taskBusy)}
                >
                  <Save aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
            <label className="field-label">编码方式</label>
            <SegmentedControl<EncoderPreference>
              label="编码方式"
              value={encoderPreference}
              disabled={Boolean(taskBusy)}
              options={[
                { value: "libx264", label: "质量 / 小体积", icon: <Cpu aria-hidden="true" /> },
                { value: "h264_nvenc", label: "快速 / 较大体积", icon: <Gauge aria-hidden="true" />, disabled: doctor?.capabilities?.h264Nvenc?.available !== true },
              ]}
              onChange={setEncoderPreference}
            />
            <p className="encoder-resolution-readout" aria-live="polite">{resolvedEncoder.label}</p>
            {resolutionIssue && (
              <div className="encoder-resolution-warning" role="alert">
                <AlertCircle aria-hidden="true" />
                <p>快速 NVIDIA 的 H.264 单边上限为 {resolutionIssue.maxDimension}；当前为 {target.width} × {target.height}。</p>
                <div>
                  <button className="button secondary" type="button" onClick={() => setEncoderPreference("libx264")} disabled={Boolean(taskBusy)}><Cpu aria-hidden="true" />改用高质量 CPU</button>
                  <button className="button secondary" type="button" onClick={() => { setTarget(resolutionIssue.suggestedTarget); setResolutionPreset("custom"); }} disabled={Boolean(taskBusy)}>
                    <Monitor aria-hidden="true" />调整为 {resolutionIssue.suggestedTarget.width} × {resolutionIssue.suggestedTarget.height}
                  </button>
                </div>
              </div>
            )}
            <AdvancedSection label="工作文件与缓存">
              <label className="field-label" htmlFor="work-path">工作文件位置</label>
              <div className={workDirectory ? "path-field work-path-field has-clear" : "path-field work-path-field"}>
                <Tooltip content={workDirectory || "留空则跟随输出目录"}><input id="work-path" value={workDirectory} readOnly placeholder="留空则跟随输出目录" /></Tooltip>
                {workDirectory && <Tooltip content="恢复默认位置"><button className="icon-button clear-path" type="button" aria-label="恢复默认位置" onClick={() => setWorkDirectory("")} disabled={Boolean(taskBusy)}><X aria-hidden="true" /></button></Tooltip>}
                <Tooltip content="选择工作文件位置"><button className="icon-button" type="button" aria-label="选择工作文件位置" onClick={() => {
                  const initial = workDirectory || outputPath.replace(/[\\/][^\\/]+$/, "");
                  void window.wallpaperApi.selectWorkDirectory(initial).then((path) => {
                    if (path) {
                      setWorkDirectory(path);
                      pushToast({ kind: "info", title: "工作文件位置已更新", message: path, dedupeKey: "work-path" });
                    }
                  });
                }} disabled={Boolean(taskBusy)}><HardDrive aria-hidden="true" /></button></Tooltip>
              </div>
              <p className="field-note">默认在成片旁创建 .ai-video-wallpaper-work。</p>
              <CacheControls
                overview={cacheOverview}
                policy={cachePolicy}
                limitGiB={cacheLimitGiB}
                workDirectory={activeWorkDirectory}
                lastReleasedBytes={lastReleasedBytes}
                disabled={Boolean(taskBusy) || cacheBusy}
                busy={cacheBusy}
                onPolicyChange={(next) => { void updateCacheSettings(next, cacheLimitGiB); }}
                onLimitCommit={(next) => { void updateCacheSettings(cachePolicy, next); }}
                onCleanup={() => { void cleanupAllCaches(); }}
              />
            </AdvancedSection>
          </div>
        </aside>
      </main>

      <TaskDock
        task={task}
        taskBusy={Boolean(taskBusy)}
        canStart={canStart}
        doctorError={doctorError}
        pageError={pageError}
        logDetailsRef={logDetailsRef}
        onOpenTools={() => { setSettingsTab("tools"); setDependencyOpen(true); }}
        onClosePageError={() => setPageError(null)}
        onRunTask={(kind) => { void startTask(kind); }}
        onCancelTask={() => { if (task?.id && task.id !== "pending") void window.wallpaperApi.cancel(task.id); }}
        onOpenCleanup={() => {
          if (!task) return;
          setCleanupOpen(true);
          if (task.id !== "pending" && task.jobId) void refreshCleanupStatus(task.id, task.jobId);
        }}
        onOpenOutput={(path) => { void window.wallpaperApi.showItemInFolder(path); }}
      />

      <SettingsDialog
        open={dependencyOpen}
        tab={settingsTab}
        catalog={bootstrap?.dependencyCatalog ?? []}
        report={doctor}
        installing={installing}
        appearance={appearance}
        appliedTypography={appliedTypography}
        resolvedTheme={resolvedTheme}
        fontResources={appearanceResources.fonts}
        fontBusy={fontBusy}
        iconPacks={appearanceResources.iconPacks}
        iconOverrides={appearanceResources.iconOverrides}
        iconBusy={iconBusy}
        importProgress={appearanceImportProgress}
        onClose={() => setDependencyOpen(false)}
        onTabChange={setSettingsTab}
        onAppearanceChange={updateAppearance}
        onImportFont={(role) => { void previewFontImport(role); }}
        onDeleteFont={setFontDeleteCandidate}
        onResetTypography={() => updateAppearance({ ...appearance, typography: { ...DEFAULT_TYPOGRAPHY } })}
        onImportIconPack={() => { void previewIconPackImport(); }}
        onImportIconOverride={(name) => { void previewIconOverrideImport(name); }}
        onRemoveIconOverride={(name) => { void removeIconOverride(name); }}
        onDeleteIconPack={setIconPackDeleteCandidate}
        onResetIcons={() => updateAppearance({ ...appearance, icons: { ...DEFAULT_ICONS, overrides: {} } })}
        onResetAll={() => updateAppearance({ ...DEFAULT_APPEARANCE, typography: { ...DEFAULT_APPEARANCE.typography }, icons: { ...DEFAULT_APPEARANCE.icons, overrides: {} } })}
        onExportIconConfig={() => { void exportIconConfig(); }}
        onCancelImport={(importId) => { void cancelAppearanceImport(importId); }}
        onInstall={(ids) => { void handleInstall(ids); }}
        onOpenLink={(url) => { void window.wallpaperApi.openExternal(url); }}
      />
      <FontImportDialog
        value={fontPreview}
        busy={fontBusy}
        onCancel={() => {
          if (fontPreview) {
            releasePreviewFont(fontPreview.preview.importId);
            void window.wallpaperApi.cancelAppearanceImport(fontPreview.preview.importId);
          }
          setFontPreview(null);
        }}
        onConfirm={() => { void commitFontImport(); }}
      />
      <FontDeleteDialog
        font={fontDeleteCandidate}
        active={Boolean(fontDeleteCandidate && (appearance.typography.uiFontId === fontDeleteCandidate.id || appearance.typography.displayFontId === fontDeleteCandidate.id))}
        busy={fontBusy}
        onCancel={() => setFontDeleteCandidate(null)}
        onConfirm={() => { void deleteFontResource(); }}
      />
      <IconPackImportDialog
        value={iconPackPreview}
        busy={iconBusy}
        onCancel={() => {
          if (iconPackPreview) void window.wallpaperApi.cancelAppearanceImport(iconPackPreview.importId);
          setIconPackPreview(null);
        }}
        onConfirm={() => { void commitIconPackImport(); }}
      />
      <IconOverrideImportDialog
        value={iconOverridePreview}
        busy={iconBusy}
        onCancel={() => {
          if (iconOverridePreview) void window.wallpaperApi.cancelAppearanceImport(iconOverridePreview.importId);
          setIconOverridePreview(null);
        }}
        onConfirm={() => { void commitIconOverrideImport(); }}
      />
      <IconPackDeleteDialog
        pack={iconPackDeleteCandidate}
        active={Boolean(iconPackDeleteCandidate && appearance.icons.packId === iconPackDeleteCandidate.id)}
        busy={iconBusy}
        onCancel={() => setIconPackDeleteCandidate(null)}
        onConfirm={() => { void deleteIconPack(); }}
      />
      <CleanupDialog
        open={cleanupOpen && task !== null}
        workDirectory={task?.workDirectory ?? ""}
        jobFilesAvailable={task?.jobFilesAvailable ?? false}
        frameCacheAvailable={task?.frameCacheAvailable ?? false}
        frameCacheReference={task?.frameCacheReference ?? null}
        jobFilesCleaned={task?.jobFilesCleaned ?? false}
        frameCacheCleaned={task?.frameCacheCleaned ?? false}
        busy={cleanupBusy}
        onClose={() => setCleanupOpen(false)}
        onCleanupJob={() => { void cleanupJobFiles(); }}
        onCleanupFrameCache={() => { void cleanupSharedFrameCache(); }}
      />
      <ToastRegion
        toasts={toasts}
        onDismiss={dismissToast}
        onCopy={(text) => { void window.wallpaperApi.copyText(text).then(() => pushToast({ kind: "success", title: "详情已复制", dedupeKey: "copied" })); }}
        onShowLogs={() => {
          if (logDetailsRef.current) {
            logDetailsRef.current.open = true;
            logDetailsRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        }}
      />
    </div>
    </SemanticIconProvider>
  );
}
