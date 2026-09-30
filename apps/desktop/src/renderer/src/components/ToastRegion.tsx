import { Tooltip } from "./Tooltip";
import { createSemanticIcon } from "./SemanticIcon";

const AlertCircle = createSemanticIcon("warning");
const CheckCircle2 = createSemanticIcon("success");
const Copy = createSemanticIcon("copy");
const Info = createSemanticIcon("info");
const ScrollText = createSemanticIcon("logs");
const TriangleAlert = createSemanticIcon("warning");
const X = createSemanticIcon("close");

export type ToastKind = "success" | "error" | "warning" | "info";

export interface ToastMessage {
  id: string;
  dedupeKey?: string;
  kind: ToastKind;
  title: string;
  message?: string;
  copyText?: string;
  showLogs?: boolean;
}

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: TriangleAlert,
  info: Info,
};

export function ToastRegion({
  toasts,
  onDismiss,
  onCopy,
  onShowLogs,
}: {
  toasts: ToastMessage[];
  onDismiss(id: string): void;
  onCopy(text: string): void;
  onShowLogs(): void;
}): React.JSX.Element {
  return (
    <div className="toast-region" aria-live="polite" aria-relevant="additions removals">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind];
        return (
          <div className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"} key={toast.id}>
            <Icon aria-hidden="true" />
            <div className="toast-copy">
              <strong>{toast.title}</strong>
              {toast.message && <span>{toast.message}</span>}
              {(toast.copyText || toast.showLogs) && (
                <div className="toast-actions">
                  {toast.copyText && <button type="button" onClick={() => onCopy(toast.copyText!)}><Copy aria-hidden="true" />复制详情</button>}
                  {toast.showLogs && <button type="button" onClick={onShowLogs}><ScrollText aria-hidden="true" />查看日志</button>}
                </div>
              )}
            </div>
            <Tooltip content="关闭通知"><button className="toast-close" type="button" aria-label="关闭通知" onClick={() => onDismiss(toast.id)}><X aria-hidden="true" /></button></Tooltip>
          </div>
        );
      })}
    </div>
  );
}
