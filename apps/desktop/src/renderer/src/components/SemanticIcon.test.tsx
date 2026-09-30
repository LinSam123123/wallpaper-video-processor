import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SEMANTIC_ICON_NAMES } from "../../../shared/appearance-icons";
import { SemanticIcon, SemanticIconProvider } from "./SemanticIcon";

describe("SemanticIcon", () => {
  it("covers every allowed semantic name with a fixed Lucide viewport", () => {
    const { container } = render(<>{SEMANTIC_ICON_NAMES.map((name) => <SemanticIcon name={name} key={name} aria-hidden="true" />)}</>);
    expect(container.querySelectorAll("svg")).toHaveLength(SEMANTIC_ICON_NAMES.length);
    for (const name of SEMANTIC_ICON_NAMES) {
      const icon = container.querySelector(`[data-icon-name="${name}"]`);
      expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
      expect(icon).toHaveAttribute("stroke-width", "1.75");
    }
  });

  it("switches only the shared stroke treatment and safely falls back for custom", () => {
    const { container, rerender } = render(<SemanticIconProvider preset="soft-outline"><SemanticIcon name="settings" /></SemanticIconProvider>);
    expect(container.querySelector("svg")).toHaveAttribute("stroke-width", "2");
    expect(container.querySelector("svg")).toHaveAttribute("data-icon-preset", "soft-outline");

    rerender(<SemanticIconProvider preset="custom"><SemanticIcon name="settings" auxiliary /></SemanticIconProvider>);
    expect(container.querySelector("svg")).toHaveAttribute("stroke-width", "1.75");
    expect(container.querySelector("svg")).toHaveClass("semantic-icon-auxiliary");
  });

  it("renders sanitized custom nodes and falls back per missing semantic", () => {
    const pack = {
      schemaVersion: 1 as const,
      name: "Test Pack",
      version: "1",
      defaultSize: 20,
      warnings: [],
      icons: {
        settings: {
          viewBox: [0, 0, 20, 20] as [number, number, number, number],
          attributes: { fill: "none" as const, stroke: "currentColor" as const },
          nodes: [{ tag: "circle" as const, attributes: { cx: 10, cy: 10, r: 6 }, children: [] }],
          warnings: [],
        },
      },
    };
    const { container } = render(<SemanticIconProvider preset="custom" pack={pack}><SemanticIcon name="settings" /><SemanticIcon name="play" /></SemanticIconProvider>);
    const custom = container.querySelector('[data-icon-name="settings"]');
    expect(custom).toHaveAttribute("data-icon-source", "sanitized-pack");
    expect(custom).toHaveAttribute("viewBox", "0 0 20 20");
    expect(custom?.querySelector("circle")).toHaveAttribute("r", "6");
    const fallback = container.querySelector('[data-icon-name="play"]');
    expect(fallback).toHaveAttribute("data-icon-preset", "fine-outline");
    expect(fallback).not.toHaveAttribute("data-icon-source");
  });

  it("resolves individual vector and PNG overrides before a pack", () => {
    const pack = {
      schemaVersion: 1 as const, name: "Pack", version: "1", defaultSize: 20, warnings: [],
      icons: { settings: { viewBox: [0, 0, 24, 24] as [number, number, number, number], attributes: {}, nodes: [{ tag: "circle" as const, attributes: { r: 4 }, children: [] }], warnings: [] } },
    };
    const overrides = {
      settings: { id: "icon-vector", kind: "vector" as const, icon: { viewBox: [0, 0, 24, 24] as [number, number, number, number], attributes: {}, nodes: [{ tag: "rect" as const, attributes: { width: 12, height: 12 }, children: [] }], warnings: [] } },
      appLogo: { id: "icon-png", kind: "png" as const, url: "blob:logo", width: 32, height: 32 },
    };
    const { container } = render(<SemanticIconProvider preset="custom" pack={pack} overrides={overrides}><SemanticIcon name="settings" /><SemanticIcon name="appLogo" /></SemanticIconProvider>);
    expect(container.querySelector('[data-icon-name="settings"]')).toHaveAttribute("data-icon-source", "sanitized-override");
    expect(container.querySelector('[data-icon-name="settings"] rect')).not.toBeNull();
    expect(container.querySelector('[data-icon-name="settings"] circle')).toBeNull();
    expect(container.querySelector('img[data-icon-name="appLogo"]')).toHaveAttribute("src", "blob:logo");
    expect(container.querySelector('img[data-icon-name="appLogo"]')).toHaveAttribute("data-icon-source", "validated-png-override");
  });
});
