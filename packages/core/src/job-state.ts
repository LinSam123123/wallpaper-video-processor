import { randomUUID } from "node:crypto";
import { access, copyFile, link, mkdir, readFile, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AppError } from "./errors.js";
import { cacheKey } from "./pure.js";
import type { NormalizedJobSpec, ProgressPhase, SpaceBudget } from "./types.js";
import type { SerializedAppError } from "./errors.js";
import type { FrameRiskAnalysis } from "./frame-risk.js";

export interface InputFingerprint {
  path: string;
  size: number;
  modifiedMs: number;
}

export interface JobState {
  schemaVersion: 1;
  jobId: string;
  specHash: string;
  input: InputFingerprint;
  phase: ProgressPhase;
  createdAt: string;
  updatedAt: string;
  sourceFrameCount: number;
  completedInterpolationFrames?: number[];
  detectedSceneCuts?: number[];
  frameRiskAnalysis?: FrameRiskAnalysis;
  frameRiskRange?: { startFrame: number; endFrameExclusive: number };
  completedUpscaleFrames: number[];
  selectedTile: number | null;
  outputFrameCount: number;
  outputPath: string;
  spec?: NormalizedJobSpec;
  frameCacheKey?: string;
  actualAiScale?: number;
  spaceBudget?: SpaceBudget;
  verifiedOutput?: {
    outputPath: string;
    size: number;
    modifiedMs: number;
    frameCount: number;
    sha256: string;
  };
  lastError?: SerializedAppError | null;
}

export async function fingerprintInput(path: string): Promise<InputFingerprint> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    return { path: resolve(path), size: info.size, modifiedMs: Math.round(info.mtimeMs) };
  } catch (error) {
    throw new AppError("E_INPUT_NOT_FOUND", `Input video does not exist: ${resolve(path)}`, undefined, { cause: error });
  }
}

export function jobSpecIdentity(spec: NormalizedJobSpec): unknown {
  if (spec.version === 1 && spec.interpolation.mode === "none") {
    const { interpolation: _interpolation, ...legacy } = spec;
    return legacy;
  }
  return spec;
}

export function createJobId(spec: NormalizedJobSpec, fingerprint: InputFingerprint): string {
  return cacheKey({ spec: jobSpecIdentity(spec), input: fingerprint }).slice(0, 20);
}

export function stateFilePath(jobDirectory: string): string {
  return join(jobDirectory, "job-state.json");
}

export async function loadJobState(jobDirectory: string): Promise<JobState | null> {
  try {
    const parsed = JSON.parse(await readFile(stateFilePath(jobDirectory), "utf8")) as JobState;
    if (parsed.schemaVersion !== 1 || typeof parsed.jobId !== "string" || !Array.isArray(parsed.completedUpscaleFrames)) {
      throw new Error("unsupported state shape");
    }
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new AppError("E_JOB_STATE", `Could not read task state in ${jobDirectory}`, undefined, { cause: error });
  }
}

export async function saveJobState(jobDirectory: string, state: JobState): Promise<void> {
  await mkdir(jobDirectory, { recursive: true });
  const target = stateFilePath(jobDirectory);
  const temporary = `${target}.${randomUUID()}.tmp`;
  state.updatedAt = new Date().toISOString();
  const next = { ...state };
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new AppError("E_JOB_STATE", `Could not save task state in ${jobDirectory}`, undefined, { cause: error });
  }
}

export function cancellationFilePath(jobDirectory: string): string {
  return join(jobDirectory, ".cancel");
}

export async function requestCancellation(jobDirectory: string): Promise<void> {
  await mkdir(jobDirectory, { recursive: true });
  await writeFile(cancellationFilePath(jobDirectory), new Date().toISOString(), "utf8");
}

export async function clearCancellation(jobDirectory: string): Promise<void> {
  await unlink(cancellationFilePath(jobDirectory)).catch(() => undefined);
}

export async function assertNotCancelled(jobDirectory: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new AppError("E_CANCELLED", "Operation cancelled");
  const requested = await access(cancellationFilePath(jobDirectory)).then(() => true, () => false);
  if (requested) throw new AppError("E_CANCELLED", "Operation cancelled");
}

export function frameFileName(zeroBasedIndex: number): string {
  if (!Number.isInteger(zeroBasedIndex) || zeroBasedIndex < 0) throw new RangeError("frame index cannot be negative");
  return `frame_${String(zeroBasedIndex + 1).padStart(8, "0")}.png`;
}

export async function linkOrCopy(source: string, destination: string): Promise<"linked" | "copied" | "existing"> {
  await mkdir(dirname(destination), { recursive: true });
  if (await access(destination).then(() => true, () => false)) return "existing";
  try {
    await link(source, destination);
    return "linked";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(code ?? "")) throw error;
    await copyFile(source, destination);
    return "copied";
  }
}

export async function buildFrameSequence(
  sourceDirectory: string,
  destinationDirectory: string,
  sourceIndices: number[],
  onFrame?: (current: number, total: number) => void,
): Promise<{ linked: number; copied: number; existing: number }> {
  await mkdir(destinationDirectory, { recursive: true });
  const counts = { linked: 0, copied: 0, existing: 0 };
  for (let sequenceIndex = 0; sequenceIndex < sourceIndices.length; sequenceIndex += 1) {
    const sourceIndex = sourceIndices[sequenceIndex];
    if (sourceIndex === undefined) throw new AppError("E_JOB_STATE", "Sequence contains an undefined source frame");
    const result = await linkOrCopy(
      join(sourceDirectory, frameFileName(sourceIndex)),
      join(destinationDirectory, frameFileName(sequenceIndex)),
    );
    counts[result] += 1;
    onFrame?.(sequenceIndex + 1, sourceIndices.length);
  }
  return counts;
}

export async function availableDiskBytes(path: string): Promise<number> {
  const info = await statfs(path, { bigint: true });
  const available = info.bavail * info.bsize;
  return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
}

export async function sameFilesystem(leftPath: string, rightPath: string): Promise<boolean> {
  const [left, right] = await Promise.all([stat(leftPath), stat(rightPath)]);
  return left.dev === right.dev;
}

export async function ensureDiskSpace(
  path: string,
  requiredBytes: number,
  purpose: "work" | "output" | "combined" = "work",
): Promise<void> {
  const available = await availableDiskBytes(path);
  if (available < requiredBytes) {
    throw new AppError("E_INSUFFICIENT_SPACE", `Not enough ${purpose} disk space`, {
      path: resolve(path),
      requiredBytes,
      availableBytes: available,
      purpose,
    });
  }
}
