import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip";

export interface SwitchProps {
  checked: boolean;
  label: string;
  onChange(checked: boolean): void;
  disabled?: boolean;
  icon?: ReactNode;
  tooltip?: string;
}

export function Switch({ checked, label, onChange, disabled = false, icon, tooltip }: SwitchProps): React.JSX.Element {
  const control = (
    <button
      className="switch-control"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {icon}
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      <span className="switch-label">{label}</span>
    </button>
  );

  return tooltip ? <Tooltip content={tooltip}>{control}</Tooltip> : control;
}
