import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { is } from "@electron-toolkit/utils";
import { CliBridge } from "./cli-bridge.js";
import {
  assertCurrentTask,
  bindTaskEvent,
  createTaskBinding,
  resolveCleanupStatus,
  type CurrentTaskBinding,
} from "./cleanup-binding.js";
import { jobCleanupDirectory } from "./cleanup-paths.js";
import { writeCancellationMarker } from "./work-cleanup.js";
import { cancelBoundTask } from "./task-cancellation.js";
import { resolveAvailableOutputPath } from "./output-path.js";
import { installDependencies, loadDependencyManifest } from "./dependency-installer.js";
import { AppearanceResourceStore, type ResourceImportOptions } from "./appearance-resources.js";
import { IPC } from "../shared/channels.js";
import { physicalDisplaySize } from "../shared/display.js";
import { validateJobRequest } from "../shared/job-validation.js";
import type {
  DependencyCatalogEntry,
  DoctorReport,
  CleanupRequest,
  CleanupStatusRequest,
  InstallDependenciesRequest,
  TaskEvent,
  CacheCleanupRequest,
  CacheOverview,
  CacheRequest,
  CacheSettings,
  IconConfigSnapshot,
  AppearanceImportProgress,
} from "../shared/contracts.js";
import { isSemanticIconName } from "../shared/appearance-icons.js";

protocol.registerSchemesAsPrivileged([{
  scheme: "wallpaper-media",
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
}]);

app.setName("AI Video Wallpaper");

const CATALOG = [
  {
    id: "ffmpeg",
    displayName: "FFmpeg essentials build",
    version: "8.0.1",
    sourcePage: "https://www.gyan.dev/ffmpeg/builds/",
    license: "GPL-3.0-or-later",
    licenseUrl: "https://www.ffmpeg.org/legal.html",
    approximateSizeBytes: 106_259_850,
  },
  {
    id: "realesrgan",
    displayName: "Real-ESRGAN ncnn Vulkan",
    version: "0.2.5.0",
    sourcePage: "https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0",
    license: "BSD-3-Clause",
    licenseUrl: "https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE",
    approximateSizeBytes: 45_474_481,
  },
  {
    id: "rife",
    displayName: "RIFE ncnn Vulkan",
    version: "20221029",
    sourcePage: "https://github.com/nihui/rife-ncnn-vulkan/releases/tag/20221029",
    license: "MIT",
    licenseUrl: "https://github.com/nihui/rife-ncnn-vulkan/blob/master/LICENSE",
    approximateSizeBytes: 431_540_241,
  },
] as const;

let mainWindow: BrowserWindow | null = null;
let cli: CliBridge;
let cacheDirectory = "";
let dependencyManifest: Awaited<ReturnType<typeof loadDependencyManifest>> = null;
const mediaTokens = new Map<string, string>();
let currentTaskBinding: CurrentTaskBinding | null = null;
let appearanceResources: AppearanceResourceStore;
const appearanceImportControllers = new Map<string, AbortController>();
const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  policy: "cleanup-on-success",
  limitBytes: 50 * 1024 * 1024 * 1024,
};
let cacheSettings: CacheSettings = { ...DEFAULT_CACHE_SETTINGS };
const knownWorkDirectories = new Set<string>();

async function runAppearanceImport<T>(kind: AppearanceImportProgress["kind"], action: (options: ResourceImportOptions) => Promise<T>): Promise<T> {
  const importId = randomUUID();
  const controller = new AbortController();
  appearanceImportControllers.set(importId, controller);
  const send = (stage: AppearanceImportProgress["stage"], percent: number, message: string): void => {
    mainWindow?.webContents.send(IPC.appearanceImportProgress, { importId, kind, stage, percent, message } satisfies AppearanceImportProgress);
  };
  try {
    send("reading", 1, "正在准备导入");
    return await action({ importId, signal: controller.signal, onProgress: send });
  } catch (error) {
    await appearanceResources.cancelImport(importId).catch(() => undefined);
    if (controller.signal.aborted || (error as { name?: string }).name === "AbortError") {
      send("cancelled", 0, "导入已取消");
      throw Object.assign(new Error("外观资源导入已取消"), { code: "E_IMPORT_CANCELLED" });
    }
    throw error;
  } finally {
    appearanceImportControllers.delete(importId);
  }
}

function validCacheSettings(value: unknown): value is CacheSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["cleanup-on-success", "keep-24-hours", "keep-all"].includes(String(record.policy)) &&
    Number.isSafeInteger(record.limitBytes) && Number(record.limitBytes) >= 0;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function loadDesktopCacheState(): Promise<void> {
  try {
    const value = JSON.parse(await readFile(join(cacheDirectory, "cache-settings.json"), "utf8")) as unknown;
    if (validCacheSettings(value)) cacheSettings = value;
  } catch {
    cacheSettings = { ...DEFAULT_CACHE_SETTINGS };
  }
  try {
    const value = JSON.parse(await readFile(join(cacheDirectory, "work-roots.json"), "utf8")) as unknown;
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.trim()) knownWorkDirectories.add(resolve(item));
    }
  } catch {
    // First run has no registered work roots.
  }
}

async function rememberWorkDirectory(path: string): Promise<void> {
  knownWorkDirectories.add(resolve(path));
  await atomicWriteJson(join(cacheDirectory, "work-roots.json"), [...knownWorkDirectories].sort());
}

function cacheArgs(command: "cache-status" | "cache-cleanup", request: CacheRequest, force = false): string[] {
  return [
    command,
    "--work-dir", resolve(request.workDirectory),
    "--cache-policy", request.policy,
    "--cache-limit-bytes", String(request.limitBytes),
    ...(force ? ["--force"] : []),
  ];
}

function validatedCacheRequest(value: unknown): CacheRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("缓存请求无效"), { code: "E_INVALID_ARGUMENT" });
  }
  const request = value as CacheRequest;
  if (typeof request.workDirectory !== "string" || !request.workDirectory.trim() ||
      !validCacheSettings({ policy: request.policy, limitBytes: request.limitBytes })) {
    throw Object.assign(new Error("缓存目录、策略或上限无效"), { code: "E_INVALID_ARGUMENT" });
  }
  return { ...request, workDirectory: resolve(request.workDirectory) };
}

function rememberTaskEvent(event: TaskEvent): void {
  if (currentTaskBinding) currentTaskBinding = bindTaskEvent(currentTaskBinding, event);
}

function errorPayload(error: unknown): { code: string; message: string; details?: unknown } {
  if (error && typeof error === "object") {
    const source = error as Record<string, unknown>;
    return {
      code: typeof source.code === "string" ? source.code : "E_IO",
      message: typeof source.message === "string" ? source.message : "桌面端操作失败",
      ...(source.details === undefined ? {} : { details: source.details }),
    };
  }
  return { code: "E_IO", message: String(error) };
}

function ipcFailure(error: unknown): never {
  throw new Error(`WALLPAPER_ERROR:${JSON.stringify(errorPayload(error))}`);
}

function trusted(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw Object.assign(new Error("拒绝来自未知页面的 IPC 请求"), { code: "E_INVALID_ARGUMENT" });
  }
}

function handle(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      trusted(event);
      return await handler(event, ...args);
    } catch (error) {
      ipcFailure(error);
    }
  });
}

function effectiveWorkDirectory(outputPath: string | undefined, requested: string | undefined): string {
  if (requested?.trim()) return resolve(requested);
  if (outputPath?.trim()) return resolve(dirname(outputPath), ".ai-video-wallpaper-work");
  return resolve(cacheDirectory);
}

function cliCandidates(): string[] {
  const configured = process.env.AI_VIDEO_WALLPAPER_CLI;
  const appPath = app.getAppPath();
  return [
    ...(configured ? [resolve(configured)] : []),
    join(process.resourcesPath, "cli", "index.js"),
    join(process.resourcesPath, "cli", "main.js"),
    resolve(appPath, "../cli/dist/index.js"),
    resolve(appPath, "../cli/dist/main.js"),
    resolve(process.cwd(), "apps/cli/dist/index.js"),
    resolve(process.cwd(), "apps/cli/dist/main.js"),
    resolve(process.cwd(), "../cli/dist/index.js"),
    resolve(process.cwd(), "../cli/dist/main.js"),
  ];
}

function manifestCandidates(): string[] {
  const configured = process.env.AI_VIDEO_WALLPAPER_DEPENDENCY_MANIFEST;
  return [
    ...(configured ? [resolve(configured)] : []),
    join(process.resourcesPath, "resources", "dependencies.json"),
    join(app.getAppPath(), "resources", "dependencies.json"),
    resolve(app.getAppPath(), "../../resources/dependencies.json"),
    resolve(process.cwd(), "resources/dependencies.json"),
  ];
}

function createWindow(): void {
  const requestedWidth = Number(process.env.AI_VIDEO_WALLPAPER_WINDOW_WIDTH);
  const requestedHeight = Number(process.env.AI_VIDEO_WALLPAPER_WINDOW_HEIGHT);
  mainWindow = new BrowserWindow({
    width: Number.isInteger(requestedWidth) && requestedWidth >= 980 ? requestedWidth : 1440,
    height: Number.isInteger(requestedHeight) && requestedHeight >= 700 ? requestedHeight : 900,
    minWidth: 980,
    minHeight: 700,
    show: false,
    title: "AI 视频壁纸处理器",
    backgroundColor: "#f4f6f8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = is.dev && process.env.ELECTRON_RENDERER_URL ? url.startsWith(process.env.ELECTRON_RENDERER_URL) : url.startsWith("file:");
    if (!allowed) event.preventDefault();
  });
  if (is.dev && process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

function registerIpc(): void {
  handle(IPC.bootstrap, () => {
    const primary = screen.getPrimaryDisplay();
    const physical = physicalDisplaySize(primary.size, primary.scaleFactor);
    const manifestById = new Map(dependencyManifest?.artifacts.map((artifact) => [artifact.id, artifact]) ?? []);
    const dependencyCatalog: DependencyCatalogEntry[] = CATALOG.map((entry) => {
      const artifact = manifestById.get(entry.id);
      return {
        id: entry.id,
        displayName: artifact?.displayName ?? entry.displayName,
        version: artifact?.version ?? entry.version,
        sourcePage: artifact?.sourcePage ?? entry.sourcePage,
        license: artifact?.license ?? entry.license,
        licenseUrl: artifact?.licenseUrl ?? entry.licenseUrl,
        approximateSizeBytes: artifact?.approximateSizeBytes ?? entry.approximateSizeBytes,
        installable: artifact !== undefined,
      };
    });
    return {
      appVersion: app.getVersion(),
      cacheDirectory,
      display: { width: physical.width, height: physical.height, scaleFactor: primary.scaleFactor },
      dependencyCatalog,
      cacheSettings,
    };
  });
  handle(IPC.doctor, async () => await cli.doctor() as DoctorReport);
  handle(IPC.inspect, async (_event, inputPath) => await cli.inspect(String(inputPath ?? "")));
  handle(IPC.selectInput, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "选择源视频",
      properties: ["openFile"],
      filters: [
        { name: "视频", extensions: ["mp4", "mov", "mkv", "webm", "m4v"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle(IPC.selectOutput, async (_event, rawInputPath) => {
    const inputPath = String(rawInputPath ?? "");
    const parsed = parse(inputPath);
    const preferredPath = join(parsed.dir || app.getPath("videos"), `${parsed.name || "wallpaper"}.wallpaper.mp4`);
    const defaultPath = await resolveAvailableOutputPath(preferredPath);
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "保存壁纸视频",
      defaultPath,
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
    });
    return result.canceled || !result.filePath ? null : await resolveAvailableOutputPath(result.filePath);
  });
  handle(IPC.resolveAvailableOutputPath, async (_event, rawPreferredPath) =>
    await resolveAvailableOutputPath(String(rawPreferredPath ?? "")));
  handle(IPC.selectWorkDirectory, async (_event, rawInitialPath) => {
    const initialPath = typeof rawInitialPath === "string" && rawInitialPath.trim() ? resolve(rawInitialPath) : undefined;
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "选择工作文件位置",
      properties: ["openDirectory", "createDirectory"],
      ...(initialPath ? { defaultPath: initialPath } : {}),
    });
    const selected = result.canceled ? null : result.filePaths[0] ?? null;
    return selected;
  });
  handle(IPC.registerMedia, async (_event, rawPath) => {
    const inputPath = resolve(String(rawPath ?? ""));
    const info = await stat(inputPath);
    if (!info.isFile()) throw Object.assign(new Error("媒体路径不是文件"), { code: "E_INPUT_NOT_FOUND" });
    const token = randomUUID();
    mediaTokens.set(token, inputPath);
    return `wallpaper-media://local/${token}`;
  });
  handle(IPC.startPreview, async (event, rawRequest) => {
    const request = validateJobRequest(rawRequest);
    const workRoot = effectiveWorkDirectory(request.spec.outputPath, request.workDirectory);
    currentTaskBinding = createTaskBinding(workRoot);
    await rememberWorkDirectory(workRoot);
    const taskId = await cli.start(
      "preview",
      request.spec,
      request.centerSeconds,
      request.previewMode,
      request.turn,
      request.workDirectory,
      request.cachePolicy ?? cacheSettings.policy,
      request.cacheLimitBytes ?? cacheSettings.limitBytes,
      (taskEvent) => {
        rememberTaskEvent(taskEvent);
        if (!event.sender.isDestroyed()) event.sender.send(IPC.taskEvent, taskEvent);
      },
    );
    if (currentTaskBinding?.taskId === null) currentTaskBinding = { ...currentTaskBinding, taskId };
    return { taskId };
  });
  handle(IPC.startLoopPreview, async (event, rawRequest) => {
    const request = validateJobRequest(rawRequest);
    const workRoot = effectiveWorkDirectory(request.spec.outputPath, request.workDirectory);
    currentTaskBinding = createTaskBinding(workRoot);
    await rememberWorkDirectory(workRoot);
    const taskId = await cli.start(
      "loop-preview",
      request.spec,
      undefined,
      undefined,
      undefined,
      request.workDirectory,
      request.cachePolicy ?? cacheSettings.policy,
      request.cacheLimitBytes ?? cacheSettings.limitBytes,
      (taskEvent) => {
        rememberTaskEvent(taskEvent);
        if (!event.sender.isDestroyed()) event.sender.send(IPC.taskEvent, taskEvent);
      },
    );
    if (currentTaskBinding?.taskId === null) currentTaskBinding = { ...currentTaskBinding, taskId };
    return { taskId };
  });
  handle(IPC.startDiagnosticPreview, async (event, rawRequest) => {
    const request = validateJobRequest(rawRequest);
    const workRoot = effectiveWorkDirectory(request.spec.outputPath, request.workDirectory);
    currentTaskBinding = createTaskBinding(workRoot);
    await rememberWorkDirectory(workRoot);
    const taskId = await cli.start(
      "diagnostic-preview",
      request.spec,
      request.centerSeconds,
      request.previewMode,
      request.turn,
      request.workDirectory,
      request.cachePolicy ?? cacheSettings.policy,
      request.cacheLimitBytes ?? cacheSettings.limitBytes,
      (taskEvent) => {
        rememberTaskEvent(taskEvent);
        if (!event.sender.isDestroyed()) event.sender.send(IPC.taskEvent, taskEvent);
      },
    );
    if (currentTaskBinding?.taskId === null) currentTaskBinding = { ...currentTaskBinding, taskId };
    return { taskId };
  });
  handle(IPC.startProcess, async (event, rawRequest) => {
    const request = validateJobRequest(rawRequest);
    const workRoot = effectiveWorkDirectory(request.spec.outputPath, request.workDirectory);
    currentTaskBinding = createTaskBinding(workRoot);
    await rememberWorkDirectory(workRoot);
    const taskId = await cli.start(
      "process",
      request.spec,
      undefined,
      undefined,
      undefined,
      request.workDirectory,
      request.cachePolicy ?? cacheSettings.policy,
      request.cacheLimitBytes ?? cacheSettings.limitBytes,
      (taskEvent) => {
        rememberTaskEvent(taskEvent);
        if (!event.sender.isDestroyed()) event.sender.send(IPC.taskEvent, taskEvent);
      },
    );
    if (currentTaskBinding?.taskId === null) currentTaskBinding = { ...currentTaskBinding, taskId };
    return { taskId };
  });
  handle(IPC.cacheOverview, async (_event, rawRequest) => {
    const request = validatedCacheRequest(rawRequest);
    await rememberWorkDirectory(request.workDirectory);
    return await cli.runJson<CacheOverview>(cacheArgs("cache-status", request));
  });
  handle(IPC.cacheCleanup, async (_event, rawRequest) => {
    const request = validatedCacheRequest(rawRequest) as CacheCleanupRequest;
    await rememberWorkDirectory(request.workDirectory);
    return await cli.runJson<CacheOverview>(cacheArgs("cache-cleanup", request, request.force === true));
  });
  handle(IPC.cacheSettings, async (_event, rawSettings) => {
    if (!validCacheSettings(rawSettings)) {
      throw Object.assign(new Error("缓存设置无效"), { code: "E_INVALID_ARGUMENT" });
    }
    cacheSettings = { ...rawSettings };
    await atomicWriteJson(join(cacheDirectory, "cache-settings.json"), cacheSettings);
    return cacheSettings;
  });
  handle(IPC.showItemInFolder, (_event, rawPath) => {
    const path = String(rawPath ?? "").trim();
    if (!path || path.length > 32_768) {
      throw Object.assign(new Error("输出路径无效"), { code: "E_INVALID_ARGUMENT" });
    }
    shell.showItemInFolder(resolve(path));
  });
  handle(IPC.copyText, (_event, rawText) => {
    const text = String(rawText ?? "");
    if (!text || text.length > 100_000) {
      throw Object.assign(new Error("复制内容无效"), { code: "E_INVALID_ARGUMENT" });
    }
    clipboard.writeText(text);
  });
  handle(IPC.cancel, async (_event, rawTaskId) => {
    const taskId = String(rawTaskId ?? "");
    await cancelBoundTask({
      taskId,
      binding: currentTaskBinding,
      writeMarker: writeCancellationMarker,
      terminate: (id) => { cli.cancel(id); },
    });
  });
  handle(IPC.cleanupStatus, async (_event, rawRequest) => {
    if (!rawRequest || typeof rawRequest !== "object") {
      throw Object.assign(new Error("清理状态请求无效"), { code: "E_INVALID_ARGUMENT" });
    }
    const request = rawRequest as CleanupStatusRequest;
    const binding = assertCurrentTask(currentTaskBinding, String(request.taskId ?? ""), String(request.jobId ?? ""));
    const resolved = await resolveCleanupStatus(binding);
    currentTaskBinding = resolved.binding;
    return resolved.status;
  });
  handle(IPC.cleanup, async (_event, rawRequest) => {
    if (cli.hasRunningTasks()) throw Object.assign(new Error("请先取消正在运行的任务"), { code: "E_JOB_STATE" });
    if (!rawRequest || typeof rawRequest !== "object") {
      throw Object.assign(new Error("清理请求无效"), { code: "E_INVALID_ARGUMENT" });
    }
    const request = rawRequest as CleanupRequest;
    const binding = assertCurrentTask(currentTaskBinding, String(request.taskId ?? ""), String(request.jobId ?? ""));
    const resolved = await resolveCleanupStatus(binding);
    currentTaskBinding = resolved.binding;
    if (request.target === "job") {
      await rm(jobCleanupDirectory(resolved.binding.workDirectory, request.jobId), { recursive: true, force: true });
      return;
    }
    if (request.target !== "frame-cache") {
      throw Object.assign(new Error("不支持的清理目标"), { code: "E_INVALID_ARGUMENT" });
    }
    if (!resolved.binding.frameCacheKey || !resolved.status.frameCacheAvailable) {
      throw Object.assign(new Error("当前任务没有可清理的共享 AI 帧缓存"), { code: "E_JOB_STATE" });
    }
    await cli.runJson<CacheOverview>([
      "cache-delete",
      "--work-dir", resolved.binding.workDirectory,
      "--frame-cache-key", resolved.binding.frameCacheKey,
      "--cache-policy", cacheSettings.policy,
      "--cache-limit-bytes", String(cacheSettings.limitBytes),
    ]);
  });
  handle(IPC.installDependencies, async (_event, rawRequest) => {
    const request = rawRequest as InstallDependenciesRequest;
    if (!request || request.consent !== true || !Array.isArray(request.ids) ||
        !request.ids.every((id) => id === "ffmpeg" || id === "realesrgan" || id === "rife")) {
      throw Object.assign(new Error("依赖下载请求无效"), { code: "E_INVALID_ARGUMENT" });
    }
    return await installDependencies({
      ids: request.ids,
      consent: true,
      toolsDirectory: join(cacheDirectory, "tools"),
      manifest: dependencyManifest,
    });
  });
  handle(IPC.openExternal, async (_event, rawUrl) => {
    const url = String(rawUrl ?? "");
    const allowed = new Set([
      ...CATALOG.flatMap((entry) => [entry.sourcePage, entry.licenseUrl]),
      ...(dependencyManifest?.artifacts.flatMap((artifact) => [artifact.sourcePage, artifact.licenseUrl]) ?? []),
    ]);
    if (!allowed.has(url)) throw Object.assign(new Error("不允许打开此链接"), { code: "E_INVALID_ARGUMENT" });
    await shell.openExternal(url);
  });
  handle(IPC.appearanceResources, () => appearanceResources.catalog());
  handle(IPC.previewFontImport, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "导入本地字体",
      properties: ["openFile"],
      filters: [
        { name: "字体", extensions: ["ttf", "otf", "woff2"] },
      ],
    });
    const path = result.canceled ? null : result.filePaths[0] ?? null;
    return path ? await runAppearanceImport("font", async (options) => await appearanceResources.previewFont(path, options)) : null;
  });
  handle(IPC.previewIconPackImport, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "导入图标包",
      properties: ["openFile"],
      filters: [{ name: "图标包", extensions: ["zip"] }],
    });
    const path = result.canceled ? null : result.filePaths[0] ?? null;
    return path ? await runAppearanceImport("icon-pack", async (options) => await appearanceResources.previewIconPack(path, options)) : null;
  });
  handle(IPC.previewIconOverrideImport, async (_event, rawSemanticName) => {
    if (!isSemanticIconName(rawSemanticName)) throw Object.assign(new Error("语义图标名称无效"), { code: "E_INVALID_ARGUMENT" });
    const pngAllowed = rawSemanticName === "appLogo" || rawSemanticName === "emptyState";
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "替换单个图标",
      properties: ["openFile"],
      filters: [{ name: pngAllowed ? "SVG 或 PNG 图标" : "SVG 图标", extensions: pngAllowed ? ["svg", "png"] : ["svg"] }],
    });
    const path = result.canceled ? null : result.filePaths[0] ?? null;
    return path ? await runAppearanceImport("icon-override", async (options) => await appearanceResources.previewIconOverride(path, rawSemanticName, options)) : null;
  });
  handle(IPC.cancelAppearanceImport, async (_event, rawImportId) => {
    const importId = String(rawImportId ?? "");
    appearanceImportControllers.get(importId)?.abort();
    await appearanceResources.cancelImport(importId);
  });
  handle(IPC.commitFontImport, async (_event, rawImportId) => await appearanceResources.commitFont(String(rawImportId ?? "")));
  handle(IPC.commitIconPackImport, async (_event, rawImportId) => await appearanceResources.commitIconPack(String(rawImportId ?? "")));
  handle(IPC.commitIconOverrideImport, async (_event, rawImportId) => await appearanceResources.commitIconOverride(String(rawImportId ?? "")));
  handle(IPC.readFontResource, async (_event, rawFontId) => await appearanceResources.readFont(String(rawFontId ?? "")));
  handle(IPC.readIconPackResource, async (_event, rawPackId) => await appearanceResources.readIconPack(String(rawPackId ?? "")));
  handle(IPC.readIconOverrideResource, async (_event, rawIconId) => await appearanceResources.readIconOverride(String(rawIconId ?? "")));
  handle(IPC.deleteFontResource, async (_event, rawFontId) => { await appearanceResources.deleteFont(String(rawFontId ?? "")); });
  handle(IPC.deleteIconPackResource, async (_event, rawPackId) => { await appearanceResources.deleteIconPack(String(rawPackId ?? "")); });
  handle(IPC.deleteIconOverrideResource, async (_event, rawIconId) => { await appearanceResources.deleteIconOverride(String(rawIconId ?? "")); });
  handle(IPC.exportIconConfig, async (_event, rawConfig) => {
    if (!validIconConfig(rawConfig)) throw Object.assign(new Error("图标配置快照无效"), { code: "E_INVALID_ARGUMENT" });
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "导出图标配置",
      defaultPath: join(app.getPath("documents"), "icon-config.json"),
      filters: [{ name: "JSON 配置", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return false;
    await atomicWriteJson(result.filePath, rawConfig);
    return true;
  });
}

function validIconConfig(value: unknown): value is IconConfigSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (config.schemaVersion !== 1 || !["fine-outline", "soft-outline", "custom"].includes(String(config.preset)) ||
      (config.packId !== null && (typeof config.packId !== "string" || !/^icon-pack-[a-f0-9]{32}$/.test(config.packId))) ||
      !config.overrides || typeof config.overrides !== "object" || Array.isArray(config.overrides)) return false;
  return Object.entries(config.overrides as Record<string, unknown>).every(([name, id]) => isSemanticIconName(name) && typeof id === "string" && /^icon-[a-f0-9]{32}$/.test(id));
}

async function runPackagedCli(args: string[]): Promise<void> {
  const candidates = [
    join(process.resourcesPath, "cli", "index.js"),
    resolve(app.getAppPath(), "../cli/dist/index.js"),
    resolve(process.cwd(), "apps/cli/dist/index.js"),
  ];
  let entry: string | null = null;
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) {
      entry = candidate;
      break;
    }
  }
  if (!entry) {
    process.stderr.write(`${JSON.stringify({ code: "E_DEPENDENCY_MISSING", message: "Packaged CLI entry was not found", details: { searched: candidates } })}\n`);
    app.exit(3);
    return;
  }
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", (error) => {
    process.stderr.write(`${JSON.stringify({ code: "E_PROCESS_FAILED", message: error.message })}\n`);
    app.exit(1);
  });
  child.once("close", (code) => app.exit(code ?? 1));
}

const cliArgumentIndex = process.argv.indexOf("--cli");
if (cliArgumentIndex >= 0) {
  void runPackagedCli(process.argv.slice(cliArgumentIndex + 1));
} else {
  void app.whenReady().then(async () => {
  const defaultCacheDirectory = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "AI Video Wallpaper")
    : join(app.getPath("sessionData"), "processing-cache");
  cacheDirectory = resolve(
    process.env.AI_VIDEO_WALLPAPER_CACHE ?? defaultCacheDirectory,
  );
  await mkdir(cacheDirectory, { recursive: true });
  appearanceResources = new AppearanceResourceStore(join(app.getPath("userData"), "appearance-resources"));
  await appearanceResources.initialize();
  await loadDesktopCacheState();
  dependencyManifest = await loadDependencyManifest(manifestCandidates());
  cli = new CliBridge({ cacheDirectory, entryCandidates: cliCandidates() });
  for (const workDirectory of knownWorkDirectories) {
    void cli.runJson<CacheOverview>(cacheArgs("cache-cleanup", {
      workDirectory,
      policy: cacheSettings.policy,
      limitBytes: cacheSettings.limitBytes,
    })).catch(() => undefined);
  }
  protocol.handle("wallpaper-media", async (request) => {
    const token = new URL(request.url).pathname.replace(/^\//, "");
    const path = mediaTokens.get(token);
    if (!path) return new Response("Not found", { status: 404 });
    return await net.fetch(pathToFileURL(path).toString(), {
      headers: request.headers,
      bypassCustomProtocolHandlers: true,
    });
  });
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
