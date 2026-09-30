import { spawn } from "node:child_process";
import { AppError } from "./errors.js";

export interface CommandSpec {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunCommandOptions {
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  acceptedExitCodes?: number[];
  maxCaptureBytes?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export type CommandRunner = (spec: CommandSpec, options?: RunCommandOptions) => Promise<CommandResult>;

function boundedAppend(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  return combined.length <= maxBytes ? combined : combined.slice(combined.length - maxBytes);
}

export const runCommand: CommandRunner = async (spec, options = {}) => {
  if (options.signal?.aborted) throw new AppError("E_CANCELLED", "Operation cancelled");
  const accepted = options.acceptedExitCodes ?? [0];
  const maxCapture = options.maxCaptureBytes ?? 2 * 1024 * 1024;

  return await new Promise<CommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finishError = (error: AppError): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    };

    const abort = (): void => {
      child.kill("SIGTERM");
      finishError(new AppError("E_CANCELLED", "Operation cancelled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > maxCapture) stdoutTruncated = true;
      stdout = boundedAppend(stdout, chunk, maxCapture);
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length + chunk.length > maxCapture) stderrTruncated = true;
      stderr = boundedAppend(stderr, chunk, maxCapture);
      options.onStderr?.(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code === "ENOENT" ? "E_DEPENDENCY_MISSING" : "E_PROCESS_FAILED";
      finishError(new AppError(code, `Could not start ${spec.executable}: ${error.message}`, {
        executable: spec.executable,
        args: spec.args,
      }, { cause: error }));
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      const normalizedCode = exitCode ?? -1;
      if (!accepted.includes(normalizedCode)) {
        reject(new AppError("E_PROCESS_FAILED", `${spec.executable} exited with code ${normalizedCode}`, {
          executable: spec.executable,
          args: spec.args,
          exitCode: normalizedCode,
          stderr,
          stderrTruncated,
        }));
        return;
      }
      resolve({
        exitCode: normalizedCode,
        stdout,
        stderr,
        ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
        ...(stderrTruncated ? { stderrTruncated: true } : {}),
      });
    });
  });
};

export class LineAccumulator {
  #pending = "";

  push(chunk: string): string[] {
    const parts = (this.#pending + chunk).split(/\r?\n/);
    this.#pending = parts.pop() ?? "";
    return parts;
  }

  flush(): string | null {
    const value = this.#pending;
    this.#pending = "";
    return value.length > 0 ? value : null;
  }
}
