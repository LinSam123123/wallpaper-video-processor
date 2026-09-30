import type { SerializedError } from "../../shared/contracts";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function gib(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? `${(value / 1024 ** 3).toFixed(2)} GiB`
    : null;
}

const CHECK_LABELS: Record<string, string> = {
  width: "宽度",
  height: "高度",
  sampleAspectRatio: "像素宽高比",
  frameRate: "帧率",
  frameCount: "帧数",
  durationSeconds: "时长",
  codec: "编码格式",
  pixelFormat: "像素格式",
  colorSpace: "色彩空间",
  colorPrimaries: "色彩原色",
  colorTransfer: "色彩传递特性",
  colorRange: "色彩范围",
  audioStreams: "音轨数量",
};

function diagnosticValue(value: unknown, present: boolean): string {
  if (!present || value === undefined || value === null || value === "") return "未声明";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function failedCheckMessages(details: Record<string, unknown>): string[] {
  if (!Array.isArray(details.failedChecks)) return [];
  return details.failedChecks.flatMap((value) => {
    const check = record(value);
    if (!check || typeof check.name !== "string") return [];
    const label = CHECK_LABELS[check.name] ?? check.name;
    const expected = diagnosticValue(check.expected, Object.hasOwn(check, "expected"));
    const actual = diagnosticValue(check.actual, Object.hasOwn(check, "actual"));
    return [`${label}：期望 ${expected}，实际 ${actual}`];
  });
}

function encoderResolutionMessage(details: Record<string, unknown>): string | null {
  const requested = record(details.requested);
  const suggested = record(details.suggestedTarget);
  if (details.encoder !== "h264_nvenc" || !requested || !suggested ||
      typeof requested.width !== "number" || typeof requested.height !== "number" ||
      typeof suggested.width !== "number" || typeof suggested.height !== "number" ||
      typeof details.maxDimension !== "number") return null;
  return `单边上限 ${details.maxDimension} · 可改用高质量 CPU 保留 ${requested.width} × ${requested.height}，或调整为 ${suggested.width} × ${suggested.height}`;
}

export function formatSerializedError(error: SerializedError): string {
  const details = record(error.details);
  if (!details) return error.message;
  const path = typeof details.path === "string" ? details.path : null;
  const required = gib(details.requiredBytes);
  const available = gib(details.availableBytes);
  const parts = [
    error.message,
    path ? `位置：${path}` : null,
    required ? `需要：${required}` : null,
    available ? `可用：${available}` : null,
    error.code === "E_ENCODER_UNSUPPORTED_RESOLUTION" ? encoderResolutionMessage(details) : null,
    ...failedCheckMessages(details),
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}
