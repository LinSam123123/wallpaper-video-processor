import { useEffect, useState } from "react";
import type { CacheOverview, CachePolicy } from "../../../shared/contracts";
import { Select } from "./Select";
import { createSemanticIcon } from "./SemanticIcon";
import { Tooltip } from "./Tooltip";

const LoaderCircle = createSemanticIcon("loading");
const Trash2 = createSemanticIcon("delete");

const GIB = 1024 ** 3;

export function formatCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** unit;
  return `${value.toFixed(unit === 0 || Number.isInteger(value) ? 0 : 1)} ${units[unit]}`;
}

export type CacheUsageLevel = "normal" | "warning" | "danger";

export function cacheUsageState(bytes: number, limitBytes: number): { percent: number; level: CacheUsageLevel; label: string } {
  const ratio = limitBytes > 0 ? Math.max(0, bytes / limitBytes) : bytes > 0 ? 1 : 0;
  const percent = Math.min(100, ratio * 100);
  if (ratio >= 1) return { percent, level: "danger", label: "已超上限" };
  if (ratio >= 0.95) return { percent, level: "danger", label: "接近上限" };
  if (ratio >= 0.8) return { percent, level: "warning", label: "接近上限" };
  return { percent, level: "normal", label: "缓存容量充足" };
}

export interface CacheControlsProps {
  overview: CacheOverview | null;
  policy: CachePolicy;
  limitGiB: number;
  workDirectory: string;
  lastReleasedBytes: number;
  disabled: boolean;
  busy: boolean;
  onPolicyChange(policy: CachePolicy): void;
  onLimitCommit(limitGiB: number): void;
  onCleanup(): void;
}

export function CacheControls({
  overview,
  policy,
  limitGiB,
  workDirectory,
  lastReleasedBytes,
  disabled,
  busy,
  onPolicyChange,
  onLimitCommit,
  onCleanup,
}: CacheControlsProps): React.JSX.Element {
  const [limitDraft, setLimitDraft] = useState(String(limitGiB));
  useEffect(() => setLimitDraft(String(limitGiB)), [limitGiB]);
  const restoreLimit = (): void => setLimitDraft(String(limitGiB));
  const commitLimit = (): void => {
    const parsed = Number(limitDraft);
    if (!Number.isFinite(parsed)) {
      restoreLimit();
      return;
    }
    const normalized = Math.max(1, Math.min(1024, Math.round(parsed)));
    setLimitDraft(String(normalized));
    if (normalized !== limitGiB) onLimitCommit(normalized);
  };
  const currentBytes = overview?.remainingBytes ?? 0;
  const limitBytes = Math.max(0, limitGiB * GIB);
  const usage = cacheUsageState(currentBytes, limitBytes);
  const cacheDirectory = overview?.cacheDirectory ?? (workDirectory ? `${workDirectory}\\frame-cache` : "等待输出位置");

  return (
    <div className="cache-controls" aria-label="缓存设置">
      <div className="cache-usage-row">
        <span>当前缓存</span>
        <strong className="numeric-data">{formatCacheBytes(currentBytes)} / {formatCacheBytes(limitBytes)}</strong>
      </div>
      <div
        className={`cache-usage-track is-${usage.level}`}
        role="progressbar"
        aria-label="缓存占用"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(usage.percent)}
        aria-valuetext={`${formatCacheBytes(currentBytes)} / ${formatCacheBytes(limitBytes)}，${usage.label}`}
      >
        <span style={{ width: `${usage.percent}%` }} />
      </div>
      <Tooltip content={cacheDirectory}><p className="cache-directory" tabIndex={0}>{cacheDirectory}</p></Tooltip>
      <div className="cache-field-list">
        <div className="cache-field">
          <label htmlFor="cache-policy">缓存策略</label>
          <Select<CachePolicy>
            id="cache-policy"
            ariaLabel="缓存策略"
            value={policy}
            options={[
              { value: "cleanup-on-success", label: "成功后清理" },
              { value: "keep-24-hours", label: "保留 24 小时" },
              { value: "keep-all", label: "全部保留" },
            ]}
            onChange={onPolicyChange}
            disabled={disabled}
          />
        </div>
        <div className="cache-field">
          <label htmlFor="cache-limit">缓存上限</label>
          <span className="cache-limit-field">
            <input
              id="cache-limit"
              className="numeric-data"
              type="number"
              min="1"
              max="1024"
              step="1"
              value={limitDraft}
              onChange={(event) => setLimitDraft(event.target.value)}
              onBlur={commitLimit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitLimit();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  restoreLimit();
                  event.currentTarget.blur();
                }
              }}
              disabled={disabled}
            />
            <span aria-hidden="true">GB</span>
          </span>
        </div>
      </div>
      <div className="cache-actions">
        <span aria-live="polite">本次释放 <strong className="numeric-data">{formatCacheBytes(lastReleasedBytes)}</strong> · {usage.label}</span>
        <button className="button secondary cache-cleanup-button" type="button" onClick={onCleanup} disabled={!workDirectory || disabled}>
          {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
          {busy ? "正在清理" : "清理缓存"}
        </button>
      </div>
    </div>
  );
}
