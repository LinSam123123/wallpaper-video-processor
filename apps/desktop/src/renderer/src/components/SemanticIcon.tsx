import {
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Copy,
  Cpu,
  Crop,
  Database,
  Download,
  ExternalLink,
  FileClock,
  FileVideo,
  FolderOpen,
  Gauge,
  HardDrive,
  Import,
  Info,
  Laptop,
  LoaderCircle,
  Maximize2,
  Ellipsis,
  Monitor,
  Moon,
  Palette,
  PanelTop,
  Play,
  RotateCcw,
  Save,
  ScanLine,
  ScrollText,
  Settings2,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Type,
  UploadCloud,
  WandSparkles,
  Wrench,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import { createContext, createElement, useContext, type ComponentType, type SVGProps } from "react";
import type { SemanticIconName } from "../../../shared/appearance-icons";
import type { SafeVectorNode, SanitizedIconPack } from "../../../shared/contracts";
import type { IconPreset } from "../appearance";
import type { RendererIconOverride } from "../icon-loader";

const BUILTIN_ICONS = {
  appLogo: WandSparkles,
  emptyState: UploadCloud,
  warning: AlertCircle,
  success: CheckCircle2,
  info: Info,
  confirm: Check,
  close: X,
  settings: Settings2,
  tools: Wrench,
  themeLight: Sun,
  themeDark: Moon,
  themeSystem: Laptop,
  palette: Palette,
  typography: Type,
  editorial: BookOpen,
  importResource: Import,
  download: Download,
  externalLink: ExternalLink,
  delete: Trash2,
  reset: RotateCcw,
  copy: Copy,
  logs: ScrollText,
  more: Ellipsis,
  chevronDown: ChevronDown,
  sourceVideo: FileVideo,
  processedVideo: Sparkles,
  diagnostic: ScanLine,
  display: Monitor,
  openFolder: FolderOpen,
  workDirectory: HardDrive,
  saveOutput: Save,
  upload: UploadCloud,
  play: Play,
  stop: Square,
  loading: LoaderCircle,
  clock: Clock3,
  blurBackground: PanelTop,
  crop: Crop,
  contain: Maximize2,
  cpu: Cpu,
  performance: Gauge,
  database: Database,
  cachedFile: FileClock,
} satisfies Record<SemanticIconName, LucideIcon>;

interface SemanticIconContextValue {
  preset: IconPreset;
  pack: SanitizedIconPack | null;
  overrides: Partial<Record<SemanticIconName, RendererIconOverride>>;
}

const SemanticIconContext = createContext<SemanticIconContextValue>({ preset: "fine-outline", pack: null, overrides: {} });

export function SemanticIconProvider({ preset, pack = null, overrides = {}, children }: { preset: IconPreset; pack?: SanitizedIconPack | null; overrides?: Partial<Record<SemanticIconName, RendererIconOverride>>; children: React.ReactNode }): React.JSX.Element {
  return <SemanticIconContext.Provider value={{ preset, pack, overrides }}>{children}</SemanticIconContext.Provider>;
}

export interface SemanticIconProps extends Omit<LucideProps, "ref"> {
  name: SemanticIconName;
  auxiliary?: boolean;
}

function renderSafeNode(node: SafeVectorNode, key: string): React.ReactNode {
  return createElement(node.tag, { ...node.attributes, key }, node.children.map((child, index) => renderSafeNode(child, `${key}-${index}`)));
}

function renderSafeVector(name: SemanticIconName, icon: NonNullable<SanitizedIconPack["icons"][SemanticIconName]>, source: "sanitized-pack" | "sanitized-override", auxiliary: boolean, className: string | undefined, props: Omit<LucideProps, "ref">): React.JSX.Element {
  const rootAttributes = icon.attributes as unknown as SVGProps<SVGSVGElement>;
  const svgProps: SVGProps<SVGSVGElement> = {
    ...rootAttributes,
    ...props,
    className: ["semantic-icon", auxiliary ? "semantic-icon-auxiliary" : "", className ?? ""].filter(Boolean).join(" "),
    viewBox: icon.viewBox.join(" "),
    fill: typeof icon.attributes.fill === "string" ? icon.attributes.fill : "none",
    stroke: typeof icon.attributes.stroke === "string" ? icon.attributes.stroke : "currentColor",
    width: props.width ?? 24,
    height: props.height ?? 24,
  };
  return <svg {...svgProps} data-icon-name={name} data-icon-preset="custom" data-icon-source={source}>{icon.nodes.map((node, index) => renderSafeNode(node, `${name}-${index}`))}</svg>;
}

export function SemanticIcon({ name, auxiliary = false, className, ...props }: SemanticIconProps): React.JSX.Element {
  const { preset, pack, overrides } = useContext(SemanticIconContext);
  const Icon = BUILTIN_ICONS[name];
  const override = overrides[name];
  if (override?.kind === "vector") return renderSafeVector(name, override.icon, "sanitized-override", auxiliary, className, props);
  if (override?.kind === "png") {
    return <img
      className={["semantic-icon", "semantic-icon-image", auxiliary ? "semantic-icon-auxiliary" : "", className ?? ""].filter(Boolean).join(" ")}
      src={override.url}
      width={props.width ?? 24}
      height={props.height ?? 24}
      aria-hidden={props["aria-hidden"]}
      data-icon-name={name}
      data-icon-preset="custom"
      data-icon-source="validated-png-override"
    />;
  }
  const custom = preset === "custom" ? pack?.icons[name] : undefined;
  if (custom) return renderSafeVector(name, custom, "sanitized-pack", auxiliary, className, props);
  const effectivePreset = preset === "soft-outline" ? "soft-outline" : "fine-outline";
  return <Icon
    {...props}
    className={["semantic-icon", auxiliary ? "semantic-icon-auxiliary" : "", className ?? ""].filter(Boolean).join(" ")}
    data-icon-name={name}
    data-icon-preset={effectivePreset}
    strokeWidth={effectivePreset === "soft-outline" ? 2 : 1.75}
  />;
}

export function createSemanticIcon(name: SemanticIconName, auxiliary = false): ComponentType<Omit<SemanticIconProps, "name" | "auxiliary">> {
  return function BoundSemanticIcon(props): React.JSX.Element {
    return <SemanticIcon {...props} name={name} auxiliary={auxiliary} />;
  };
}
