import type { ReactNode } from "react";

export interface MetadataItem {
  content: ReactNode | null | undefined | false;
  key: string;
  priority?: "key" | "secondary";
}

interface MetadataRowProps {
  items: MetadataItem[];
  empty?: ReactNode;
  className?: string;
  icon?: ReactNode;
  label?: string;
}

export function MetadataRow({ items, empty, className, icon, label }: MetadataRowProps): React.JSX.Element {
  const visibleItems = items.filter((item) => item.content !== null && item.content !== undefined && item.content !== false && item.content !== "");

  return (
    <div className={["metadata-row", className ?? ""].filter(Boolean).join(" ")} aria-live="polite">
      {label && <span className="metadata-label">{icon}{label}</span>}
      {visibleItems.length > 0
        ? <span className="metadata-values">{visibleItems.map((item) => <span key={item.key} className={`metadata-item priority-${item.priority ?? "secondary"}`}>{item.content}</span>)}</span>
        : <span className="metadata-empty">{empty}</span>}
    </div>
  );
}
