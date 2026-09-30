import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../shared/channels.js";
import type {
  DesktopBootstrap,
  DoctorReport,
  CleanupRequest,
  CleanupStatus,
  CleanupStatusRequest,
  CacheCleanupRequest,
  CacheOverview,
  CacheRequest,
  CacheSettings,
  AppearanceResourceCatalog,
  FontImportPreview,
  FontResourceMetadata,
  IconPackImportPreview,
  IconPackMetadata,
  IconOverrideImportPreview,
  IconOverrideMetadata,
  IconOverrideResource,
  IconConfigSnapshot,
  AppearanceImportProgress,
  SanitizedIconPack,
  InstallDependenciesRequest,
  InstallDependenciesResult,
  MediaInfo,
  StartTaskRequest,
  TaskEvent,
  WallpaperApi,
} from "../shared/contracts.js";

const api: WallpaperApi = {
  getBootstrap: async () => await ipcRenderer.invoke(IPC.bootstrap) as DesktopBootstrap,
  doctor: async () => await ipcRenderer.invoke(IPC.doctor) as DoctorReport,
  inspect: async (inputPath) => await ipcRenderer.invoke(IPC.inspect, inputPath) as MediaInfo,
  selectInput: async () => await ipcRenderer.invoke(IPC.selectInput) as string | null,
  selectOutput: async (inputPath) => await ipcRenderer.invoke(IPC.selectOutput, inputPath) as string | null,
  resolveAvailableOutputPath: async (preferredPath) => await ipcRenderer.invoke(IPC.resolveAvailableOutputPath, preferredPath) as string,
  selectWorkDirectory: async (initialPath) => await ipcRenderer.invoke(IPC.selectWorkDirectory, initialPath) as string | null,
  registerMedia: async (inputPath) => await ipcRenderer.invoke(IPC.registerMedia, inputPath) as string,
  startPreview: async (request: StartTaskRequest) => await ipcRenderer.invoke(IPC.startPreview, request) as { taskId: string },
  startLoopPreview: async (request: StartTaskRequest) => await ipcRenderer.invoke(IPC.startLoopPreview, request) as { taskId: string },
  startDiagnosticPreview: async (request: StartTaskRequest) => await ipcRenderer.invoke(IPC.startDiagnosticPreview, request) as { taskId: string },
  startProcess: async (request: StartTaskRequest) => await ipcRenderer.invoke(IPC.startProcess, request) as { taskId: string },
  cancel: async (taskId) => { await ipcRenderer.invoke(IPC.cancel, taskId); },
  getCleanupStatus: async (request: CleanupStatusRequest) => await ipcRenderer.invoke(IPC.cleanupStatus, request) as CleanupStatus,
  cleanup: async (request: CleanupRequest) => { await ipcRenderer.invoke(IPC.cleanup, request); },
  getCacheOverview: async (request: CacheRequest) => await ipcRenderer.invoke(IPC.cacheOverview, request) as CacheOverview,
  cleanupCaches: async (request: CacheCleanupRequest) => await ipcRenderer.invoke(IPC.cacheCleanup, request) as CacheOverview,
  saveCacheSettings: async (settings: CacheSettings) => await ipcRenderer.invoke(IPC.cacheSettings, settings) as CacheSettings,
  installDependencies: async (request: InstallDependenciesRequest) =>
    await ipcRenderer.invoke(IPC.installDependencies, request) as InstallDependenciesResult,
  openExternal: async (url) => { await ipcRenderer.invoke(IPC.openExternal, url); },
  showItemInFolder: async (path) => { await ipcRenderer.invoke(IPC.showItemInFolder, path); },
  copyText: async (text) => { await ipcRenderer.invoke(IPC.copyText, text); },
  getAppearanceResources: async () => await ipcRenderer.invoke(IPC.appearanceResources) as AppearanceResourceCatalog,
  previewFontImport: async () => await ipcRenderer.invoke(IPC.previewFontImport) as FontImportPreview | null,
  previewIconPackImport: async () => await ipcRenderer.invoke(IPC.previewIconPackImport) as IconPackImportPreview | null,
  previewIconOverrideImport: async (semanticName) => await ipcRenderer.invoke(IPC.previewIconOverrideImport, semanticName) as IconOverrideImportPreview | null,
  cancelAppearanceImport: async (importId) => { await ipcRenderer.invoke(IPC.cancelAppearanceImport, importId); },
  commitFontImport: async (importId) => await ipcRenderer.invoke(IPC.commitFontImport, importId) as FontResourceMetadata,
  commitIconPackImport: async (importId) => await ipcRenderer.invoke(IPC.commitIconPackImport, importId) as IconPackMetadata,
  commitIconOverrideImport: async (importId) => await ipcRenderer.invoke(IPC.commitIconOverrideImport, importId) as IconOverrideMetadata,
  readFontResource: async (fontId) => await ipcRenderer.invoke(IPC.readFontResource, fontId) as Uint8Array,
  readIconPackResource: async (packId) => await ipcRenderer.invoke(IPC.readIconPackResource, packId) as SanitizedIconPack,
  readIconOverrideResource: async (iconId) => await ipcRenderer.invoke(IPC.readIconOverrideResource, iconId) as IconOverrideResource,
  deleteFontResource: async (fontId) => { await ipcRenderer.invoke(IPC.deleteFontResource, fontId); },
  deleteIconPackResource: async (packId) => { await ipcRenderer.invoke(IPC.deleteIconPackResource, packId); },
  deleteIconOverrideResource: async (iconId) => { await ipcRenderer.invoke(IPC.deleteIconOverrideResource, iconId); },
  exportIconConfig: async (config: IconConfigSnapshot) => await ipcRenderer.invoke(IPC.exportIconConfig, config) as boolean,
  pathForFile: (file) => webUtils.getPathForFile(file),
  onTaskEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TaskEvent): void => listener(value);
    ipcRenderer.on(IPC.taskEvent, handler);
    return () => ipcRenderer.removeListener(IPC.taskEvent, handler);
  },
  onAppearanceImportProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AppearanceImportProgress): void => listener(value);
    ipcRenderer.on(IPC.appearanceImportProgress, handler);
    return () => ipcRenderer.removeListener(IPC.appearanceImportProgress, handler);
  },
};

contextBridge.exposeInMainWorld("wallpaperApi", api);
