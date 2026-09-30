import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AppError } from "./errors.js";
import { parseRational } from "./pure.js";
import { runCommand, type CommandRunner } from "./process-runner.js";
import type {
  FullDecodeVerification,
  MediaInfo,
  SourceFrameRange,
  VerificationCheck,
  VerificationExpectation,
  VerificationHealth,
  VerificationHealthSegment,
  VerificationResult,
} from "./types.js";

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  pix_fmt?: string;
  color_space?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_range?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  nb_read_frames?: string;
  duration?: string;
}

interface FfprobeFrame {
  stream_index?: number;
  best_effort_timestamp_time?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  frames?: FfprobeFrame[];
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
  };
}

function numberOrZero(value: string | number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function detectFrameRateMode(
  frames: FfprobeFrame[] | undefined,
  averageFrameRate: number,
  nominalFrameRate: number,
): "constant" | "variable" | "unknown" {
  const timestamps = (frames ?? [])
    .map((frame) => Number(frame.best_effort_timestamp_time))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length >= 3 && averageFrameRate > 0) {
    const expectedInterval = 1 / averageFrameRate;
    const tolerance = Math.max(0.0005, expectedInterval * 0.01);
    for (let index = 1; index < timestamps.length; index += 1) {
      const interval = (timestamps[index] as number) - (timestamps[index - 1] as number);
      if (interval <= 0 || Math.abs(interval - expectedInterval) > tolerance) return "variable";
    }
    return "constant";
  }
  if (averageFrameRate > 0 && nominalFrameRate > 0) {
    const tolerance = Math.max(0.001, averageFrameRate * 0.001);
    return Math.abs(averageFrameRate - nominalFrameRate) <= tolerance ? "constant" : "variable";
  }
  return "unknown";
}

export async function inspectMedia(
  inputPath: string,
  options: { ffprobePath?: string; runner?: CommandRunner; signal?: AbortSignal } = {},
): Promise<MediaInfo> {
  const absolutePath = resolve(inputPath);
  let fileSize = 0;
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error("not a file");
    fileSize = info.size;
  } catch (error) {
    throw new AppError("E_INPUT_NOT_FOUND", `Input video does not exist: ${absolutePath}`, { inputPath: absolutePath }, { cause: error });
  }

  const runner = options.runner ?? runCommand;
  let parsed: FfprobeOutput;
  try {
    const result = await runner({
      executable: options.ffprobePath ?? "ffprobe",
      args: [
        "-v", "error",
        "-count_frames",
        "-show_entries",
        "format=format_name,duration,size:stream=index,codec_type,codec_name,width,height,sample_aspect_ratio,display_aspect_ratio,pix_fmt,color_space,color_primaries,color_transfer,color_range,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,duration:frame=stream_index,best_effort_timestamp_time",
        "-of", "json",
        absolutePath,
      ],
    }, { signal: options.signal });
    parsed = JSON.parse(result.stdout) as FfprobeOutput;
  } catch (error) {
    if (error instanceof AppError && ["E_INPUT_NOT_FOUND", "E_DEPENDENCY_MISSING", "E_CANCELLED"].includes(error.code)) throw error;
    throw new AppError("E_MEDIA_INSPECTION_FAILED", `Could not inspect video: ${absolutePath}`, undefined, { cause: error });
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video || !video.width || !video.height) {
    throw new AppError("E_UNSUPPORTED_MEDIA", "Input contains no readable video stream", { inputPath: absolutePath });
  }
  const formatDuration = numberOrZero(parsed.format?.duration);
  const streamDuration = numberOrZero(video.duration);
  const durationSeconds = formatDuration || streamDuration;
  const averageFrameRate = parseRational(video.avg_frame_rate);
  const nominalFrameRate = parseRational(video.r_frame_rate);
  const frameRate = averageFrameRate || nominalFrameRate;
  const explicitFrames = numberOrZero(video.nb_read_frames) || numberOrZero(video.nb_frames);
  const frameCount = Math.max(0, Math.round(explicitFrames || durationSeconds * frameRate));
  if (frameRate <= 0 || frameCount <= 0) {
    throw new AppError("E_UNSUPPORTED_MEDIA", "Video frame rate or frame count could not be determined", {
      frameRate,
      frameCount,
    });
  }

  return {
    path: absolutePath,
    format: parsed.format?.format_name ?? "unknown",
    durationSeconds,
    sizeBytes: numberOrZero(parsed.format?.size) || fileSize,
    video: {
      index: video.index ?? 0,
      codec: video.codec_name ?? "unknown",
      width: video.width,
      height: video.height,
      ...(video.sample_aspect_ratio ? { sampleAspectRatio: video.sample_aspect_ratio } : {}),
      ...(video.display_aspect_ratio ? { displayAspectRatio: video.display_aspect_ratio } : {}),
      ...(video.pix_fmt ? { pixelFormat: video.pix_fmt } : {}),
      ...(video.color_space ? { colorSpace: video.color_space } : {}),
      ...(video.color_primaries ? { colorPrimaries: video.color_primaries } : {}),
      ...(video.color_transfer ? { colorTransfer: video.color_transfer } : {}),
      ...(video.color_range ? { colorRange: video.color_range } : {}),
      frameRate,
      frameRateMode: detectFrameRateMode(
        parsed.frames?.filter((frame) => frame.stream_index === undefined || frame.stream_index === (video.index ?? 0)),
        averageFrameRate,
        nominalFrameRate,
      ),
      frameCount,
      durationSeconds: streamDuration || durationSeconds,
    },
    audio: streams
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => ({ index: stream.index ?? 0, codec: stream.codec_name ?? "unknown" })),
  };
}

function exactCheck(name: string, expected: unknown, actual: unknown): VerificationCheck {
  return { name, expected, actual, passed: expected === actual };
}

function toleranceCheck(name: string, expected: number, actual: number, tolerance: number): VerificationCheck {
  return { name, expected, actual, passed: Math.abs(expected - actual) <= tolerance };
}

function finiteTimestamp(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function healthSegment(start: number, end: number, reportedDuration?: number): VerificationHealthSegment {
  const normalizedEnd = Math.max(start, end);
  const duration = reportedDuration === undefined ? normalizedEnd - start : Math.max(0, reportedDuration);
  return {
    startSeconds: Number(start.toFixed(6)),
    endSeconds: Number(normalizedEnd.toFixed(6)),
    durationSeconds: Number(duration.toFixed(6)),
  };
}

function parseBlackSegments(stderr: string): VerificationHealthSegment[] {
  return [...stderr.matchAll(/black_start:\s*([0-9]+(?:\.[0-9]+)?)\s+black_end:\s*([0-9]+(?:\.[0-9]+)?)\s+black_duration:\s*([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => healthSegment(Number(match[1]), Number(match[2]), Number(match[3])));
}

function parseFreezeSegments(stderr: string, mediaDuration: number): VerificationHealthSegment[] {
  const segments: VerificationHealthSegment[] = [];
  let start: number | undefined;
  let duration: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const nextStart = finiteTimestamp(/(?:lavfi\.freezedetect\.)?freeze_start:\s*([0-9]+(?:\.[0-9]+)?)/.exec(line)?.[1]);
    if (nextStart !== undefined) {
      if (start !== undefined) segments.push(healthSegment(start, nextStart, duration));
      start = nextStart;
      duration = undefined;
    }
    const nextDuration = finiteTimestamp(/(?:lavfi\.freezedetect\.)?freeze_duration:\s*([0-9]+(?:\.[0-9]+)?)/.exec(line)?.[1]);
    if (nextDuration !== undefined) duration = nextDuration;
    const end = finiteTimestamp(/(?:lavfi\.freezedetect\.)?freeze_end:\s*([0-9]+(?:\.[0-9]+)?)/.exec(line)?.[1]);
    if (end !== undefined && start !== undefined) {
      segments.push(healthSegment(start, end, duration));
      start = undefined;
      duration = undefined;
    }
  }
  if (start !== undefined) segments.push(healthSegment(start, Math.max(start, mediaDuration), duration));
  return segments;
}

function coveredDuration(segments: VerificationHealthSegment[]): number {
  const sorted = segments
    .map((segment) => ({ start: segment.startSeconds, end: segment.endSeconds }))
    .sort((left, right) => left.start - right.start);
  let total = 0;
  let currentStart: number | undefined;
  let currentEnd = 0;
  for (const segment of sorted) {
    if (currentStart === undefined) {
      currentStart = segment.start;
      currentEnd = segment.end;
    } else if (segment.start <= currentEnd) currentEnd = Math.max(currentEnd, segment.end);
    else {
      total += currentEnd - currentStart;
      currentStart = segment.start;
      currentEnd = segment.end;
    }
  }
  return total + (currentStart === undefined ? 0 : currentEnd - currentStart);
}

function catastrophicCoverage(segments: VerificationHealthSegment[], mediaDuration: number): boolean {
  if (mediaDuration <= 0 || segments.length === 0) return false;
  const longest = Math.max(...segments.map((segment) => segment.durationSeconds));
  return coveredDuration(segments) >= mediaDuration * 0.98 ||
    longest >= Math.max(2, mediaDuration * 0.9);
}

async function verifyDecodedHealth(
  inputPath: string,
  media: MediaInfo,
  options: {
    ffmpegPath: string;
    runner: CommandRunner;
    signal?: AbortSignal;
    sourceRange?: SourceFrameRange;
    sourceRanges?: SourceFrameRange[];
  },
): Promise<VerificationHealth> {
  if (options.sourceRange && options.sourceRanges) {
    throw new AppError("E_INVALID_CONFIG", "Decoded health reference cannot use sourceRange and sourceRanges together");
  }
  const requestedRanges = options.sourceRanges ?? (options.sourceRange ? [options.sourceRange] : undefined);
  const normalizedRanges = requestedRanges
    ? requestedRanges
        .map((range) => ({ ...range }))
        .sort((left, right) => left.startFrame - right.startFrame)
        .reduce<SourceFrameRange[]>((ranges, range) => {
          if (!Number.isSafeInteger(range.startFrame) || !Number.isSafeInteger(range.endFrameExclusive) ||
              range.startFrame < 0 || range.endFrameExclusive <= range.startFrame ||
              range.endFrameExclusive > media.video.frameCount) {
            throw new AppError("E_INVALID_CONFIG", "Decoded health reference range is outside the source video", {
              sourceRange: range,
              sourceFrameCount: media.video.frameCount,
            });
          }
          const previous = ranges.at(-1);
          if (previous && range.startFrame <= previous.endFrameExclusive) {
            previous.endFrameExclusive = Math.max(previous.endFrameExclusive, range.endFrameExclusive);
          } else ranges.push(range);
          return ranges;
        }, [])
    : undefined;
  if (normalizedRanges?.length === 0) {
    throw new AppError("E_INVALID_CONFIG", "Decoded health reference requires at least one source range");
  }
  const selectedFrameCount = normalizedRanges?.reduce(
    (total, range) => total + range.endFrameExclusive - range.startFrame,
    0,
  );
  const mediaDuration = selectedFrameCount !== undefined
    ? selectedFrameCount / media.video.frameRate
    : Math.max(
        media.durationSeconds,
        media.video.durationSeconds,
        media.video.frameCount / media.video.frameRate,
      );
  const rangeFilters = normalizedRanges?.length === 1
    ? [
        `trim=start_frame=${normalizedRanges[0]?.startFrame}:end_frame=${normalizedRanges[0]?.endFrameExclusive}`,
        "setpts=PTS-STARTPTS",
      ]
    : normalizedRanges && normalizedRanges.length > 1
      ? [
          `select=${normalizedRanges.map((range) =>
            `between(n\\,${range.startFrame}\\,${range.endFrameExclusive - 1})`).join("+")}`,
          `setpts=N/(${media.video.frameRate}*TB)`,
        ]
      : [];
  const healthFilters = [
    ...rangeFilters,
    "blackdetect=d=0.04:pic_th=0.98:pix_th=0.10",
    "freezedetect=n=-60dB:d=2",
  ];
  try {
    const result = await options.runner({
      executable: options.ffmpegPath,
      args: [
        "-hide_banner", "-loglevel", "info", "-nostdin", "-xerror",
        "-i", resolve(inputPath),
        "-map", "0:v:0", "-an",
        "-vf", healthFilters.join(","),
        "-f", "null", "-",
      ],
    }, { signal: options.signal });
    const blackSegments = parseBlackSegments(result.stderr);
    const freezeSegments = parseFreezeSegments(result.stderr, mediaDuration);
    return {
      fullDecodeCompleted: true,
      blackSegments,
      freezeSegments,
      catastrophicBlack: catastrophicCoverage(blackSegments, mediaDuration),
      catastrophicFreeze: catastrophicCoverage(freezeSegments, mediaDuration),
    };
  } catch (error) {
    if (error instanceof AppError && (error.code === "E_CANCELLED" || error.code === "E_DEPENDENCY_MISSING")) throw error;
    return {
      fullDecodeCompleted: false,
      blackSegments: [],
      freezeSegments: [],
      catastrophicBlack: false,
      catastrophicFreeze: false,
      decodeError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function verifyMedia(
  inputPath: string,
  expectation: VerificationExpectation,
  options: {
    ffprobePath?: string;
    ffmpegPath?: string;
    runner?: CommandRunner;
    signal?: AbortSignal;
    throwOnFailure?: boolean;
    fullDecode?: FullDecodeVerification;
  } = {},
): Promise<VerificationResult> {
  const media = await inspectMedia(inputPath, options);
  const checks: VerificationCheck[] = [];
  if (expectation.width !== undefined) checks.push(exactCheck("width", expectation.width, media.video.width));
  if (expectation.height !== undefined) checks.push(exactCheck("height", expectation.height, media.video.height));
  if (expectation.sampleAspectRatio !== undefined) {
    checks.push(exactCheck("sampleAspectRatio", expectation.sampleAspectRatio, media.video.sampleAspectRatio));
  }
  if (expectation.frameCount !== undefined) checks.push(exactCheck("frameCount", expectation.frameCount, media.video.frameCount));
  if (expectation.frameRate !== undefined) {
    checks.push(toleranceCheck("frameRate", expectation.frameRate, media.video.frameRate, expectation.frameRateTolerance ?? 0.01));
  }
  if (expectation.durationSeconds !== undefined) {
    checks.push(toleranceCheck("durationSeconds", expectation.durationSeconds, media.durationSeconds, expectation.durationToleranceSeconds ?? 0.05));
  }
  if (expectation.codec !== undefined) checks.push(exactCheck("codec", expectation.codec, media.video.codec));
  if (expectation.pixelFormat !== undefined) checks.push(exactCheck("pixelFormat", expectation.pixelFormat, media.video.pixelFormat));
  if (expectation.colorSpace !== undefined) checks.push(exactCheck("colorSpace", expectation.colorSpace, media.video.colorSpace));
  if (expectation.colorPrimaries !== undefined) checks.push(exactCheck("colorPrimaries", expectation.colorPrimaries, media.video.colorPrimaries));
  if (expectation.colorTransfer !== undefined) checks.push(exactCheck("colorTransfer", expectation.colorTransfer, media.video.colorTransfer));
  if (expectation.colorRange !== undefined) checks.push(exactCheck("colorRange", expectation.colorRange, media.video.colorRange));
  if (expectation.audio === "none") checks.push(exactCheck("audioStreams", 0, media.audio.length));
  const health = options.fullDecode
    ? await verifyDecodedHealth(inputPath, media, {
        ffmpegPath: options.ffmpegPath ?? "ffmpeg",
        runner: options.runner ?? runCommand,
        signal: options.signal,
      })
    : undefined;
  const referenceHealth = typeof options.fullDecode === "object"
    ? await verifyDecodedHealth(options.fullDecode.reference.inputPath, options.fullDecode.reference.media, {
        ffmpegPath: options.ffmpegPath ?? "ffmpeg",
        runner: options.runner ?? runCommand,
        signal: options.signal,
        sourceRange: options.fullDecode.reference.sourceRange,
        sourceRanges: options.fullDecode.reference.sourceRanges,
      })
    : undefined;
  if (health) {
    checks.push(exactCheck("fullDecode", true, health.fullDecodeCompleted));
    if (referenceHealth) {
      checks.push(exactCheck("referenceFullDecode", true, referenceHealth.fullDecodeCompleted));
      if (health.fullDecodeCompleted && referenceHealth.fullDecodeCompleted) {
        checks.push(exactCheck(
          "catastrophicBlack",
          false,
          health.catastrophicBlack && !referenceHealth.catastrophicBlack,
        ));
        checks.push(exactCheck(
          "catastrophicFreeze",
          false,
          health.catastrophicFreeze && !referenceHealth.catastrophicFreeze,
        ));
      }
    } else if (health.fullDecodeCompleted) {
      checks.push(exactCheck("catastrophicBlack", false, health.catastrophicBlack));
      checks.push(exactCheck("catastrophicFreeze", false, health.catastrophicFreeze));
    }
  }
  const result: VerificationResult = {
    passed: checks.every((check) => check.passed),
    media,
    checks,
    ...(health ? { health } : {}),
    ...(referenceHealth ? { referenceHealth } : {}),
  };
  if (!result.passed && options.throwOnFailure) {
    throw new AppError("E_VERIFICATION_FAILED", "Output video did not match its expected properties", {
      failedChecks: checks.filter((check) => !check.passed),
      ...(health ? { health } : {}),
      ...(referenceHealth ? { referenceHealth } : {}),
    });
  }
  return result;
}
