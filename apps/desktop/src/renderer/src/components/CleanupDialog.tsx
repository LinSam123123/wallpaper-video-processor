import { useEffect, useState } from "react";
import { Tooltip } from "./Tooltip";
import { createSemanticIcon } from "./SemanticIcon";

const AlertTriangle = createSemanticIcon("warning");
const Database = createSemanticIcon("database");
const FileClock = createSemanticIcon("cachedFile");
const LoaderCircle = createSemanticIcon("loading");
const X = createSemanticIcon("close");

interface CleanupDialogProps {
  open: boolean;
  workDirectory: string;
  jobFilesAvailable: boolean;
  frameCacheAvailable: boolean;
  frameCacheReference: string | null;
  jobFilesCleaned: boolean;
  frameCacheCleaned: boolean;
  busy: "job" | "frame-cache" | null;
  onClose(): void;
  onCleanupJob(): void;
  onCleanupFrameCache(): void;
}

export function CleanupDialog({
  open,
  workDirectory,
  jobFilesAvailable,
  frameCacheAvailable,
  frameCacheReference,
  jobFilesCleaned,
  frameCacheCleaned,
  busy,
  onClose,
  onCleanupJob,
  onCleanupFrameCache,
}: CleanupDialogProps): React.JSX.Element | null {
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (open) setConfirmed(false);
  }, [open]);

  if (!open) return null;
  const cacheAvailable = frameCacheAvailable && !frameCacheCleaned;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="dependency-dialog cleanup-dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-title">
        <header className="dialog-header">
          <div>
            <h2 id="cleanup-title">清理工作文件</h2>
            <p>任务状态与共享 AI 帧缓存相互独立，可分别清理。</p>
          </div>
          <Tooltip content="关闭"><button className="icon-button" type="button" aria-label="关闭" onClick={onClose} disabled={busy !== null}><X aria-hidden="true" /></button></Tooltip>
        </header>

        <div className="cleanup-list">
          <div className="cleanup-row">
            <div className="cleanup-row-icon"><FileClock aria-hidden="true" /></div>
            <div className="cleanup-row-copy">
              <strong>任务状态文件</strong>
              <span>删除进度、批处理临时目录和编码序列。不会删除成片，也不会删除可复用 AI 帧。</span>
            </div>
            <button className="button secondary" type="button" onClick={onCleanupJob} disabled={busy !== null || jobFilesCleaned || !jobFilesAvailable}>
              {busy === "job" && <LoaderCircle className="spin" aria-hidden="true" />}
              {jobFilesCleaned ? "已清理" : jobFilesAvailable ? "清理任务状态" : "暂无任务状态"}
            </button>
          </div>

          <div className="cleanup-row shared-cache-row">
            <div className="cleanup-row-icon warning"><Database aria-hidden="true" /></div>
            <div className="cleanup-row-copy">
              <strong>共享 AI 帧缓存</strong>
              <span>通常占用空间最大。删除后，引用同一缓存的任务需要重新提取和 AI 处理。</span>
              {frameCacheReference
                ? <Tooltip content={frameCacheReference}><code tabIndex={0}>当前任务引用：{frameCacheReference}</code></Tooltip>
                : <code>当前任务尚未建立可清理缓存</code>}
            </div>
            <span className="cache-risk"><AlertTriangle aria-hidden="true" />影响复用</span>
          </div>
        </div>

        <label className="consent-row cleanup-consent">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={!cacheAvailable || busy !== null}
          />
          <span>我确认删除当前任务引用的共享 AI 帧缓存，并了解其他任务可能需要重新处理。</span>
        </label>
        <Tooltip content={workDirectory || "等待任务返回"}><div className="cleanup-work-root" tabIndex={0}>工作位置：{workDirectory || "等待任务返回"}</div></Tooltip>
        <footer className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy !== null}>关闭</button>
          <button className="button danger" type="button" onClick={onCleanupFrameCache} disabled={!cacheAvailable || !confirmed || busy !== null}>
            {busy === "frame-cache" && <LoaderCircle className="spin" aria-hidden="true" />}
            {frameCacheCleaned ? "共享缓存已删除" : "删除共享 AI 帧缓存"}
          </button>
        </footer>
      </section>
    </div>
  );
}
