import { useState, type ReactNode } from "react";
import { createSemanticIcon } from "./SemanticIcon";

const ChevronDown = createSemanticIcon("chevronDown", true);

export function AdvancedSection({ label = "高级设置", children }: { label?: string; children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? "advanced-section is-open" : "advanced-section"}>
      <button className="advanced-toggle" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="minor-section-title">{label}</span><ChevronDown aria-hidden="true" />
      </button>
      <div className="advanced-reveal" aria-hidden={!open} inert={!open}>
        <div>{children}</div>
      </div>
    </div>
  );
}
