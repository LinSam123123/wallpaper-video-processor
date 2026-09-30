/// <reference types="vite/client" />

import type { WallpaperApi } from "../../shared/contracts";

declare global {
  interface Window {
    wallpaperApi: WallpaperApi;
  }
}

export {};
