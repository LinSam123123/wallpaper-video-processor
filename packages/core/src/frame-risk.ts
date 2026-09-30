export const detectorRevision = "frame-risk-v2";

export const FRAME_RISK_MIN_CAPTURE_BYTES = 2 * 1024 * 1024;
export const FRAME_RISK_MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const FRAME_RISK_CAPTURE_BYTES_PER_FRAME = 2048;

export function frameRiskCaptureBytes(frameCount: number): number {
  const normalized = Number.isFinite(frameCount) ? Math.max(0, Math.ceil(frameCount)) : 0;
  return Math.min(
    FRAME_RISK_MAX_CAPTURE_BYTES,
    Math.max(FRAME_RISK_MIN_CAPTURE_BYTES, normalized * FRAME_RISK_CAPTURE_BYTES_PER_FRAME),
  );
}

export interface FrameRiskThresholds {
  nearDuplicateMaxMafd: number;
  nearDuplicateMaxMeanColorDelta: number;
  nearDuplicateMaxSceneScore: number;
  hardCutMinSceneScore: number;
  hardCutFallbackMinMafd: number;
  hardCutFallbackMinMeanColorDelta: number;
  flashMinBoundarySceneScore: number;
  flashMinBoundaryMafd: number;
  flashMinLumaDelta: number;
  flashMinBlackPercentDelta: number;
  flashMaxReturnMeanColorDelta: number;
  gradualMinTransitions: number;
  gradualMinSceneScore: number;
  gradualMaxSceneScore: number;
  gradualMinMeanColorStep: number;
  gradualMaxMeanColorStep: number;
  gradualMinTotalMeanColorDelta: number;
  gradualMinDirectionCoherence: number;
  highVariationMinMafd: number;
  highVariationMaxSceneScore: number;
  highVariationMaxMeanColorDelta: number;
}

/** Thresholds use FFmpeg's native 0-100 scdet/MAFD and 0-255 signalstats scales. */
export const frameRiskThresholds: Readonly<FrameRiskThresholds> = Object.freeze({
  nearDuplicateMaxMafd: 0.75,
  nearDuplicateMaxMeanColorDelta: 1.5,
  nearDuplicateMaxSceneScore: 0.6,
  hardCutMinSceneScore: 10,
  hardCutFallbackMinMafd: 12,
  hardCutFallbackMinMeanColorDelta: 18,
  flashMinBoundarySceneScore: 7,
  flashMinBoundaryMafd: 10,
  flashMinLumaDelta: 28,
  flashMinBlackPercentDelta: 65,
  flashMaxReturnMeanColorDelta: 5,
  gradualMinTransitions: 3,
  gradualMinSceneScore: 0.8,
  gradualMaxSceneScore: 9.999,
  gradualMinMeanColorStep: 1.2,
  gradualMaxMeanColorStep: 18,
  gradualMinTotalMeanColorDelta: 10,
  gradualMinDirectionCoherence: 0.72,
  highVariationMinMafd: 6,
  highVariationMaxSceneScore: 9.999,
  highVariationMaxMeanColorDelta: 3,
});

export interface FfmpegFrameMetadataSources {
  signalstats?: string;
  scdet?: string;
  blackframe?: string;
  framemd5?: string;
}

export interface FrameRiskFrame {
  frame: number;
  pts?: number;
  ptsTime?: number;
  checksum?: string;
  packetSize?: number;
  yAverage?: number;
  uAverage?: number;
  vAverage?: number;
  saturationAverage?: number;
  temporalOutlier?: number;
  verticalRepeat?: number;
  broadcastRange?: number;
  sceneScore?: number;
  mafd?: number;
  sceneTime?: number;
  blackPercent?: number;
}

export type FrameRiskKind =
  | "exact-duplicate"
  | "cadence"
  | "near-duplicate"
  | "hard-cut"
  | "flash"
  | "gradual-transition"
  | "high-variation";

export interface ExactDuplicateInterval {
  kind: "exact-duplicate";
  startFrame: number;
  endFrameExclusive: number;
  checksum: string;
  holdBoundariesAfter: number[];
  previewFrame: number;
  previewTime?: number;
  score: number;
  recommendedAction: "hold";
}

export interface FrameRiskEvidence {
  sceneScore?: number;
  mafd?: number;
  meanColorDelta?: number;
  lumaDelta?: number;
  blackPercentDelta?: number;
  directionCoherence?: number;
  exposureFrames?: number;
}

export interface FrameRiskEvent {
  kind: Exclude<FrameRiskKind, "exact-duplicate">;
  startFrame: number;
  endFrameExclusive: number;
  previewFrame: number;
  previewTime?: number;
  score: number;
  recommendedAction: "review";
  evidence: FrameRiskEvidence;
}

export interface FrameRiskPreview {
  frame: number;
  ptsTime?: number;
  score: number;
  kinds: FrameRiskKind[];
}

export interface FrameRiskAnalysis {
  detectorRevision: string;
  frameCount: number;
  exactDuplicateIntervals: ExactDuplicateInterval[];
  cadenceRisks: FrameRiskEvent[];
  nearDuplicateRisks: FrameRiskEvent[];
  hardCuts: FrameRiskEvent[];
  flashRisks: FrameRiskEvent[];
  gradualTransitionRisks: FrameRiskEvent[];
  highVariationRisks: FrameRiskEvent[];
  previewFrames: FrameRiskPreview[];
}

export interface AnalyzeFrameRisksOptions {
  thresholds?: Partial<FrameRiskThresholds>;
  maxPreviewFrames?: number;
}

type MutableFrame = { -readonly [Key in keyof FrameRiskFrame]: FrameRiskFrame[Key] };

const signalFieldMap: Readonly<Record<string, keyof FrameRiskFrame>> = Object.freeze({
  YAVG: "yAverage",
  UAVG: "uAverage",
  VAVG: "vAverage",
  SATAVG: "saturationAverage",
  TOUT: "temporalOutlier",
  VREP: "verticalRepeat",
  BRNG: "broadcastRange",
});

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function frameAt(frames: Map<number, MutableFrame>, index: number): MutableFrame {
  const existing = frames.get(index);
  if (existing) return existing;
  const created: MutableFrame = { frame: index };
  frames.set(index, created);
  return created;
}

function nearestFrameAtTime(frames: ReadonlyMap<number, MutableFrame>, time: number): number | undefined {
  let nearest: { frame: number; distance: number } | undefined;
  for (const frame of frames.values()) {
    if (frame.ptsTime === undefined) continue;
    const distance = Math.abs(frame.ptsTime - time);
    if (nearest === undefined || distance < nearest.distance) nearest = { frame: frame.frame, distance };
  }
  return nearest?.frame;
}

function parseMetadataText(text: string, frames: Map<number, MutableFrame>): void {
  let currentFrame: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const frameMatch = /(?:^|\s)frame:\s*(\d+)/.exec(line);
    if (frameMatch) {
      currentFrame = Number(frameMatch[1]);
      const target = frameAt(frames, currentFrame);
      const pts = finiteNumber(/(?:^|\s)pts:\s*(-?\d+)/.exec(line)?.[1]);
      const ptsTime = finiteNumber(/(?:^|\s)(?:pts_time|t):\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/.exec(line)?.[1]);
      const blackPercent = finiteNumber(/(?:^|\s)pblack:\s*(\d+(?:\.\d*)?)/.exec(line)?.[1]);
      if (pts !== undefined) target.pts = pts;
      if (ptsTime !== undefined) target.ptsTime = ptsTime;
      if (blackPercent !== undefined) target.blackPercent = blackPercent;
    }
    const sceneMatches = [...line.matchAll(/lavfi\.scd\.(mafd|score|time)\s*[=:]\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/gi)];
    const sceneTime = finiteNumber(sceneMatches.find((match) => (match[1] as string).toLowerCase() === "time")?.[2]);
    const targetFrame = frameMatch || sceneTime === undefined
      ? currentFrame
      : nearestFrameAtTime(frames, sceneTime);
    if (targetFrame === undefined) continue;
    const target = frameAt(frames, targetFrame);
    for (const match of line.matchAll(/lavfi\.signalstats\.([A-Z]+)\s*[=:]\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/g)) {
      const field = signalFieldMap[match[1] as string];
      const value = finiteNumber(match[2]);
      if (field !== undefined && value !== undefined) {
        (target as Record<string, unknown>)[field] = value;
      }
    }
    for (const match of sceneMatches) {
      const value = finiteNumber(match[2]);
      if (value === undefined) continue;
      const field = (match[1] as string).toLowerCase();
      if (field === "mafd") target.mafd = value;
      if (field === "score") target.sceneScore = value;
      if (field === "time") target.sceneTime = value;
    }
  }
}

function parseRatio(value: string): number | undefined {
  const match = /^\s*(-?\d+)\s*\/\s*(-?\d+)\s*$/.exec(value);
  if (!match) return undefined;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (denominator === 0) return undefined;
  return numerator / denominator;
}

function parseFrameMd5(text: string, frames: Map<number, MutableFrame>): void {
  const timeBases = new Map<number, number>();
  const streamFrames = new Map<number, number>();
  let selectedStream: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const timeBaseMatch = /^#tb\s+(\d+)\s*:\s*(\S+)/.exec(line.trim());
    if (timeBaseMatch) {
      const ratio = parseRatio(timeBaseMatch[2] as string);
      if (ratio !== undefined) timeBases.set(Number(timeBaseMatch[1]), ratio);
      continue;
    }
    const row = /^\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([A-Za-z0-9+/=]{8,})\s*$/.exec(line);
    if (!row) continue;
    const stream = Number(row[1]);
    selectedStream ??= stream;
    if (stream !== selectedStream) continue;
    const index = streamFrames.get(stream) ?? 0;
    streamFrames.set(stream, index + 1);
    const target = frameAt(frames, index);
    const pts = Number(row[3]);
    target.pts = pts;
    target.packetSize = Number(row[5]);
    target.checksum = (row[6] as string).toLowerCase();
    const timeBase = timeBases.get(stream);
    if (timeBase !== undefined) target.ptsTime = pts * timeBase;
  }
}

/** Parses and merges metadata-print, blackframe log, and framemd5 text by frame index. */
export function parseFfmpegFrameMetadata(
  sources: string | FfmpegFrameMetadataSources,
): FrameRiskFrame[] {
  const frames = new Map<number, MutableFrame>();
  const texts = typeof sources === "string"
    ? [sources]
    : [sources.signalstats, sources.scdet, sources.blackframe, sources.framemd5]
        .filter((value): value is string => typeof value === "string");
  for (const text of texts) {
    parseMetadataText(text, frames);
    parseFrameMd5(text, frames);
  }
  return [...frames.values()].sort((left, right) => left.frame - right.frame);
}

interface PairMetrics {
  index: number;
  left: FrameRiskFrame;
  right: FrameRiskFrame;
  adjacent: boolean;
  exactDuplicate: boolean;
  colorVector?: [number, number, number];
  meanColorDelta?: number;
  lumaDelta?: number;
  blackPercentDelta?: number;
  sceneScore?: number;
  mafd?: number;
}

function difference(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined || right === undefined ? undefined : right - left;
}

function pairMetrics(left: FrameRiskFrame, right: FrameRiskFrame, index: number): PairMetrics {
  const y = difference(left.yAverage, right.yAverage);
  const u = difference(left.uAverage, right.uAverage);
  const v = difference(left.vAverage, right.vAverage);
  const available = [y, u, v].filter((value): value is number => value !== undefined);
  const colorVector: [number, number, number] | undefined = available.length === 0
    ? undefined
    : [y ?? 0, u ?? 0, v ?? 0];
  const meanColorDelta = colorVector === undefined
    ? undefined
    : Math.sqrt(colorVector.reduce((sum, value) => sum + value * value, 0));
  const adjacent = right.frame === left.frame + 1;
  return {
    index,
    left,
    right,
    adjacent,
    exactDuplicate: adjacent && left.checksum !== undefined && right.checksum !== undefined &&
      left.checksum.toLowerCase() === right.checksum.toLowerCase(),
    colorVector,
    meanColorDelta,
    lumaDelta: y === undefined ? undefined : Math.abs(y),
    blackPercentDelta: left.blackPercent === undefined || right.blackPercent === undefined
      ? undefined
      : Math.abs(right.blackPercent - left.blackPercent),
    sceneScore: right.sceneScore,
    mafd: right.mafd,
  };
}

function mergedThresholds(overrides: Partial<FrameRiskThresholds> | undefined): FrameRiskThresholds {
  const result = { ...frameRiskThresholds, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be a non-negative finite number`);
  }
  if (!Number.isInteger(result.gradualMinTransitions) || result.gradualMinTransitions < 2) {
    throw new RangeError("gradualMinTransitions must be an integer of at least 2");
  }
  return result;
}

function normalizedScore(value: number): number {
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

function timeOf(frame: FrameRiskFrame): { previewTime?: number } {
  return frame.ptsTime === undefined ? {} : { previewTime: frame.ptsTime };
}

function evidenceOf(pair: PairMetrics): FrameRiskEvidence {
  return {
    ...(pair.sceneScore === undefined ? {} : { sceneScore: pair.sceneScore }),
    ...(pair.mafd === undefined ? {} : { mafd: pair.mafd }),
    ...(pair.meanColorDelta === undefined ? {} : { meanColorDelta: pair.meanColorDelta }),
    ...(pair.lumaDelta === undefined ? {} : { lumaDelta: pair.lumaDelta }),
    ...(pair.blackPercentDelta === undefined ? {} : { blackPercentDelta: pair.blackPercentDelta }),
  };
}

function exactDuplicateIntervals(pairs: readonly PairMetrics[]): ExactDuplicateInterval[] {
  const result: ExactDuplicateInterval[] = [];
  let runStart: number | undefined;
  const emit = (endPairExclusive: number): void => {
    if (runStart === undefined) return;
    const first = pairs[runStart] as PairMetrics;
    const last = pairs[endPairExclusive - 1] as PairMetrics;
    result.push({
      kind: "exact-duplicate",
      startFrame: first.left.frame,
      endFrameExclusive: last.right.frame + 1,
      checksum: (first.left.checksum as string).toLowerCase(),
      holdBoundariesAfter: pairs.slice(runStart, endPairExclusive).map((pair) => pair.left.frame),
      previewFrame: first.right.frame,
      ...timeOf(first.right),
      score: 1,
      recommendedAction: "hold",
    });
    runStart = undefined;
  };
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index] as PairMetrics;
    if (pair.exactDuplicate) {
      runStart ??= index;
    } else {
      emit(index);
    }
  }
  emit(pairs.length);
  return result;
}

function cadenceEvents(exact: readonly ExactDuplicateInterval[]): FrameRiskEvent[] {
  return exact.flatMap((interval): FrameRiskEvent[] => {
    const exposureFrames = interval.endFrameExclusive - interval.startFrame;
    if (exposureFrames !== 2 && exposureFrames !== 3) return [];
    return [{
      kind: "cadence",
      startFrame: interval.startFrame,
      endFrameExclusive: interval.endFrameExclusive,
      previewFrame: interval.previewFrame,
      ...(interval.previewTime === undefined ? {} : { previewTime: interval.previewTime }),
      score: exposureFrames === 3 ? 0.9 : 0.85,
      recommendedAction: "review",
      evidence: { exposureFrames },
    }];
  });
}

function boundaryStrongEnoughForFlash(pair: PairMetrics, thresholds: FrameRiskThresholds): boolean {
  return (pair.sceneScore ?? -Infinity) >= thresholds.flashMinBoundarySceneScore ||
    (pair.mafd ?? -Infinity) >= thresholds.flashMinBoundaryMafd;
}

function flashEvents(
  frames: readonly FrameRiskFrame[],
  pairs: readonly PairMetrics[],
  thresholds: FrameRiskThresholds,
): { risks: FrameRiskEvent[]; suppressedPairs: Set<number> } {
  const risks: FrameRiskEvent[] = [];
  const suppressedPairs = new Set<number>();
  for (let center = 1; center < frames.length - 1; center += 1) {
    const before = pairs[center - 1] as PairMetrics;
    const after = pairs[center] as PairMetrics;
    if (!before.adjacent || !after.adjacent || before.exactDuplicate || after.exactDuplicate ||
        !boundaryStrongEnoughForFlash(before, thresholds) || !boundaryStrongEnoughForFlash(after, thresholds)) continue;
    const previous = frames[center - 1] as FrameRiskFrame;
    const current = frames[center] as FrameRiskFrame;
    const next = frames[center + 1] as FrameRiskFrame;
    const returnPair = pairMetrics(previous, next, -1);
    const returnedToBaseline = returnPair.meanColorDelta !== undefined &&
      returnPair.meanColorDelta <= thresholds.flashMaxReturnMeanColorDelta;
    const lumaExcursion = before.lumaDelta !== undefined && after.lumaDelta !== undefined &&
      Math.min(before.lumaDelta, after.lumaDelta) >= thresholds.flashMinLumaDelta;
    const blackExcursion = before.blackPercentDelta !== undefined && after.blackPercentDelta !== undefined &&
      Math.min(before.blackPercentDelta, after.blackPercentDelta) >= thresholds.flashMinBlackPercentDelta;
    if (!returnedToBaseline || (!lumaExcursion && !blackExcursion)) continue;
    const boundaryStrength = Math.min(
      Math.max(before.sceneScore ?? 0, before.mafd ?? 0),
      Math.max(after.sceneScore ?? 0, after.mafd ?? 0),
    );
    const excursion = lumaExcursion
      ? Math.min(before.lumaDelta as number, after.lumaDelta as number) / thresholds.flashMinLumaDelta
      : Math.min(before.blackPercentDelta as number, after.blackPercentDelta as number) /
        thresholds.flashMinBlackPercentDelta;
    risks.push({
      kind: "flash",
      startFrame: previous.frame,
      endFrameExclusive: next.frame + 1,
      previewFrame: current.frame,
      ...timeOf(current),
      score: normalizedScore(0.5 * Math.min(1, excursion) + 0.5 * Math.min(1, boundaryStrength / 20)),
      recommendedAction: "review",
      evidence: {
        sceneScore: Math.max(before.sceneScore ?? 0, after.sceneScore ?? 0),
        mafd: Math.max(before.mafd ?? 0, after.mafd ?? 0),
        meanColorDelta: returnPair.meanColorDelta,
        lumaDelta: Math.max(before.lumaDelta ?? 0, after.lumaDelta ?? 0),
        blackPercentDelta: Math.max(before.blackPercentDelta ?? 0, after.blackPercentDelta ?? 0),
      },
    });
    suppressedPairs.add(center - 1);
    suppressedPairs.add(center);
  }
  return { risks, suppressedPairs };
}

function hardCutEvents(
  pairs: readonly PairMetrics[],
  thresholds: FrameRiskThresholds,
  suppressedPairs: ReadonlySet<number>,
): { risks: FrameRiskEvent[]; pairIndices: Set<number> } {
  const risks: FrameRiskEvent[] = [];
  const pairIndices = new Set<number>();
  for (const pair of pairs) {
    if (!pair.adjacent || pair.exactDuplicate || suppressedPairs.has(pair.index)) continue;
    const explicitCut = (pair.sceneScore ?? -Infinity) >= thresholds.hardCutMinSceneScore;
    const fallbackCut = (pair.mafd ?? -Infinity) >= thresholds.hardCutFallbackMinMafd &&
      (pair.meanColorDelta ?? -Infinity) >= thresholds.hardCutFallbackMinMeanColorDelta;
    if (!explicitCut && !fallbackCut) continue;
    const strength = Math.max(
      (pair.sceneScore ?? 0) / thresholds.hardCutMinSceneScore,
      Math.min(
        (pair.mafd ?? 0) / thresholds.hardCutFallbackMinMafd,
        (pair.meanColorDelta ?? 0) / thresholds.hardCutFallbackMinMeanColorDelta,
      ),
    );
    risks.push({
      kind: "hard-cut",
      startFrame: pair.left.frame,
      endFrameExclusive: pair.right.frame + 1,
      previewFrame: pair.right.frame,
      ...timeOf(pair.right),
      score: normalizedScore(strength),
      recommendedAction: "review",
      evidence: evidenceOf(pair),
    });
    pairIndices.add(pair.index);
  }
  return { risks, pairIndices };
}

function contiguousRuns(indices: readonly number[]): number[][] {
  const result: number[][] = [];
  let current: number[] = [];
  for (const index of indices) {
    if (current.length === 0 || index === (current.at(-1) as number) + 1) {
      current.push(index);
    } else {
      result.push(current);
      current = [index];
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

function nearDuplicateEvents(
  pairs: readonly PairMetrics[],
  thresholds: FrameRiskThresholds,
  excludedPairs: ReadonlySet<number>,
): { risks: FrameRiskEvent[]; pairIndices: Set<number> } {
  const candidates = pairs.filter((pair) => pair.adjacent && !pair.exactDuplicate && !excludedPairs.has(pair.index) &&
    pair.mafd !== undefined && pair.mafd <= thresholds.nearDuplicateMaxMafd &&
    (pair.meanColorDelta === undefined || pair.meanColorDelta <= thresholds.nearDuplicateMaxMeanColorDelta) &&
    (pair.sceneScore === undefined || pair.sceneScore <= thresholds.nearDuplicateMaxSceneScore));
  const pairIndices = new Set(candidates.map((pair) => pair.index));
  const risks = contiguousRuns([...pairIndices]).map((run): FrameRiskEvent => {
    const runPairs = run.map((index) => pairs[index] as PairMetrics);
    const preview = runPairs.reduce((best, pair) => (pair.mafd ?? Infinity) < (best.mafd ?? Infinity) ? pair : best);
    const mafdScore = 1 - (preview.mafd as number) / Math.max(Number.EPSILON, thresholds.nearDuplicateMaxMafd);
    const colorScore = preview.meanColorDelta === undefined
      ? mafdScore
      : 1 - preview.meanColorDelta / Math.max(Number.EPSILON, thresholds.nearDuplicateMaxMeanColorDelta);
    return {
      kind: "near-duplicate",
      startFrame: runPairs[0]?.left.frame as number,
      endFrameExclusive: (runPairs.at(-1)?.right.frame as number) + 1,
      previewFrame: preview.right.frame,
      ...timeOf(preview.right),
      score: normalizedScore(0.55 + 0.45 * Math.max(0, Math.min(mafdScore, colorScore))),
      recommendedAction: "review",
      evidence: evidenceOf(preview),
    };
  });
  return { risks, pairIndices };
}

function vectorLength(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function directionCoherence(runPairs: readonly PairMetrics[]): number {
  const vectors = runPairs.map((pair) => pair.colorVector).filter((value): value is [number, number, number] => value !== undefined);
  const pathLength = vectors.reduce((sum, vector) => sum + vectorLength(vector), 0);
  if (pathLength <= Number.EPSILON) return 0;
  const net = vectors.reduce<[number, number, number]>(
    (sum, vector) => [sum[0] + vector[0], sum[1] + vector[1], sum[2] + vector[2]],
    [0, 0, 0],
  );
  return Math.min(1, vectorLength(net) / pathLength);
}

function gradualTransitionEvents(
  pairs: readonly PairMetrics[],
  thresholds: FrameRiskThresholds,
  excludedPairs: ReadonlySet<number>,
): { risks: FrameRiskEvent[]; pairIndices: Set<number> } {
  const candidateIndices = pairs.filter((pair) => {
    if (!pair.adjacent || pair.exactDuplicate || excludedPairs.has(pair.index) || pair.meanColorDelta === undefined) return false;
    const score = pair.sceneScore ?? pair.mafd;
    return score !== undefined && score >= thresholds.gradualMinSceneScore && score <= thresholds.gradualMaxSceneScore &&
      (pair.meanColorDelta as number) >= thresholds.gradualMinMeanColorStep &&
      (pair.meanColorDelta as number) <= thresholds.gradualMaxMeanColorStep;
  }).map((pair) => pair.index);
  const risks: FrameRiskEvent[] = [];
  const pairIndices = new Set<number>();
  for (const run of contiguousRuns(candidateIndices)) {
    if (run.length < thresholds.gradualMinTransitions) continue;
    const runPairs = run.map((index) => pairs[index] as PairMetrics);
    const coherence = directionCoherence(runPairs);
    const first = runPairs[0] as PairMetrics;
    const last = runPairs.at(-1) as PairMetrics;
    const totalDelta = pairMetrics(first.left, last.right, -1).meanColorDelta ?? 0;
    if (coherence < thresholds.gradualMinDirectionCoherence ||
        totalDelta < thresholds.gradualMinTotalMeanColorDelta) continue;
    const middle = runPairs[Math.floor(runPairs.length / 2)] as PairMetrics;
    const score = 0.35 * Math.min(1, run.length / (thresholds.gradualMinTransitions * 2)) +
      0.35 * coherence +
      0.3 * Math.min(1, totalDelta / (thresholds.gradualMinTotalMeanColorDelta * 2));
    risks.push({
      kind: "gradual-transition",
      startFrame: first.left.frame,
      endFrameExclusive: last.right.frame + 1,
      previewFrame: middle.right.frame,
      ...timeOf(middle.right),
      score: normalizedScore(score),
      recommendedAction: "review",
      evidence: {
        ...evidenceOf(middle),
        meanColorDelta: totalDelta,
        directionCoherence: Number(coherence.toFixed(4)),
      },
    });
    for (const index of run) pairIndices.add(index);
  }
  return { risks, pairIndices };
}

function highVariationEvents(
  pairs: readonly PairMetrics[],
  thresholds: FrameRiskThresholds,
  excludedPairs: ReadonlySet<number>,
): FrameRiskEvent[] {
  const candidateIndices = pairs.filter((pair) => pair.adjacent && !pair.exactDuplicate && !excludedPairs.has(pair.index) &&
    (pair.mafd ?? -Infinity) >= thresholds.highVariationMinMafd &&
    (pair.sceneScore === undefined || pair.sceneScore <= thresholds.highVariationMaxSceneScore) &&
    (pair.meanColorDelta === undefined || pair.meanColorDelta <= thresholds.highVariationMaxMeanColorDelta))
    .map((pair) => pair.index);
  return contiguousRuns(candidateIndices).map((run): FrameRiskEvent => {
    const runPairs = run.map((index) => pairs[index] as PairMetrics);
    const preview = runPairs.reduce((best, pair) => (pair.mafd ?? 0) > (best.mafd ?? 0) ? pair : best);
    return {
      kind: "high-variation",
      startFrame: runPairs[0]?.left.frame as number,
      endFrameExclusive: (runPairs.at(-1)?.right.frame as number) + 1,
      previewFrame: preview.right.frame,
      ...timeOf(preview.right),
      score: normalizedScore(0.5 + 0.5 * Math.min(1, (preview.mafd as number) / 20)),
      recommendedAction: "review",
      evidence: evidenceOf(preview),
    };
  });
}

function previewFrames(
  exact: readonly ExactDuplicateInterval[],
  risks: readonly FrameRiskEvent[],
  maximum: number,
): FrameRiskPreview[] {
  const candidates = [
    ...exact.map((risk) => ({ frame: risk.previewFrame, ptsTime: risk.previewTime, score: risk.score, kind: risk.kind })),
    ...risks.map((risk) => ({ frame: risk.previewFrame, ptsTime: risk.previewTime, score: risk.score, kind: risk.kind })),
  ].sort((left, right) => right.score - left.score || left.frame - right.frame || left.kind.localeCompare(right.kind));
  const selected: typeof candidates = [];
  const kinds: FrameRiskKind[] = [
    "flash",
    "hard-cut",
    "gradual-transition",
    "high-variation",
    "near-duplicate",
    "cadence",
    "exact-duplicate",
  ];
  for (const kind of kinds) {
    const candidate = candidates.find((item) => item.kind === kind);
    if (candidate) selected.push(candidate);
  }
  for (const candidate of candidates) {
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  const merged = new Map<number, FrameRiskPreview>();
  for (const candidate of selected) {
    const existing = merged.get(candidate.frame);
    if (existing) {
      if (!existing.kinds.includes(candidate.kind)) existing.kinds.push(candidate.kind);
      existing.score = Math.max(existing.score, candidate.score);
      continue;
    }
    if (merged.size >= maximum) continue;
    merged.set(candidate.frame, {
      frame: candidate.frame,
      ...(candidate.ptsTime === undefined ? {} : { ptsTime: candidate.ptsTime }),
      score: candidate.score,
      kinds: [candidate.kind],
    });
  }
  return [...merged.values()];
}

const diagnosticRiskPriority: readonly FrameRiskKind[] = [
  "flash",
  "gradual-transition",
  "high-variation",
  "near-duplicate",
  "cadence",
  "hard-cut",
  "exact-duplicate",
];

/** Selects the most useful review location without changing source cadence. */
export function selectDiagnosticRiskPreview(
  analysis: FrameRiskAnalysis | undefined,
): FrameRiskPreview | undefined {
  if (!analysis || analysis.previewFrames.length === 0) return undefined;
  const priority = (preview: FrameRiskPreview): number => Math.min(
    ...preview.kinds.map((kind) => diagnosticRiskPriority.indexOf(kind))
      .filter((index) => index >= 0),
  );
  const reviewOnly = analysis.previewFrames.filter((preview) =>
    preview.kinds.some((kind) => kind !== "exact-duplicate"));
  return [...(reviewOnly.length > 0 ? reviewOnly : analysis.previewFrames)].sort((left, right) =>
    priority(left) - priority(right) || right.score - left.score || left.frame - right.frame)[0];
}

/** Analyzes already-extracted frame metadata without changing interpolation cadence. */
export function analyzeFrameRisks(
  inputFrames: readonly FrameRiskFrame[],
  options: AnalyzeFrameRisksOptions = {},
): FrameRiskAnalysis {
  const thresholds = mergedThresholds(options.thresholds);
  const maximum = options.maxPreviewFrames ?? 12;
  if (!Number.isInteger(maximum) || maximum < 0) throw new RangeError("maxPreviewFrames must be a non-negative integer");
  const frames = [...inputFrames].sort((left, right) => left.frame - right.frame);
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index] as FrameRiskFrame;
    if (!Number.isInteger(frame.frame) || frame.frame < 0) throw new RangeError("frame indices must be non-negative integers");
    if (index > 0 && frame.frame === frames[index - 1]?.frame) throw new RangeError(`duplicate frame metadata for frame ${frame.frame}`);
  }
  const pairs = frames.slice(1).map((frame, index) => pairMetrics(frames[index] as FrameRiskFrame, frame, index));
  const exact = exactDuplicateIntervals(pairs);
  const cadence = cadenceEvents(exact);
  const flashes = flashEvents(frames, pairs, thresholds);
  const cuts = hardCutEvents(pairs, thresholds, flashes.suppressedPairs);
  const firstExcluded = new Set([...flashes.suppressedPairs, ...cuts.pairIndices]);
  const near = nearDuplicateEvents(pairs, thresholds, firstExcluded);
  const gradual = gradualTransitionEvents(pairs, thresholds, new Set([...firstExcluded, ...near.pairIndices]));
  const highVariation = highVariationEvents(
    pairs,
    thresholds,
    new Set([...firstExcluded, ...near.pairIndices, ...gradual.pairIndices]),
  );
  const allRisks = [
    ...cadence,
    ...near.risks,
    ...cuts.risks,
    ...flashes.risks,
    ...gradual.risks,
    ...highVariation,
  ];
  return {
    detectorRevision,
    frameCount: frames.length,
    exactDuplicateIntervals: exact,
    cadenceRisks: cadence,
    nearDuplicateRisks: near.risks,
    hardCuts: cuts.risks,
    flashRisks: flashes.risks,
    gradualTransitionRisks: gradual.risks,
    highVariationRisks: highVariation,
    previewFrames: previewFrames(exact, allRisks, maximum),
  };
}
