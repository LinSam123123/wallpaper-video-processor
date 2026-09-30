import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { DoctorReport, ProgressEvent, SerializedError, TaskKind } from "../../../shared/contracts";
import { formatSerializedError } from "../error-format";
import { createSemanticIcon } from "./SemanticIcon";
import { Tooltip } from "./Tooltip";

const AlertCircle = createSemanticIcon("warning");
const Check = createSemanticIcon("confirm");
const CheckCircle2 = createSemanticIcon("success");
const Clock3 = createSemanticIcon("clock", true);
const FolderOpen = createSemanticIcon("openFolder");
const LoaderCircle = createSemanticIcon("loading");
const MoreHorizontal = createSemanticIcon("more", true);
const Play = createSemanticIcon("play");
const RotateCcw = createSemanticIcon("reset");
const ScanLine = createSemanticIcon("diagnostic");
const ScrollText = createSemanticIcon("logs");
const Sparkles = createSemanticIcon("processedVideo");
const Square = createSemanticIcon("stop");
const Trash2 = createSemanticIcon("delete");
const Wrench = createSemanticIcon("tools");
const X = createSemanticIcon("close");

export interface UiTask {
  id: string;
  kind: TaskKind;
  status: "starting" | "running" | "complete" | "cancelled" | "error";
  progress: ProgressEvent | null;
  jobId: string | null;
  logs: string[];
  result: Record<string, unknown> | null;
  error: SerializedError | null;
  workDirectory: string;
  outputPath: string;
  frameCacheReference: string | null;
  jobFilesAvailable: boolean;
  frameCacheAvailable: boolean;
  jobFilesCleaned: boolean;
  frameCacheCleaned: boolean;
}

const PHASE_LABELS: Record<ProgressEvent["phase"], string> = {
  prepare: "准备空间",
  inspect: "分析视频",
  extract: "提取帧",
  interpolate: "AI 插帧",
  upscale: "AI 超分",
  sequence: "构建循环",
  encode: "编码成片",
  verify: "正在验证",
  complete: "处理完成",
};

export function phaseLabel(phase: ProgressEvent["phase"], kind: TaskKind): string {
  if (phase === "encode") {
    if (kind === "preview") return "编码预览";
    if (kind === "loop-preview") return "编码循环检查";
    if (kind === "diagnostic-preview") return "编码诊断预览";
  }
  return PHASE_LABELS[phase];
}

const MESSAGE_TRANSLATIONS: Array<[RegExp, string]> = [
  [/Inspecting source video/i, "正在分析源视频"],
  [/Source video inspected/i, "源视频分析完成"],
  [/Extracting source frames/i, "正在提取源视频帧"],
  [/Extracting preview frames/i, "正在提取预览帧"],
  [/Interpolating frames/i, "正在生成 AI 插帧"],
  [/Upscaling frames/i, "正在逐帧 AI 超分"],
  [/Building output sequence/i, "正在构建输出序列"],
  [/Encoding H\.264 wallpaper/i, "正在编码 H.264 壁纸"],
  [/Wallpaper video complete/i, "壁纸视频处理完成"],
  [/Checking .* temporary space/i, "正在检查临时磁盘空间"],
];

export function translateTaskMessage(message: string): string {
  return MESSAGE_TRANSLATIONS.find(([pattern]) => pattern.test(message))?.[1] ?? message;
}

function formatEta(milliseconds: number | null): string {
  if (milliseconds === null) return "计算中";
  if (milliseconds <= 1_000) return "即将完成";
  const seconds = Math.ceil(milliseconds / 1_000);
  if (seconds < 60) return `剩余约 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `剩余约 ${minutes} 分 ${seconds % 60} 秒`;
}

function completeTitle(kind: TaskKind): string {
  if (kind === "preview") return "预览生成完成";
  if (kind === "loop-preview") return "循环检查完成";
  if (kind === "diagnostic-preview") return "诊断生成完成";
  return "处理完成";
}

interface OverflowItem {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onSelect(): void;
}

function TaskOverflowMenu({ items }: { items: OverflowItem[] }): React.JSX.Element {
  const id = `${useId()}-task-menu`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const close = (restoreFocus = false): void => {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  };
  const updatePosition = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: Math.min(window.innerWidth - 206, Math.max(8, rect.right - 198)), top: rect.top - 8 });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updatePosition);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open]);

  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return <>
    <Tooltip content="更多任务操作">
      <button ref={triggerRef} className="button ghost task-overflow-trigger" type="button" aria-label="更多任务操作" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((current) => !current)}>
        <MoreHorizontal aria-hidden="true" />
      </button>
    </Tooltip>
    {open && createPortal(
      <div ref={menuRef} id={id} className="task-overflow-menu" role="menu" style={position} onKeyDown={moveFocus}>
        {items.map((item) => <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={() => { item.onSelect(); close(true); }}>{item.icon}<span>{item.label}</span></button>)}
      </div>,
      document.body,
    )}
  </>;
}

export interface TaskDockProps {
  task: UiTask | null;
  taskBusy: boolean;
  canStart: boolean;
  doctorError: SerializedError | null;
  pageError: SerializedError | null;
  logDetailsRef: RefObject<HTMLDetailsElement | null>;
  onOpenTools(): void;
  onClosePageError(): void;
  onRunTask(kind: TaskKind): void;
  onCancelTask(): void;
  onOpenCleanup(): void;
  onOpenOutput(path: string): void;
}

export function TaskDock({ task, taskBusy, canStart, doctorError, pageError, logDetailsRef, onOpenTools, onClosePageError, onRunTask, onCancelTask, onOpenCleanup, onOpenOutput }: TaskDockProps): React.JSX.Element {
  const [showCompletionTrack, setShowCompletionTrack] = useState(false);

  useEffect(() => {
    if (task?.status !== "complete") {
      setShowCompletionTrack(false);
      return;
    }
    setShowCompletionTrack(true);
    const timer = window.setTimeout(() => setShowCompletionTrack(false), 1_000);
    return () => window.clearTimeout(timer);
  }, [task?.id, task?.status]);

  const openLogs = (): void => {
    if (!logDetailsRef.current) return;
    logDetailsRef.current.open = true;
    window.setTimeout(() => logDetailsRef.current?.querySelector<HTMLElement>("pre")?.focus(), 0);
  };
  const percent = task?.status === "complete" ? 100 : Math.max(0, Math.min(100, task?.progress?.percent ?? 0));
  const running = task?.status === "starting" || task?.status === "running";
  const showStoppedTrack = Boolean(task?.progress && (task.status === "error" || (task.status === "cancelled" && percent < 100)));
  const showTrack = running || showStoppedTrack || showCompletionTrack;
  const progressLabel = task?.status === "starting" ? "正在启动" : task?.progress ? phaseLabel(task.progress.phase, task.kind) : "等待进度";
  const outputPath = typeof task?.result?.outputPath === "string" ? task.result.outputPath : null;
  const canCleanup = Boolean(task && task.kind !== "diagnostic-preview");

  const overflowItems: OverflowItem[] = [
    { label: "四方案诊断", icon: <ScanLine aria-hidden="true" />, disabled: !canStart, onSelect: () => onRunTask("diagnostic-preview") },
    ...(task && !taskBusy ? [{ label: "再次运行", icon: <RotateCcw aria-hidden="true" />, disabled: !canStart, onSelect: () => onRunTask(task.kind) }] : []),
    ...(task && canCleanup ? [{ label: task.jobFilesCleaned && task.frameCacheCleaned ? "已清理" : "清理工作文件", icon: <Trash2 aria-hidden="true" />, disabled: taskBusy, onSelect: onOpenCleanup }] : []),
    ...(task ? [{ label: "运行日志", icon: <ScrollText aria-hidden="true" />, onSelect: openLogs }] : []),
  ];

  return (
    <section className={`task-dock ${task ? `status-${task.status}` : "status-idle"}`} aria-label="任务状态" aria-live="polite">
      {pageError && <div className="page-error">
        <AlertCircle aria-hidden="true" />
        <Tooltip content={formatSerializedError(pageError)}><span tabIndex={0}><strong>{pageError.code}</strong>{formatSerializedError(pageError)}</span></Tooltip>
        <Tooltip content="关闭错误"><button className="icon-button" type="button" aria-label="关闭错误" onClick={onClosePageError}><X aria-hidden="true" /></button></Tooltip>
      </div>}

      {!task ? <div className="idle-task">
        {doctorError ? <AlertCircle aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
        <span>{doctorError ? `工具检测失败：${doctorError.message}` : "先快速检查三个循环接缝，再按需生成最终效果预览。"}</span>
        <button className="button ghost" type="button" onClick={onOpenTools}><Wrench aria-hidden="true" />查看工具</button>
        <TaskOverflowMenu items={overflowItems} />
      </div> : <>
        <div className="task-status-region">
          <div className="task-icon">
            {task.status === "complete" ? <Check aria-hidden="true" /> : task.status === "error" ? <AlertCircle aria-hidden="true" /> : task.status === "cancelled" ? <Square aria-hidden="true" /> : <LoaderCircle className="spin" aria-hidden="true" />}
          </div>
          <div className="task-status-copy">
            <strong>{task.status === "complete" ? completeTitle(task.kind) : task.status === "error" ? "任务失败" : task.status === "cancelled" ? "已取消" : task.progress?.phase === "verify" ? "正在验证" : task.kind === "preview" ? "正在生成最终效果预览" : task.kind === "loop-preview" ? "正在快速检查循环" : task.kind === "diagnostic-preview" ? "正在生成四方案诊断" : "正在处理壁纸视频"}</strong>
            {task.status === "error" && task.error ? <Tooltip content={formatSerializedError(task.error)}><span className="task-error" tabIndex={0}>{task.error.message}</span></Tooltip>
              : task.status === "cancelled" ? <span>保留的缓存可用于再次运行</span>
                : task.status === "complete" && outputPath ? <Tooltip content={outputPath}><span className="result-path" tabIndex={0}>{outputPath}</span></Tooltip>
                  : <span>{task.progress ? translateTaskMessage(task.progress.message) : "正在启动处理核心"}</span>}
          </div>
        </div>

        <div className="task-middle-region">
          <div className="task-progress-copy">
            {task.status === "complete" && !showCompletionTrack ? <span className="verified-state"><Check aria-hidden="true" />已验证</span> : <>
              <strong>{progressLabel}</strong>
              <span className="numeric-data">{percent.toFixed(Number.isInteger(percent) ? 0 : 1)}%</span>
              {running && <span className="eta-block"><Clock3 aria-hidden="true" />{formatEta(task.progress?.etaMs ?? null)}</span>}
            </>}
          </div>
          <div className={`progress-track${showTrack ? " is-visible" : ""}`} aria-hidden={!showTrack} aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} role="progressbar">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="task-context-actions">
            {taskBusy ? <button className="button danger-outline" type="button" onClick={onCancelTask} disabled={task.id === "pending"}><Square aria-hidden="true" />取消</button>
              : <button className="button secondary overflowable-action" type="button" onClick={() => onRunTask(task.kind)} disabled={!canStart}><RotateCcw aria-hidden="true" />再次运行</button>}
            {canCleanup && <button className="button ghost overflowable-action" type="button" onClick={onOpenCleanup} disabled={taskBusy}><Trash2 aria-hidden="true" />{task.jobFilesCleaned && task.frameCacheCleaned ? "已清理" : "清理..."}</button>}
            {task.status === "complete" && task.kind === "process" && outputPath && <button className="button secondary" type="button" onClick={() => onOpenOutput(outputPath)}><FolderOpen aria-hidden="true" />打开输出位置</button>}
            <details className="log-details overflowable-action" ref={logDetailsRef}>
              <summary><ScrollText aria-hidden="true" />运行日志</summary>
              <pre tabIndex={0}>{task.logs.length > 0 ? task.logs.join("\n") : "等待日志..."}</pre>
            </details>
            {overflowItems.length > 0 && <TaskOverflowMenu items={overflowItems} />}
          </div>
        </div>
      </>}

      <div className="dock-actions" aria-label="处理操作">
        <Tooltip content="跳过 AI，快速比较三个循环接缝"><button className="button secondary action-button" type="button" aria-label="快速检查循环" disabled={!canStart} onClick={() => onRunTask("loop-preview")}>
          {taskBusy && task?.kind === "loop-preview" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}<span className="action-label">{taskBusy && task?.kind === "loop-preview" ? "正在检查" : "快速检查循环"}</span>
        </button></Tooltip>
        <Tooltip content="按最终成片的完整配置处理当前检查点"><button className="button secondary action-button" type="button" aria-label="最终效果预览" disabled={!canStart} onClick={() => onRunTask("preview")}>
          {taskBusy && task?.kind === "preview" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}<span className="action-label">{taskBusy && task?.kind === "preview" ? "正在生成" : "最终效果预览"}</span>
        </button></Tooltip>
        <button className="button primary action-button" type="button" disabled={!canStart} onClick={() => onRunTask("process")}>
          {taskBusy && task?.kind === "process" ? <LoaderCircle className="spin" aria-hidden="true" /> : task?.status === "complete" && task.kind === "process" ? <Check aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
          {taskBusy && task?.kind === "process" ? "正在处理" : task?.status === "complete" && task.kind === "process" ? "处理完成" : "开始处理"}
        </button>
      </div>
    </section>
  );
}
