import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";
import type {
  JobSpec,
  LoopTurn,
  MediaInfo,
  PreviewMode,
  ProgressEvent,
  SerializedError,
  TaskEvent,
  TaskKind,
} from "../shared/contracts.js";

interface RunningTask {
  child: ChildProcessWithoutNullStreams;
  kind: TaskKind;
  configPath: string;
  cancelled: boolean;
}

type TaskSink = (event: TaskEvent) => void;

type KillableChild = Pick<ChildProcessWithoutNullStreams, "pid" | "kill">;
type ProcessSpawner = typeof spawn;

function fallbackTerminate(child: KillableChild): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may already have exited between the UI click and termination.
  }
}

export function terminateProcessTree(
  child: KillableChild,
  options: { platform?: NodeJS.Platform; spawnProcess?: ProcessSpawner; environment?: NodeJS.ProcessEnv } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !child.pid) {
    fallbackTerminate(child);
    return;
  }

  const environment = options.environment ?? process.env;
  const systemRoot = environment.SystemRoot && win32.isAbsolute(environment.SystemRoot)
    ? environment.SystemRoot
    : "C:\\Windows";
  const executable = win32.join(systemRoot, "System32", "taskkill.exe");
  const spawnProcess = options.spawnProcess ?? spawn;
  let fallbackIssued = false;
  const fallback = (): void => {
    if (fallbackIssued) return;
    fallbackIssued = true;
    fallbackTerminate(child);
  };

  try {
    const killer = spawnProcess(executable, ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", fallback);
    killer.once("close", (code) => { if (code !== 0) fallback(); });
    killer.unref();
  } catch {
    fallback();
  }
}

export function buildTaskArguments(options: {
  kind: TaskKind;
  configPath: string;
  previewOutputPath?: string;
  centerSeconds?: number;
  previewMode?: PreviewMode;
  turn?: LoopTurn;
  workDirectory?: string;
  diagnosticOutputDirectory?: string;
  loopPreviewOutputDirectory?: string;
  cachePolicy?: "cleanup-on-success" | "keep-24-hours" | "keep-all";
  cacheLimitBytes?: number;
}): string[] {
  const args = [options.kind, "--config", options.configPath, "--json"];
  if (options.workDirectory?.trim()) args.push("--work-dir", resolve(options.workDirectory));
  if (options.cachePolicy) args.push("--cache-policy", options.cachePolicy);
  if (options.cacheLimitBytes !== undefined) args.push("--cache-limit-bytes", String(options.cacheLimitBytes));
  if (options.kind === "preview") {
    if (!options.previewOutputPath) throw new Error("previewOutputPath is required for preview tasks");
    args.push("--output", options.previewOutputPath);
    if (options.previewMode !== undefined) args.push("--preview-mode", options.previewMode);
    if (options.turn !== undefined) args.push("--turn", options.turn);
    if (options.centerSeconds !== undefined) args.push("--center", String(options.centerSeconds));
  }
  if (options.kind === "diagnostic-preview") {
    if (!options.diagnosticOutputDirectory) throw new Error("diagnosticOutputDirectory is required for diagnostic preview tasks");
    args.push("--output-dir", options.diagnosticOutputDirectory);
    if (options.previewMode !== undefined) args.push("--preview-mode", options.previewMode);
    if (options.turn !== undefined) args.push("--turn", options.turn);
    if (options.centerSeconds !== undefined) args.push("--center", String(options.centerSeconds));
  }
  if (options.kind === "loop-preview") {
    if (!options.loopPreviewOutputDirectory) throw new Error("loopPreviewOutputDirectory is required for loop preview tasks");
    args.push("--output-dir", options.loopPreviewOutputDirectory);
  }
  return args;
}

function lines(buffer: string, chunk: string): { complete: string[]; pending: string } {
  const split = (buffer + chunk).split(/\r?\n/);
  return { complete: split.slice(0, -1), pending: split.at(-1) ?? "" };
}

function serializedError(value: unknown, fallback = "CLI 执行失败"): SerializedError {
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    if (typeof source.message === "string") {
      return {
        code: typeof source.code === "string" ? source.code : "E_PROCESS_FAILED",
        message: source.message,
        ...(source.details === undefined ? {} : { details: source.details }),
      };
    }
  }
  return { code: "E_PROCESS_FAILED", message: fallback };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function isProgress(value: unknown): value is ProgressEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.jobId === "string" && typeof record.phase === "string" && typeof record.percent === "number";
}

async function firstExisting(paths: string[]): Promise<string> {
  for (const path of paths) {
    if (await access(path).then(() => true, () => false)) return path;
  }
  throw Object.assign(new Error("尚未构建处理核心，请先运行 CLI build"), {
    code: "E_DEPENDENCY_MISSING",
    details: { searched: paths },
  });
}

export class CliBridge {
  readonly #cacheDirectory: string;
  readonly #entryCandidates: string[];
  readonly #tasks = new Map<string, RunningTask>();

  constructor(options: { cacheDirectory: string; entryCandidates: string[] }) {
    this.#cacheDirectory = options.cacheDirectory;
    this.#entryCandidates = options.entryCandidates;
  }

  async #entry(): Promise<string> {
    return await firstExisting(this.#entryCandidates);
  }

  async #spawn(args: string[]): Promise<ChildProcessWithoutNullStreams> {
    const entry = await this.#entry();
    const executable = process.env.AI_VIDEO_WALLPAPER_NODE ?? process.execPath;
    const child = spawn(executable, [entry, ...args, "--cache", this.#cacheDirectory], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: executable === process.execPath ? "1" : process.env.ELECTRON_RUN_AS_NODE,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    return child;
  }

  async runJson<T>(args: string[]): Promise<T> {
    const child = await this.#spawn([...args, "--json"]);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    return await new Promise<T>((resolvePromise, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        const stdoutLines = stdout.trim().split(/\r?\n/).filter(Boolean);
        if (code === 0) {
          const parsed = parseJson(stdoutLines.at(-1) ?? "");
          if (parsed !== null) resolvePromise(parsed as T);
          else reject(Object.assign(new Error("CLI 返回了无法解析的数据"), { code: "E_PROCESS_FAILED", details: stdout }));
          return;
        }
        const parsedError = parseJson(stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "");
        reject(serializedError(parsedError, stderr.trim() || `CLI 退出码 ${String(code)}`));
      });
    });
  }

  async doctor(): Promise<unknown> {
    return await this.runJson(["doctor"]);
  }

  async inspect(inputPath: string): Promise<MediaInfo> {
    if (!inputPath.trim()) throw Object.assign(new Error("请选择输入视频"), { code: "E_INVALID_ARGUMENT" });
    return await this.runJson<MediaInfo>(["inspect", "--input", resolve(inputPath)]);
  }

  async start(
    kind: TaskKind,
    spec: JobSpec,
    centerSeconds: number | undefined,
    previewMode: PreviewMode | undefined,
    turn: LoopTurn | undefined,
    workDirectory: string | undefined,
    cachePolicy: "cleanup-on-success" | "keep-24-hours" | "keep-all" | undefined,
    cacheLimitBytes: number | undefined,
    sink: TaskSink,
  ): Promise<string> {
    const taskId = randomUUID();
    const requestDirectory = join(this.#cacheDirectory, "desktop-requests");
    await mkdir(requestDirectory, { recursive: true });
    const configPath = join(requestDirectory, `${taskId}.json`);
    await writeFile(configPath, `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

    let child: ChildProcessWithoutNullStreams;
    try {
      let previewOutputPath: string | undefined;
      if (kind === "preview") {
        const previewDirectory = join(this.#cacheDirectory, "desktop-previews");
        await mkdir(previewDirectory, { recursive: true });
        previewOutputPath = join(previewDirectory, `${taskId}.mp4`);
      }
      let diagnosticOutputDirectory: string | undefined;
      if (kind === "diagnostic-preview") {
        diagnosticOutputDirectory = join(this.#cacheDirectory, "desktop-diagnostics", taskId);
        await mkdir(diagnosticOutputDirectory, { recursive: true });
      }
      let loopPreviewOutputDirectory: string | undefined;
      if (kind === "loop-preview") {
        loopPreviewOutputDirectory = join(this.#cacheDirectory, "desktop-loop-previews", taskId);
        await mkdir(loopPreviewOutputDirectory, { recursive: true });
      }
      const args = buildTaskArguments({
        kind,
        configPath,
        ...(previewOutputPath ? { previewOutputPath } : {}),
        ...(centerSeconds === undefined ? {} : { centerSeconds }),
        ...(previewMode === undefined ? {} : { previewMode }),
        ...(turn === undefined ? {} : { turn }),
        ...(workDirectory?.trim() ? { workDirectory } : {}),
        ...(diagnosticOutputDirectory ? { diagnosticOutputDirectory } : {}),
        ...(loopPreviewOutputDirectory ? { loopPreviewOutputDirectory } : {}),
        ...(cachePolicy ? { cachePolicy } : {}),
        ...(cacheLimitBytes === undefined ? {} : { cacheLimitBytes }),
      });
      child = await this.#spawn(args);
    } catch (error) {
      await rm(configPath, { force: true });
      throw error;
    }

    const running: RunningTask = { child, kind, configPath, cancelled: false };
    this.#tasks.set(taskId, running);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdoutPending = "";
    let stderrPending = "";
    let finalResult: Record<string, unknown> | null = null;
    let finalError: SerializedError | null = null;

    const consumeStdout = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parsed = parseJson(trimmed);
      if (isProgress(parsed)) {
        sink({ taskId, kind, type: "progress", progress: parsed });
        return;
      }
      if (parsed && typeof parsed === "object") {
        finalResult = parsed as Record<string, unknown>;
        return;
      }
      sink({ taskId, kind, type: "log", message: trimmed });
    };
    const consumeStderr = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parsed = parseJson(trimmed);
      if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).message === "string") {
        finalError = serializedError(parsed);
      } else {
        sink({ taskId, kind, type: "log", message: trimmed });
      }
    };

    child.stdout.on("data", (chunk: string) => {
      const next = lines(stdoutPending, chunk);
      stdoutPending = next.pending;
      next.complete.forEach(consumeStdout);
    });
    child.stderr.on("data", (chunk: string) => {
      const next = lines(stderrPending, chunk);
      stderrPending = next.pending;
      next.complete.forEach(consumeStderr);
    });
    child.on("error", (error) => {
      finalError = { code: "E_PROCESS_FAILED", message: error.message };
    });
    child.on("close", (code) => {
      consumeStdout(stdoutPending);
      consumeStderr(stderrPending);
      this.#tasks.delete(taskId);
      void rm(configPath, { force: true });
      if (running.cancelled || code === 130) {
        sink({ taskId, kind, type: "cancelled" });
      } else if (code === 0 && finalResult) {
        sink({ taskId, kind, type: "complete", result: finalResult });
      } else {
        sink({
          taskId,
          kind,
          type: "error",
          error: finalError ?? { code: "E_PROCESS_FAILED", message: `处理进程退出，代码 ${String(code)}` },
        });
      }
    });
    return taskId;
  }

  cancel(taskId: string): void {
    const task = this.#tasks.get(taskId);
    if (!task || task.cancelled) return;
    task.cancelled = true;
    terminateProcessTree(task.child);
  }

  hasRunningTasks(): boolean {
    return this.#tasks.size > 0;
  }
}
