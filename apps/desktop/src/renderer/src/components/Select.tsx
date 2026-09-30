import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { createSemanticIcon } from "./SemanticIcon";

const Check = createSemanticIcon("confirm");
const ChevronDown = createSemanticIcon("chevronDown", true);

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
}

export interface SelectProps<T extends string> {
  id: string;
  value: T;
  options: Array<SelectOption<T>>;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  onChange(value: T): void;
}

interface LayerPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
}

const VIEWPORT_GAP = 8;
const TRIGGER_GAP = 6;
const MAX_HEIGHT = 280;

export function Select<T extends string>({
  id,
  value,
  options,
  disabled = false,
  ariaLabel,
  className,
  onChange,
}: SelectProps<T>): React.JSX.Element {
  const listboxId = `${useId()}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [closing, setClosing] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [position, setPosition] = useState<LayerPosition | null>(null);
  const selected = options[selectedIndex];

  const firstEnabled = (): number => options.findIndex((option) => !option.disabled);
  const lastEnabled = (): number => {
    for (let index = options.length - 1; index >= 0; index -= 1) if (!options[index]?.disabled) return index;
    return -1;
  };
  const nextEnabled = (from: number, direction: 1 | -1): number => {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (from + direction * offset + options.length) % options.length;
      if (!options[index]?.disabled) return index;
    }
    return from;
  };

  const updatePosition = (): void => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - TRIGGER_GAP - VIEWPORT_GAP;
    const above = rect.top - TRIGGER_GAP - VIEWPORT_GAP;
    const placement = below >= Math.min(MAX_HEIGHT, 160) || below >= above ? "bottom" : "top";
    const maxHeight = Math.max(76, Math.min(MAX_HEIGHT, placement === "bottom" ? below : above));
    const width = Math.min(Math.max(rect.width, 160), window.innerWidth - VIEWPORT_GAP * 2);
    const left = Math.min(Math.max(VIEWPORT_GAP, rect.left), window.innerWidth - width - VIEWPORT_GAP);
    setPosition({
      left,
      top: placement === "bottom" ? rect.bottom + TRIGGER_GAP : rect.top - TRIGGER_GAP,
      width,
      maxHeight,
      placement,
    });
  };

  const open = (): void => {
    if (disabled || options.length === 0) return;
    setActiveIndex(options[selectedIndex]?.disabled ? firstEnabled() : selectedIndex);
    setClosing(false);
    setRendered(true);
  };

  const close = (restoreFocus = true): void => {
    if (!rendered || closing) return;
    setClosing(true);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const choose = (index: number): void => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
  };

  useLayoutEffect(() => {
    if (!rendered) return;
    updatePosition();
    const update = (): void => updatePosition();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [rendered]);

  useEffect(() => {
    if (!rendered) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !layerRef.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [rendered, closing]);

  useEffect(() => {
    if (!closing) return;
    const timeout = window.setTimeout(() => {
      setRendered(false);
      setClosing(false);
      setPosition(null);
    }, 160);
    return () => window.clearTimeout(timeout);
  }, [closing]);

  useEffect(() => {
    if (!rendered) return;
    const option = document.getElementById(`${listboxId}-option-${activeIndex}`);
    if (typeof option?.scrollIntoView === "function") option.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listboxId, rendered]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement | HTMLDivElement>): void => {
    if (!rendered) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        open();
      }
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      close(event.key === "Escape");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => nextEnabled(current, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? firstEnabled() : lastEnabled());
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
    }
  };

  const layerStyle = position ? {
    left: position.left,
    top: position.top,
    width: position.width,
    maxHeight: position.maxHeight,
    ...(position.placement === "top" ? { transform: "translateY(-100%)" } : {}),
  } satisfies CSSProperties : undefined;

  return (
    <>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className={["select-trigger", rendered && !closing ? "is-open" : "", className ?? ""].filter(Boolean).join(" ")}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={rendered && !closing}
        aria-controls={rendered ? listboxId : undefined}
        aria-activedescendant={rendered && !closing ? `${listboxId}-option-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => rendered ? (closing ? open() : close()) : open()}
        onKeyDown={handleKeyDown}
      >
        <span className="select-value">{selected?.icon}{selected?.label ?? ""}</span>
        <ChevronDown className="select-chevron" aria-hidden="true" />
      </button>
      {rendered && createPortal(
        <div
          ref={layerRef}
          className={`select-popover placement-${position?.placement ?? "bottom"}${position ? " is-positioned" : ""}${closing ? " is-closing" : ""}`}
          aria-hidden={closing || undefined}
          style={layerStyle}
          onAnimationEnd={(event) => {
            if (event.currentTarget === event.target && closing) {
              setRendered(false);
              setClosing(false);
              setPosition(null);
            }
          }}
          onKeyDown={handleKeyDown}
        >
          <div
            id={listboxId}
            className="select-listbox"
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={`${listboxId}-option-${activeIndex}`}
          >
            {options.map((option, index) => (
              <button
                id={`${listboxId}-option-${index}`}
                key={option.value}
                type="button"
                role="option"
                className={`select-option${index === activeIndex ? " is-active" : ""}${option.value === value ? " is-selected" : ""}`}
                aria-selected={option.value === value}
                disabled={option.disabled}
                onPointerMove={() => { if (!option.disabled) setActiveIndex(index); }}
                onClick={() => choose(index)}
              >
                <span>{option.icon}{option.label}</span>
                {option.value === value && <Check aria-hidden="true" />}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
