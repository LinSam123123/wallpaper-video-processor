import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

export interface TooltipProps {
  content: string;
  children: ReactElement<Record<string, unknown>>;
  delay?: number;
}

export function Tooltip({ content, children, delay = 450 }: TooltipProps): React.JSX.Element {
  const id = `${useId()}-tooltip`;
  const anchorRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, placement: "bottom" as "top" | "bottom" });

  const clearTimer = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const show = (wait: number): void => {
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(true), wait);
  };
  const hide = (): void => {
    clearTimer();
    setOpen(false);
  };
  const updatePosition = (): void => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const placement = rect.bottom + 48 < window.innerHeight ? "bottom" : "top";
    const halfWidth = (tooltipRef.current?.getBoundingClientRect().width ?? 0) / 2;
    const preferredLeft = rect.left + rect.width / 2;
    const left = halfWidth > 0 ? Math.min(window.innerWidth - halfWidth - 8, Math.max(halfWidth + 8, preferredLeft)) : preferredLeft;
    setPosition({ left, top: placement === "bottom" ? rect.bottom + 8 : rect.top - 8, placement });
  };

  useEffect(() => () => clearTimer(), []);
  useLayoutEffect(() => { if (open) updatePosition(); }, [open, content]);
  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => { if (event.key === "Escape") hide(); };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!isValidElement(children)) return children;
  const childProps = children.props as Record<string, unknown>;
  const setAnchor = (node: HTMLElement | null): void => {
    anchorRef.current = node;
    const ref = childProps.ref;
    if (typeof ref === "function") ref(node);
    else if (ref && typeof ref === "object" && "current" in ref) (ref as { current: HTMLElement | null }).current = node;
  };

  return (
    <>
      {cloneElement(children, {
        ref: setAnchor,
        "aria-describedby": open ? id : childProps["aria-describedby"],
        onMouseEnter: (event: MouseEvent) => { (childProps.onMouseEnter as ((event: MouseEvent) => void) | undefined)?.(event); show(delay); },
        onMouseLeave: (event: MouseEvent) => { (childProps.onMouseLeave as ((event: MouseEvent) => void) | undefined)?.(event); hide(); },
        onFocus: (event: FocusEvent) => { (childProps.onFocus as ((event: FocusEvent) => void) | undefined)?.(event); show(0); },
        onBlur: (event: FocusEvent) => { (childProps.onBlur as ((event: FocusEvent) => void) | undefined)?.(event); hide(); },
      })}
      {open && createPortal(
        <div
          ref={tooltipRef}
          id={id}
          role="tooltip"
          className={`tooltip-layer placement-${position.placement}`}
          style={{ left: position.left, top: position.top }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
