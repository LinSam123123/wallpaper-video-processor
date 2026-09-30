import { AppError, type LoopMode, type LoopTurn, type PreviewMode } from "@wallpaper-video/core";

export interface ParsedArguments {
  command: string | null;
  flags: Map<string, string | true>;
}

export interface PreviewCliOptions {
  centerSeconds?: number;
  frameCount?: number;
  previewMode?: PreviewMode;
  turn?: LoopTurn;
}

export function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
  const flags = new Map<string, string | true>();
  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) throw new AppError("E_INVALID_ARGUMENT", `Unexpected argument: ${String(token)}`);
    const equals = token.indexOf("=");
    if (equals > 2) {
      flags.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

export function requiredFlag(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("E_INVALID_ARGUMENT", `--${name} is required`);
  }
  return value;
}

export function optionalStringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("E_INVALID_ARGUMENT", `--${name} requires a value`);
  }
  return value;
}

export function optionalNumberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new AppError("E_INVALID_ARGUMENT", `--${name} requires a value`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new AppError("E_INVALID_ARGUMENT", `--${name} must be a number`);
  return parsed;
}

export function previewOptionsFromFlags(
  flags: Map<string, string | true>,
  loopMode: LoopMode,
): PreviewCliOptions {
  const rawPreviewMode = optionalStringFlag(flags, "preview-mode");
  if (rawPreviewMode !== undefined && rawPreviewMode !== "segment" && rawPreviewMode !== "loop-boundary") {
    throw new AppError("E_INVALID_ARGUMENT", "--preview-mode must be segment or loop-boundary");
  }
  const rawTurn = optionalStringFlag(flags, "turn");
  if (rawTurn !== undefined && rawTurn !== "start" && rawTurn !== "end") {
    throw new AppError("E_INVALID_ARGUMENT", "--turn must be start or end");
  }

  const centerSeconds = optionalNumberFlag(flags, "center");
  const frameCount = optionalNumberFlag(flags, "frames");
  const previewMode = rawPreviewMode ?? "segment";
  if (previewMode === "loop-boundary" && centerSeconds !== undefined) {
    throw new AppError("E_INVALID_ARGUMENT", "--center cannot be used with --preview-mode loop-boundary");
  }
  if (rawTurn !== undefined && (previewMode !== "loop-boundary" || loopMode !== "pingpong")) {
    throw new AppError(
      "E_INVALID_ARGUMENT",
      "--turn requires --preview-mode loop-boundary with a pingpong job",
    );
  }

  return {
    ...(centerSeconds === undefined ? {} : { centerSeconds }),
    ...(frameCount === undefined ? {} : { frameCount }),
    ...(rawPreviewMode === undefined ? {} : { previewMode: rawPreviewMode }),
    ...(rawTurn === undefined ? {} : { turn: rawTurn }),
  };
}
