import type { CSSProperties, ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: Array<SegmentedOption<T>>;
  disabled?: boolean;
  onChange(value: T): void;
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <div
      className="segmented"
      role="group"
      aria-label={label}
      style={{ "--segment-count": options.length, "--segment-index": Math.max(0, options.findIndex((option) => option.value === value)) } as CSSProperties}
    >
      <span className="segmented-indicator" aria-hidden="true" />
      {options.map((option) => (
        <button
          className={option.value === value ? "segmented-option is-selected" : "segmented-option"}
          type="button"
          key={option.value}
          aria-pressed={option.value === value}
          disabled={disabled || option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
