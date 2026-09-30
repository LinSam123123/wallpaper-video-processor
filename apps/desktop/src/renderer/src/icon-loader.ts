import type { IconOverrideMetadata, SafeVectorIcon } from "../../shared/contracts";
import type { SemanticIconName } from "../../shared/appearance-icons";

export type RendererIconOverride =
  | { id: string; kind: "vector"; icon: SafeVectorIcon }
  | { id: string; kind: "png"; url: string; width: number; height: number };

const loadedOverrides = new Map<string, Promise<RendererIconOverride>>();

export async function loadIconOverride(metadata: IconOverrideMetadata): Promise<RendererIconOverride> {
  const cached = loadedOverrides.get(metadata.id);
  if (cached) return await cached;
  const loading = (async (): Promise<RendererIconOverride> => {
    const resource = await window.wallpaperApi.readIconOverrideResource(metadata.id);
    if (resource.kind === "vector") return { id: metadata.id, kind: "vector", icon: resource.icon };
    const bytes = new Uint8Array(resource.data).slice();
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    return { id: metadata.id, kind: "png", url, width: resource.width, height: resource.height };
  })();
  loadedOverrides.set(metadata.id, loading);
  try {
    return await loading;
  } catch (error) {
    loadedOverrides.delete(metadata.id);
    throw error;
  }
}

export async function loadIconOverrides(
  configured: Partial<Record<SemanticIconName, string>>,
  catalog: IconOverrideMetadata[],
): Promise<{ overrides: Partial<Record<SemanticIconName, RendererIconOverride>>; missing: SemanticIconName[]; failed: SemanticIconName[] }> {
  const overrides: Partial<Record<SemanticIconName, RendererIconOverride>> = {};
  const missing: SemanticIconName[] = [];
  const failed: SemanticIconName[] = [];
  await Promise.all(Object.entries(configured).map(async ([rawName, id]) => {
    const name = rawName as SemanticIconName;
    const metadata = catalog.find((entry) => entry.id === id && entry.semanticName === name);
    if (!metadata) { missing.push(name); return; }
    try { overrides[name] = await loadIconOverride(metadata); } catch { failed.push(name); }
  }));
  return { overrides, missing, failed };
}

export function releaseIconOverride(id: string): void {
  const cached = loadedOverrides.get(id);
  if (cached) void cached.then((resource) => { if (resource.kind === "png") URL.revokeObjectURL(resource.url); }).catch(() => undefined);
  loadedOverrides.delete(id);
}
