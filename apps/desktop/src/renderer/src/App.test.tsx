import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DependencyCatalogEntry,
  DoctorReport,
  MediaInfo,
  WallpaperApi,
  TaskEvent,
} from "../../shared/contracts";
import App, { phaseLabel } from "./App";

const catalog: DependencyCatalogEntry[] = [
  {
    id: "ffmpeg",
    displayName: "FFmpeg",
    version: "8.0.1",
    sourcePage: "https://example.test/ffmpeg",
    license: "GPL-3.0-or-later",
    licenseUrl: "https://example.test/ffmpeg-license",
    approximateSizeBytes: 100,
    installable: true,
  },
  {
    id: "realesrgan",
    displayName: "Real-ESRGAN",
    version: "0.2.5.0",
    sourcePage: "https://example.test/realesrgan",
    license: "BSD-3-Clause",
    licenseUrl: "https://example.test/realesrgan-license",
    approximateSizeBytes: 100,
    installable: true,
  },
  {
    id: "rife",
    displayName: "RIFE ncnn Vulkan",
    version: "20221029",
    sourcePage: "https://example.test/rife",
    license: "MIT",
    licenseUrl: "https://example.test/rife-license",
    approximateSizeBytes: 100,
    installable: true,
  },
];

const media: MediaInfo = {
  path: "D:\\source.mp4",
  format: "mp4",
  durationSeconds: 30,
  sizeBytes: 1024,
  video: {
    codec: "h264",
    width: 1136,
    height: 800,
    frameRate: 24,
    frameRateMode: "constant",
    frameCount: 720,
    durationSeconds: 30,
  },
  audio: [],
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function doctor(rifeAvailable: boolean): DoctorReport {
  return {
    ok: rifeAvailable,
    platform: "win32",
    arch: "x64",
    cacheDirectory: "C:\\cache",
    cacheWritable: true,
    tools: [
      { name: "ffmpeg", available: true, path: "ffmpeg.exe", version: "8.0.1" },
      { name: "ffprobe", available: true, path: "ffprobe.exe", version: "8.0.1" },
      { name: "realesrgan", available: true, path: "realesrgan.exe", version: "0.2.5.0" },
      { name: "rife", available: rifeAvailable, path: rifeAvailable ? "rife.exe" : null, version: rifeAvailable ? "20221029" : null },
    ],
    recommendations: [],
    capabilities: {
      jobSpecVersions: [1, 2, 3],
      previewModes: ["segment", "loop-boundary"],
      h264Nvenc: { available: true, maxDimension: 4096 },
    },
  };
}

function createApi(rifeAvailable = true): WallpaperApi {
  return {
    getBootstrap: vi.fn().mockResolvedValue({
      appVersion: "0.3.2",
      cacheDirectory: "C:\\cache",
      display: { width: 2560, height: 1600, scaleFactor: 1.5 },
      dependencyCatalog: catalog,
      cacheSettings: { policy: "cleanup-on-success", limitBytes: 50 * 1024 ** 3 },
    }),
    doctor: vi.fn().mockResolvedValue(doctor(rifeAvailable)),
    inspect: vi.fn().mockResolvedValue(media),
    selectInput: vi.fn().mockResolvedValue("D:\\source.mp4"),
    selectOutput: vi.fn().mockResolvedValue("D:\\source.wallpaper.mp4"),
    resolveAvailableOutputPath: vi.fn().mockImplementation(async (path) => path),
    selectWorkDirectory: vi.fn().mockResolvedValue(null),
    registerMedia: vi.fn().mockResolvedValue("wallpaper-media://local/source"),
    startPreview: vi.fn().mockResolvedValue({ taskId: "preview-task" }),
    startLoopPreview: vi.fn().mockResolvedValue({ taskId: "loop-preview-task" }),
    startDiagnosticPreview: vi.fn().mockResolvedValue({ taskId: "diagnostic-task" }),
    startProcess: vi.fn().mockResolvedValue({ taskId: "process-task" }),
    cancel: vi.fn().mockResolvedValue(undefined),
    getCleanupStatus: vi.fn().mockResolvedValue({
      workDirectory: "D:\\.ai-video-wallpaper-work",
      jobFilesAvailable: false,
      frameCacheAvailable: false,
      frameCacheReference: null,
    }),
    cleanup: vi.fn().mockResolvedValue(undefined),
    getCacheOverview: vi.fn().mockResolvedValue({
      workDirectory: "D:\\.ai-video-wallpaper-work",
      cacheDirectory: "D:\\.ai-video-wallpaper-work\\frame-cache",
      policy: "cleanup-on-success",
      limitBytes: 50 * 1024 ** 3,
      totalBytes: 5 * 1024 ** 3,
      releasedBytes: 0,
      remainingBytes: 5 * 1024 ** 3,
      removedKeys: [],
      legacyCount: 0,
      entries: [],
      errors: [],
    }),
    cleanupCaches: vi.fn().mockResolvedValue({
      workDirectory: "D:\\.ai-video-wallpaper-work",
      cacheDirectory: "D:\\.ai-video-wallpaper-work\\frame-cache",
      policy: "cleanup-on-success",
      limitBytes: 50 * 1024 ** 3,
      totalBytes: 5 * 1024 ** 3,
      releasedBytes: 2 * 1024 ** 3,
      remainingBytes: 3 * 1024 ** 3,
      removedKeys: ["a".repeat(64)],
      legacyCount: 0,
      entries: [],
      errors: [],
    }),
    saveCacheSettings: vi.fn().mockImplementation(async (settings) => settings),
    installDependencies: vi.fn().mockResolvedValue({ installed: [] }),
    openExternal: vi.fn().mockResolvedValue(undefined),
    showItemInFolder: vi.fn().mockResolvedValue(undefined),
    copyText: vi.fn().mockResolvedValue(undefined),
    getAppearanceResources: vi.fn().mockResolvedValue({ fonts: [], iconPacks: [], iconOverrides: [] }),
    previewFontImport: vi.fn().mockResolvedValue(null),
    previewIconPackImport: vi.fn().mockResolvedValue(null),
    previewIconOverrideImport: vi.fn().mockResolvedValue(null),
    cancelAppearanceImport: vi.fn().mockResolvedValue(undefined),
    commitFontImport: vi.fn(),
    commitIconPackImport: vi.fn(),
    commitIconOverrideImport: vi.fn(),
    readFontResource: vi.fn(),
    readIconPackResource: vi.fn(),
    readIconOverrideResource: vi.fn(),
    deleteFontResource: vi.fn().mockResolvedValue(undefined),
    deleteIconPackResource: vi.fn().mockResolvedValue(undefined),
    deleteIconOverrideResource: vi.fn().mockResolvedValue(undefined),
    exportIconConfig: vi.fn().mockResolvedValue(true),
    pathForFile: vi.fn().mockReturnValue(""),
    onTaskEvent: vi.fn().mockReturnValue(() => undefined),
    onAppearanceImportProgress: vi.fn().mockReturnValue(() => undefined),
  };
}

async function loadVideo(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "选择源视频" }));
  await screen.findByText("24 fps");
}

function chooseSelect(label: string, option: string): void {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

function openDiagnostic(): void {
  fireEvent.click(screen.getByRole("button", { name: "更多任务操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "四方案诊断" }));
}

describe("desktop processing controls", () => {
  let mediaLoad: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    class TestFontFace {
      family: string;
      constructor(family: string) { this.family = family; }
      async load(): Promise<TestFontFace> { return this; }
    }
    Object.defineProperty(globalThis, "FontFace", { configurable: true, value: TestFontFace });
    Object.defineProperty(document, "fonts", { configurable: true, value: { add: vi.fn(), delete: vi.fn() } });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn().mockReturnValue("blob:icon-preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    mediaLoad = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    mediaLoad.mockRestore();
    vi.restoreAllMocks();
  });

  it("labels preview and full encode phases independently", () => {
    expect(phaseLabel("encode", "preview")).toBe("编码预览");
    expect(phaseLabel("encode", "process")).toBe("编码成片");
    expect(phaseLabel("interpolate", "process")).toBe("AI 插帧");
  });

  it("keeps the newest input when an earlier inspection resolves later", async () => {
    const api = createApi(true);
    const firstInspection = deferred<MediaInfo>();
    const secondInspection = deferred<MediaInfo>();
    const secondMedia: MediaInfo = {
      ...media,
      path: "D:\\B.mp4",
      durationSeconds: 20,
      video: {
        ...media.video,
        frameRate: 30,
        frameCount: 600,
        durationSeconds: 20,
      },
    };
    vi.mocked(api.selectInput)
      .mockResolvedValueOnce("D:\\A.mp4")
      .mockResolvedValueOnce("D:\\B.mp4");
    vi.mocked(api.inspect).mockImplementation((path) => {
      if (path === "D:\\A.mp4") return firstInspection.promise;
      if (path === "D:\\B.mp4") return secondInspection.promise;
      throw new Error(`Unexpected input: ${path}`);
    });
    vi.mocked(api.registerMedia).mockImplementation(async (path) => `wallpaper-media://local/${path.endsWith("A.mp4") ? "A" : "B"}`);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);

    const chooseInput = screen.getByRole("button", { name: "选择源视频" });
    fireEvent.click(chooseInput);
    await waitFor(() => expect(api.inspect).toHaveBeenCalledWith("D:\\A.mp4"));
    fireEvent.click(chooseInput);
    await waitFor(() => expect(api.inspect).toHaveBeenCalledWith("D:\\B.mp4"));

    await act(async () => { secondInspection.resolve(secondMedia); });
    expect(await screen.findByText("30 fps")).toBeVisible();
    expect(screen.getByLabelText("源视频")).toHaveValue("D:\\B.mp4");

    await act(async () => { firstInspection.resolve({ ...media, path: "D:\\A.mp4" }); });
    await waitFor(() => {
      expect(screen.getByLabelText("源视频")).toHaveValue("D:\\B.mp4");
      expect(screen.getByText("30 fps")).toBeVisible();
      expect(screen.queryByText("24 fps")).not.toBeInTheDocument();
    });
  });

  it("shows an available numbered output as soon as the source loads", async () => {
    const api = createApi(true);
    vi.mocked(api.resolveAvailableOutputPath).mockResolvedValue("D:\\source.wallpaper (2).mp4");
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    expect(api.resolveAvailableOutputPath).toHaveBeenCalledWith("D:\\source.wallpaper.mp4");
    expect(screen.getByLabelText("输出位置")).toHaveValue("D:\\source.wallpaper (2).mp4");
  });

  it("rechecks and renumbers only the final process output before submission", async () => {
    const api = createApi(true);
    vi.mocked(api.resolveAvailableOutputPath)
      .mockResolvedValueOnce("D:\\source.wallpaper.mp4")
      .mockResolvedValueOnce("D:\\source.wallpaper (2).mp4");
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await waitFor(() => expect(api.startProcess).toHaveBeenCalledTimes(1));
    expect(api.resolveAvailableOutputPath).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.startProcess).mock.calls[0]?.[0].spec.outputPath).toBe("D:\\source.wallpaper (2).mp4");
    expect(screen.getByLabelText("输出位置")).toHaveValue("D:\\source.wallpaper (2).mp4");
    expect(screen.getByText("已保留旧文件")).toBeVisible();
  });

  it("does not renumber final-effect previews", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    fireEvent.click(screen.getByRole("button", { name: "最终效果预览" }));
    await waitFor(() => expect(api.startPreview).toHaveBeenCalledTimes(1));
    expect(api.resolveAvailableOutputPath).toHaveBeenCalledTimes(1);
  });

  it("keeps video inspection available but clears output when path resolution fails", async () => {
    const api = createApi(true);
    vi.mocked(api.resolveAvailableOutputPath).mockRejectedValue(Object.assign(new Error("无法读取输出目录"), { code: "EACCES" }));
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    expect(screen.getByText("24 fps")).toBeVisible();
    expect(screen.getByLabelText("输出位置")).toHaveValue("");
    expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();
    expect(screen.getByText(/无法读取输出目录/)).toBeVisible();
  });

  it("does not submit a process when the final path recheck fails", async () => {
    const api = createApi(true);
    vi.mocked(api.resolveAvailableOutputPath)
      .mockResolvedValueOnce("D:\\source.wallpaper.mp4")
      .mockRejectedValueOnce(Object.assign(new Error("输出目录权限不足"), { code: "EACCES" }));
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await waitFor(() => expect(screen.getByText("输出目录权限不足")).toBeVisible());
    expect(api.startProcess).not.toHaveBeenCalled();
  });

  it("identifies VFR input and disables frame-range processing", async () => {
    const api = createApi(true);
    vi.mocked(api.inspect).mockResolvedValue({
      ...media,
      video: { ...media.video, frameRateMode: "variable" },
    });
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    expect(screen.getByText("VFR")).toBeVisible();
    expect(screen.getByText(/可变帧率会让时间预览与帧号抽取不一致/)).toBeVisible();
    expect(screen.getByRole("button", { name: "最终效果预览" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();
    expect(api.startPreview).not.toHaveBeenCalled();
  });

  it("fails closed when constant frame cadence cannot be confirmed", async () => {
    const api = createApi(true);
    vi.mocked(api.inspect).mockResolvedValue({
      ...media,
      video: { ...media.video, frameRateMode: "unknown" },
    });
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    expect(screen.getByText("帧率未确认")).toBeVisible();
    expect(screen.getByText(/当前素材无法确认恒定帧间隔/)).toBeVisible();
    expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();
  });

  it("shows the 2x frame-rate result and sends a standard v4 interpolation contract", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    expect(document.querySelector(".source-metadata .metadata-label")).toHaveTextContent("源视频");
    expect(screen.getByText("H.264")).toBeVisible();
    expect(screen.getByText("30 秒")).toBeVisible();
    expect(screen.getByRole("button", { name: "关闭" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "AI 2×" }));
    expect(screen.getByText("24.00 → 48.00 fps")).toBeVisible();
    expect(screen.getByText("处理帧量约 2×")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "最终效果预览" }));
    await waitFor(() => expect(api.startPreview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.startPreview).mock.calls[0]?.[0]).toMatchObject({
      previewMode: "segment",
      centerSeconds: 15,
      spec: {
        version: 4,
        sourceRange: { startFrame: 0, endFrameExclusive: 720 },
        aspectMode: "cover",
        upscale: {
          backend: "realesrgan-ncnn-vulkan",
          model: "realesr-animevideov3",
        },
        interpolation: {
          backend: "rife-ncnn-vulkan",
          mode: "rife",
          factor: 2,
          model: "rife-v4.6",
          memoryMode: "auto",
          sceneCutMode: "hold",
        },
        encoding: { encoder: "libx264", crf: 17, preset: "slow" },
      },
    });
  });

  it("sends the selected half-open frame range and ping-pong boundary", async () => {
    const api = createApi(true);
    let listener: ((event: TaskEvent) => void) | undefined;
    api.onTaskEvent = vi.fn().mockImplementation((callback) => {
      listener = callback;
      return () => undefined;
    });
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    fireEvent.change(screen.getByRole("slider", { name: "片段入点" }), { target: { value: "120" } });
    fireEvent.change(screen.getByRole("slider", { name: "片段出点" }), { target: { value: "360" } });
    fireEvent.click(screen.getByRole("button", { name: "快速检查循环" }));
    await waitFor(() => expect(api.startLoopPreview).toHaveBeenCalledTimes(1));
    listener?.({
      taskId: "loop-preview-task",
      kind: "loop-preview",
      type: "complete",
      result: {
        workDirectory: "D:\\work",
        outputDirectory: "D:\\loop",
        sourceFrameCount: 48,
        totalDurationMs: 100,
        target: { width: 960, height: 600 },
        cache: { workDirectory: "D:\\work", cacheDirectory: "D:\\work\\frame-cache", policy: "cleanup-on-success", limitBytes: 50 * 1024 ** 3, totalBytes: 0, releasedBytes: 0, remainingBytes: 0, removedKeys: [], legacyCount: 0, entries: [], errors: [] },
        variants: [
          { id: "pingpong-end", label: "乒乓循环 · 片尾折返", description: "第 1 个", loopMode: "pingpong", outputPath: "D:\\loop\\end.mp4", durationMs: 1, media, sourceRanges: [{ startFrame: 120, endFrameExclusive: 360 }], boundary: { type: "pingpong-end", outputFrame: 24 } },
          { id: "pingpong-start", label: "乒乓循环 · 片头折返", description: "第 2 个", loopMode: "pingpong", outputPath: "D:\\loop\\start.mp4", durationMs: 1, media, sourceRanges: [{ startFrame: 120, endFrameExclusive: 360 }], boundary: { type: "pingpong-start", outputFrame: 24 } },
          { id: "direct-seam", label: "直接循环 · 尾首衔接", description: "直接", loopMode: "none", outputPath: "D:\\loop\\direct.mp4", durationMs: 1, media, sourceRanges: [{ startFrame: 120, endFrameExclusive: 360 }], boundary: { type: "direct-seam", outputFrame: 24 } },
        ],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "片头折返" }));
    fireEvent.click(screen.getByRole("button", { name: "最终效果预览" }));

    await waitFor(() => expect(api.startPreview).toHaveBeenCalledTimes(1));
    const request = vi.mocked(api.startPreview).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      previewMode: "loop-boundary",
      turn: "start",
      spec: {
        version: 4,
        loopMode: "pingpong",
        sourceRange: { startFrame: 120, endFrameExclusive: 360 },
      },
    });
    expect(request).not.toHaveProperty("centerSeconds");
  });

  it("opens the existing consent dialog instead of starting when RIFE is missing", async () => {
    const api = createApi(false);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();
    fireEvent.click(screen.getByRole("button", { name: "AI 2×" }));
    fireEvent.click(screen.getByRole("button", { name: "最终效果预览" }));

    expect(await screen.findByRole("dialog", { name: "处理工具" })).toBeVisible();
    const row = screen.getByText("RIFE ncnn Vulkan").closest(".dependency-row");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("checkbox")).toBeChecked();
    expect(api.startPreview).not.toHaveBeenCalled();
    expect(api.installDependencies).not.toHaveBeenCalled();
  });

  it("blocks 5K NVENC and applies the explicit aspect-preserving target", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    fireEvent.click(screen.getByLabelText("输出分辨率"));
    fireEvent.click(screen.getByRole("option", { name: "自定义" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "宽" }), { target: { value: "5120" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "高" }), { target: { value: "3200" } });
    fireEvent.click(screen.getByRole("button", { name: "快速 / 较大体积" }));

    expect(screen.getByRole("alert")).toHaveTextContent("单边上限为 4096");
    expect(screen.getByRole("button", { name: "最终效果预览" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "改用高质量 CPU" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "改用高质量 CPU" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "宽" })).toHaveValue(5120);
    expect(screen.getByRole("spinbutton", { name: "高" })).toHaveValue(3200);
    fireEvent.click(screen.getByRole("button", { name: "快速 / 较大体积" }));

    fireEvent.click(screen.getByRole("button", { name: "调整为 4096 × 2560" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "宽" })).toHaveValue(4096);
    expect(screen.getByRole("spinbutton", { name: "高" })).toHaveValue(2560);
    expect(screen.getByRole("button", { name: "最终效果预览" })).toBeEnabled();
  });

  it("shows conservative quality warnings and keeps RIFE disabled by default", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    expect(screen.getByRole("button", { name: "关闭" })).toHaveAttribute("aria-pressed", "true");
    const suitability = screen.getByLabelText("源素材适配评估");
    expect(within(suitability).getByText("2.25×")).toBeVisible();
    expect(within(suitability).getByText("2×")).toBeVisible();
    expect(within(suitability).getByText("1.13×")).toBeVisible();
    expect(within(suitability).getByText(/至少为 1280 × 800/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "AI 2×" }));
    expect(screen.getByText(/插帧可能放大原视频中的拖尾、双线和遮挡错误/)).toBeVisible();
  });

  it("shows released bytes and remaining cache size after immediate cleanup", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();
    await waitFor(() => expect(api.getCacheOverview).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "工作文件与缓存" }));
    fireEvent.click(screen.getByRole("button", { name: "清理缓存" }));
    await waitFor(() => expect(api.cleanupCaches).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/本次释放/)).toHaveTextContent("本次释放 2 GB · 缓存容量充足");
  });

  it("starts the four-variant diagnostic with cache settings", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    openDiagnostic();
    await waitFor(() => expect(api.startDiagnosticPreview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.startDiagnosticPreview).mock.calls[0]?.[0]).toMatchObject({
      cachePolicy: "cleanup-on-success",
      cacheLimitBytes: 50 * 1024 ** 3,
      previewMode: "segment",
    });
    expect(vi.mocked(api.startDiagnosticPreview).mock.calls[0]?.[0]).not.toHaveProperty("centerSeconds");
  });

  it("automatically uses CPU for a 5K target instead of blocking the task", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();
    chooseSelect("输出分辨率", "自定义");
    fireEvent.change(screen.getByRole("spinbutton", { name: "宽" }), { target: { value: "5120" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "高" }), { target: { value: "3200" } });
    expect(screen.getByText("高质量 CPU")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "最终效果预览" }));
    await waitFor(() => expect(api.startPreview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.startPreview).mock.calls[0]?.[0].spec.encoding.encoder).toBe("libx264");
  });

  it("disables manual NVIDIA and explains CPU fallback when the NVENC probe fails", async () => {
    const api = createApi(true);
    const report = doctor(true);
    report.capabilities!.h264Nvenc = { available: false, maxDimension: 4096, error: "driver unavailable" };
    vi.mocked(api.doctor).mockResolvedValue(report);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();
    expect(screen.getByRole("button", { name: "快速 / 较大体积" })).toBeDisabled();
    expect(screen.getByText("高质量 CPU")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "最终效果预览" }));
    await waitFor(() => expect(api.startPreview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.startPreview).mock.calls[0]?.[0].spec.encoding.encoder).toBe("libx264");
  });

  it("commits an edited cache limit without rerunning bootstrap or restoring 50 GiB", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();
    fireEvent.click(screen.getByRole("button", { name: "工作文件与缓存" }));
    const input = screen.getByRole("spinbutton", { name: "缓存上限" });
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue(null);
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.saveCacheSettings).toHaveBeenCalledWith({ policy: "cleanup-on-success", limitBytes: 80 * 1024 ** 3 }));
    expect(input).toHaveValue(80);
    expect(api.getBootstrap).toHaveBeenCalledTimes(1);
  });

  it("does not request single-job cleanup status for a multi-cache diagnostic", async () => {
    const api = createApi(true);
    let listener: ((event: TaskEvent) => void) | undefined;
    api.onTaskEvent = vi.fn().mockImplementation((callback) => {
      listener = callback;
      return () => undefined;
    });
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    openDiagnostic();
    await waitFor(() => expect(api.startDiagnosticPreview).toHaveBeenCalledTimes(1));
    listener?.({
      taskId: "diagnostic-task",
      kind: "diagnostic-preview",
      type: "progress",
      progress: {
        jobId: "a".repeat(20),
        phase: "encode",
        current: 1,
        total: 4,
        percent: 25,
        etaMs: null,
        message: "diagnostic variant A",
      },
    });
    listener?.({
      taskId: "diagnostic-task",
      kind: "diagnostic-preview",
      type: "complete",
      result: { variants: [], cache: {} },
    });

    await waitFor(() => expect(api.getCacheOverview).toHaveBeenCalled());
    expect(api.getCleanupStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "清理..." })).not.toBeInTheDocument();
  });

  it("uses custom listboxes for every processing select without changing settings behavior", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    chooseSelect("输出分辨率", "QHD · 2560 × 1440");
    expect(screen.getByLabelText("输出分辨率")).toHaveTextContent("QHD · 2560 × 1440");

    chooseSelect("AI 模型", "通用与实拍");
    fireEvent.click(screen.getByRole("button", { name: "AI 性能设置" }));
    chooseSelect("Vulkan GPU", "Vulkan GPU 0");
    chooseSelect("AI 倍率", "4×");

    fireEvent.click(screen.getByRole("button", { name: "工作文件与缓存" }));
    chooseSelect("缓存策略", "保留 24 小时");
    await waitFor(() => expect(api.saveCacheSettings).toHaveBeenCalledWith({ policy: "keep-24-hours", limitBytes: 50 * 1024 ** 3 }));

    expect(document.querySelector("select")).not.toBeInTheDocument();
  });

  it("persists appearance changes and keeps a single primary action", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    const { container } = render(<App />);
    await screen.findByText("v0.3.2");

    expect(container.querySelectorAll(".button.primary")).toHaveLength(1);
    fireEvent.click(container.querySelector(".tool-status-button") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    fireEvent.click(screen.getByRole("button", { name: "海蓝" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("wallpaper.appearance.v2")).toContain('"themeMode":"dark"');
    expect(localStorage.getItem("wallpaper.appearance.v2")).toContain('"accent":"blue"');
  });

  it("closes appearance settings with Escape", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    const { container } = render(<App />);
    await screen.findByText("v0.3.2");

    fireEvent.click(container.querySelector(".tool-status-button") as HTMLButtonElement);
    expect(screen.getByRole("dialog", { name: "外观设置" })).toBeVisible();
    fireEvent.click(screen.getByLabelText("排版风格"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "外观设置" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "外观设置" })).not.toBeInTheDocument();
  });

  it("offers all typography presets and reveals managed custom fonts without reloading video", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    const { container } = render(<App />);
    await loadVideo();
    mediaLoad.mockClear();
    fireEvent.click(container.querySelector(".tool-status-button") as HTMLButtonElement);

    chooseSelect("排版风格", "温暖编辑感");
    expect(document.documentElement.dataset.typography).toBe("warm-editorial");
    expect(localStorage.getItem("wallpaper.appearance.v2")).toContain('"preset":"warm-editorial"');
    fireEvent.click(screen.getByRole("button", { name: "高级排版" }));
    chooseSelect("标题排版范围", "所有标题");
    expect(document.documentElement.dataset.titleScope).toBe("all-titles");
    expect(localStorage.getItem("wallpaper.appearance.v2")).toContain('"titleScope":"all-titles"');
    chooseSelect("排版风格", "自定义");
    expect(screen.getByLabelText("界面字体")).toBeVisible();
    expect(screen.getByLabelText("展示字体")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "导入" })).toHaveLength(2);
    expect(mediaLoad).not.toHaveBeenCalled();
  });

  it("switches semantic icon presets without changing layout or reloading video", async () => {
    const api = createApi(true);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    const { container } = render(<App />);
    await loadVideo();
    mediaLoad.mockClear();
    const primaryBefore = container.querySelectorAll(".button.primary").length;
    fireEvent.click(container.querySelector(".tool-status-button") as HTMLButtonElement);

    chooseSelect("图标风格", "柔和线性");
    expect(document.documentElement.dataset.iconStyle).toBe("soft-outline");
    expect(localStorage.getItem("wallpaper.appearance.v2")).toContain('"preset":"soft-outline"');
    const previewIcons = screen.getByLabelText("图标风格预览").querySelectorAll("svg");
    expect(previewIcons.length).toBe(5);
    expect([...previewIcons].every((icon) => icon.getAttribute("stroke-width") === "2")).toBe(true);
    expect(container.querySelectorAll(".button.primary")).toHaveLength(primaryBefore);
    expect(mediaLoad).not.toHaveBeenCalled();
  });

  it("previews and applies a sanitized partial icon pack with per-icon fallback", async () => {
    const icon = {
      viewBox: [0, 0, 24, 24] as [number, number, number, number],
      attributes: { fill: "none" as const, stroke: "currentColor" as const },
      nodes: [{ tag: "circle" as const, attributes: { cx: 12, cy: 12, r: 7 }, children: [] }],
      warnings: [],
    };
    const pack = { schemaVersion: 1 as const, name: "Warm Safe", version: "1.0.0", defaultSize: 20, icons: { settings: icon }, warnings: ["未提供的语义图标将使用内置图标。"] };
    const metadata = { id: `icon-pack-${"b".repeat(32)}`, name: pack.name, version: pack.version, defaultSize: pack.defaultSize, iconNames: ["settings" as const], warnings: pack.warnings };
    const { id: _id, ...previewMetadata } = metadata;
    const api = createApi(true);
    vi.mocked(api.getAppearanceResources)
      .mockResolvedValueOnce({ fonts: [], iconPacks: [], iconOverrides: [] })
      .mockResolvedValue({ fonts: [], iconPacks: [metadata], iconOverrides: [] });
    vi.mocked(api.previewIconPackImport).mockResolvedValue({ importId: "icon-preview-1", ...previewMetadata, pack });
    vi.mocked(api.commitIconPackImport).mockResolvedValue(metadata);
    vi.mocked(api.readIconPackResource).mockResolvedValue(pack);
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    const { container } = render(<App />);
    await loadVideo();
    mediaLoad.mockClear();
    fireEvent.click(container.querySelector(".tool-status-button") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "导入图标包" }));

    const dialog = await screen.findByRole("dialog", { name: "图标包导入预览" });
    expect(dialog).toHaveTextContent("Warm Safe");
    expect(dialog.querySelector(".icon-preview-surface.is-light")).not.toBeNull();
    expect(dialog.querySelector(".icon-preview-surface.is-dark")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认并应用" }));
    await waitFor(() => expect(api.commitIconPackImport).toHaveBeenCalledWith("icon-preview-1"));
    await waitFor(() => expect(localStorage.getItem("wallpaper.appearance.v2")).toContain(metadata.id));
    expect(container.querySelector('[data-icon-name="settings"][data-icon-source="sanitized-pack"]')).not.toBeNull();
    expect(container.querySelector('[data-icon-name="play"][data-icon-preset="fine-outline"]')).not.toBeNull();
    expect(mediaLoad).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除图标包 Warm Safe" }));
    expect(screen.getByRole("dialog", { name: "删除图标包" })).toHaveTextContent("正在使用");
    fireEvent.click(screen.getByRole("button", { name: "删除图标包" }));
    await waitFor(() => expect(api.deleteIconPackResource).toHaveBeenCalledWith(metadata.id));
    expect(localStorage.getItem("wallpaper.appearance.v2")).not.toContain(metadata.id);
  });

  it("applies an individual override before the preset, exports IDs, and restores it", async () => {
    const icon = {
      viewBox: [0, 0, 24, 24] as [number, number, number, number],
      attributes: { fill: "none" as const, stroke: "currentColor" as const },
      nodes: [{ tag: "rect" as const, attributes: { x: 5, y: 5, width: 14, height: 14 }, children: [] }],
      warnings: [],
    };
    const metadata = { id: `icon-${"c".repeat(32)}`, semanticName: "settings" as const, kind: "vector" as const, sizeBytes: 512, warnings: [] };
    const api = createApi(true);
    vi.mocked(api.getAppearanceResources)
      .mockResolvedValueOnce({ fonts: [], iconPacks: [], iconOverrides: [] })
      .mockResolvedValue({ fonts: [], iconPacks: [], iconOverrides: [metadata] });
    vi.mocked(api.previewIconOverrideImport).mockResolvedValue({ importId: "override-preview-1", semanticName: "settings", kind: "vector", sizeBytes: 512, warnings: [], icon });
    vi.mocked(api.commitIconOverrideImport).mockResolvedValue(metadata);
    vi.mocked(api.readIconOverrideResource).mockResolvedValue({ kind: "vector", icon });
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    const { container } = render(<App />);
    await waitFor(() => expect(api.getAppearanceResources).toHaveBeenCalledTimes(1));
    fireEvent.click(container.querySelector(".tool-status-button") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "单图标覆盖" }));
    fireEvent.click(screen.getByRole("button", { name: "替换" }));

    expect(await screen.findByRole("dialog", { name: "单图标替换预览" })).toHaveTextContent("设置");
    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    await waitFor(() => expect(api.commitIconOverrideImport).toHaveBeenCalledWith("override-preview-1"));
    expect(container.querySelector('[data-icon-name="settings"][data-icon-source="sanitized-override"]')).not.toBeNull();
    expect(localStorage.getItem("wallpaper.appearance.v2")).toContain(metadata.id);

    fireEvent.click(screen.getByRole("button", { name: "导出图标配置" }));
    await waitFor(() => expect(api.exportIconConfig).toHaveBeenCalledWith({
      schemaVersion: 1,
      preset: "fine-outline",
      packId: null,
      overrides: { settings: metadata.id },
    }));
    expect(JSON.stringify(vi.mocked(api.exportIconConfig).mock.calls[0]?.[0])).not.toContain("C:\\");

    fireEvent.click(screen.getByRole("button", { name: "恢复图标 设置" }));
    await waitFor(() => expect(api.deleteIconOverrideResource).toHaveBeenCalledWith(metadata.id));
    expect(localStorage.getItem("wallpaper.appearance.v2")).not.toContain(metadata.id);
  });

  it("shows appearance import progress and cancels the active import ID", async () => {
    const api = createApi(true);
    let progressListener: ((event: import("../../shared/contracts").AppearanceImportProgress) => void) | undefined;
    let resolvePreview: ((value: null) => void) | undefined;
    api.onAppearanceImportProgress = vi.fn().mockImplementation((listener) => { progressListener = listener; return () => undefined; });
    api.previewIconPackImport = vi.fn().mockReturnValue(new Promise<null>((resolve) => { resolvePreview = resolve; }));
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    const { container } = render(<App />);
    fireEvent.click(container.querySelector(".tool-status-button") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "导入图标包" }));
    act(() => progressListener?.({ importId: "import-running-1", kind: "icon-pack", stage: "sanitizing", percent: 64, message: "正在清理 settings" }));

    expect(screen.getByRole("status")).toHaveTextContent("正在清理 settings");
    expect(screen.getByRole("status")).toHaveTextContent("64%");
    fireEvent.click(screen.getByRole("button", { name: "取消导入" }));
    await waitFor(() => expect(api.cancelAppearanceImport).toHaveBeenCalledWith("import-running-1"));
    await act(async () => { resolvePreview?.(null); });
    expect(screen.queryByText("图标包导入失败")).not.toBeInTheDocument();
  });

  it("previews, confirms, applies, and deletes a managed font with active fallback", async () => {
    const font = {
      id: `font-${"a".repeat(32)}`,
      familyName: "Test Sans",
      fullName: "Test Sans Regular",
      format: "woff2" as const,
      sizeBytes: 1024,
      hasChineseCoverage: false,
      warnings: ["该字体缺少部分中文字符，将使用中文回退字体。"],
    };
    const api = createApi(true);
    vi.mocked(api.getAppearanceResources)
      .mockResolvedValueOnce({ fonts: [], iconPacks: [], iconOverrides: [] })
      .mockResolvedValue({ fonts: [font], iconPacks: [], iconOverrides: [] });
    vi.mocked(api.previewFontImport).mockResolvedValue({
      importId: "font-preview-1",
      familyName: font.familyName,
      fullName: font.fullName,
      format: font.format,
      sizeBytes: font.sizeBytes,
      hasChineseCoverage: font.hasChineseCoverage,
      warnings: font.warnings,
      previewData: new Uint8Array([1, 2, 3]),
    });
    vi.mocked(api.commitFontImport).mockResolvedValue(font);
    vi.mocked(api.readFontResource).mockResolvedValue(new Uint8Array([1, 2, 3]));
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    const { container } = render(<App />);
    await waitFor(() => expect(api.getAppearanceResources).toHaveBeenCalledTimes(1));
    fireEvent.click(container.querySelector(".tool-status-button") as HTMLButtonElement);
    chooseSelect("排版风格", "自定义");
    fireEvent.click(screen.getAllByRole("button", { name: "导入" })[0]!);

    expect(await screen.findByRole("dialog", { name: "字体导入预览" })).toHaveTextContent("Test Sans Regular");
    expect(screen.getByText("该字体缺少部分中文字符，将使用中文回退字体。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认并应用" }));
    await waitFor(() => expect(api.commitFontImport).toHaveBeenCalledWith("font-preview-1"));
    expect(localStorage.getItem("wallpaper.appearance.v2")).toContain(font.id);
    expect((await screen.findAllByText("Test Sans")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "删除字体 Test Sans" }));
    expect(screen.getByRole("dialog", { name: "删除字体" })).toHaveTextContent("正在使用");
    fireEvent.click(screen.getByRole("button", { name: "删除字体" }));
    await waitFor(() => expect(api.deleteFontResource).toHaveBeenCalledWith(font.id));
    expect(localStorage.getItem("wallpaper.appearance.v2")).not.toContain(font.id);
  });

  it("cancels a font preview in both renderer and resource store", async () => {
    const api = createApi(true);
    vi.mocked(api.previewFontImport).mockResolvedValue({
      importId: "font-preview-cancel",
      familyName: "Preview Font",
      fullName: "Preview Font Regular",
      format: "woff2",
      sizeBytes: 100,
      hasChineseCoverage: true,
      warnings: [],
      previewData: new Uint8Array([1]),
    });
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    const { container } = render(<App />);
    fireEvent.click(container.querySelector(".tool-status-button") as HTMLButtonElement);
    chooseSelect("排版风格", "自定义");
    fireEvent.click(screen.getAllByRole("button", { name: "导入" })[1]!);
    await screen.findByRole("dialog", { name: "字体导入预览" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(api.cancelAppearanceImport).toHaveBeenCalledWith("font-preview-cancel");
    expect(screen.queryByRole("dialog", { name: "字体导入预览" })).not.toBeInTheDocument();
  });

  it("opens the completed process output in Explorer", async () => {
    const api = createApi(true);
    let listener: ((event: TaskEvent) => void) | undefined;
    api.onTaskEvent = vi.fn().mockImplementation((callback) => { listener = callback; return () => undefined; });
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await waitFor(() => expect(api.startProcess).toHaveBeenCalledTimes(1));
    listener?.({ taskId: "process-task", kind: "process", type: "complete", result: { outputPath: "D:\\source.wallpaper.mp4", jobId: "a".repeat(20) } });

    const openButton = await screen.findByRole("button", { name: "打开输出位置" });
    expect(openButton.closest(".task-middle-region")).not.toBeNull();
    expect(document.querySelector(".task-status-region")).not.toBeNull();
    expect(document.querySelector(".dock-actions")).not.toBeNull();
    expect(document.querySelectorAll(".button.primary")).toHaveLength(1);
    fireEvent.click(openButton);
    expect(api.showItemInFolder).toHaveBeenCalledWith("D:\\source.wallpaper.mp4");
  });

  it("explains a last-moment output collision without offering overwrite", async () => {
    const api = createApi(true);
    let listener: ((event: TaskEvent) => void) | undefined;
    api.onTaskEvent = vi.fn().mockImplementation((callback) => { listener = callback; return () => undefined; });
    Object.defineProperty(window, "wallpaperApi", { configurable: true, value: api });
    render(<App />);
    await loadVideo();

    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await waitFor(() => expect(api.startProcess).toHaveBeenCalledTimes(1));
    listener?.({
      taskId: "process-task",
      kind: "process",
      type: "error",
      error: { code: "E_OUTPUT_EXISTS", message: "Output file already exists" },
    });

    expect((await screen.findAllByText(/请重新点击开始处理以获取下一个编号/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /覆盖/ })).not.toBeInTheDocument();
  });
});
