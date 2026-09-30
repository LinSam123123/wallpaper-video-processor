export function formatMetadataBytes(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatFrameRate(frameRate: number): string | null {
  if (!Number.isFinite(frameRate) || frameRate <= 0) return null;
  return `${Number(frameRate.toFixed(2))} fps`;
}

export function formatMediaDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) {
    const value = Number(seconds.toFixed(seconds < 10 && !Number.isInteger(seconds) ? 1 : 0));
    return `${value} 秒`;
  }
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = Math.floor(seconds % 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分 ${rest} 秒` : `${minutes} 分 ${rest} 秒`;
}

export function normalizeCodec(codec: string | null | undefined): string | null {
  const value = codec?.trim();
  if (!value) return null;
  const compact = value.replace(/[._-]/g, "").toLowerCase();
  if (compact === "h264" || compact === "avc" || compact === "avc1") return "H.264";
  if (compact === "h265" || compact === "hevc" || compact === "hev1") return "H.265";
  return value.toUpperCase();
}
