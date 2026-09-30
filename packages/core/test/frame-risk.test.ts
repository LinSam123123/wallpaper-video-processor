import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeFrameRisks,
  detectorRevision,
  FRAME_RISK_MAX_CAPTURE_BYTES,
  FRAME_RISK_MIN_CAPTURE_BYTES,
  frameRiskCaptureBytes,
  parseFfmpegFrameMetadata,
  selectDiagnosticRiskPreview,
  type FrameRiskFrame,
} from "../src/index.js";

function metadata(frames: Array<Partial<FrameRiskFrame> & { frame: number }>): FrameRiskFrame[] {
  return frames.map((frame) => ({ ...frame }));
}

test("FFmpeg signalstats, scdet, blackframe, and framemd5 text merge by frame", () => {
  const parsed = parseFfmpegFrameMetadata({
    signalstats: [
      "frame:0 pts:0 pts_time:0",
      "lavfi.signalstats.YAVG=100.5",
      "lavfi.signalstats.UAVG=127",
      "lavfi.signalstats.VAVG=129",
      "lavfi.signalstats.SATAVG=12.25",
      "frame:1 pts:1 pts_time:0.041667",
      "lavfi.signalstats.YAVG=101",
    ].join("\n"),
    scdet: [
      "frame:0 pts:0 pts_time:0",
      "lavfi.scd.mafd=0.000",
      "lavfi.scd.score=0.000",
      "frame:1 pts:1 pts_time:0.041667",
      "lavfi.scd.mafd=1.250 lavfi.scd.score=2.500 lavfi.scd.time=0.041667",
    ].join("\n"),
    blackframe: "[Parsed_blackframe_0 @ 0000] frame:1 pblack:98 pts:1 t:0.041667 type:P",
    framemd5: [
      "#format: frame checksums",
      "#hash: MD5",
      "#tb 0: 1/24",
      "0,          0,          0,        1,     1234, aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0,          1,          1,        1,     1235, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ].join("\n"),
  });

  assert.deepEqual(parsed, [
    {
      frame: 0,
      pts: 0,
      ptsTime: 0,
      checksum: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      packetSize: 1234,
      yAverage: 100.5,
      uAverage: 127,
      vAverage: 129,
      saturationAverage: 12.25,
      mafd: 0,
      sceneScore: 0,
    },
    {
      frame: 1,
      pts: 1,
      ptsTime: 1 / 24,
      checksum: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      packetSize: 1235,
      yAverage: 101,
      mafd: 1.25,
      sceneScore: 2.5,
      sceneTime: 0.041667,
      blackPercent: 98,
    },
  ]);
});

test("frame-risk capture grows past the legacy limit and remains bounded", () => {
  assert.equal(frameRiskCaptureBytes(1), FRAME_RISK_MIN_CAPTURE_BYTES);
  assert.equal(frameRiskCaptureBytes(3_000) > FRAME_RISK_MIN_CAPTURE_BYTES, true);
  assert.equal(frameRiskCaptureBytes(Number.MAX_SAFE_INTEGER), FRAME_RISK_MAX_CAPTURE_BYTES);
});

test("plain scdet stderr without frame headers joins the nearest signalstats timestamp", () => {
  const parsed = parseFfmpegFrameMetadata({
    signalstats: [
      "frame:0 pts:0 pts_time:0",
      "lavfi.signalstats.YAVG=100",
      "frame:1 pts:1 pts_time:0.041667",
      "lavfi.signalstats.YAVG=140",
    ].join("\n"),
    scdet: "[scdet @ 0000] lavfi.scd.score: 12.5, lavfi.scd.time: 0.041667",
  });

  assert.equal(parsed[0]?.sceneScore, undefined);
  assert.equal(parsed[1]?.sceneScore, 12.5);
  assert.equal(parsed[1]?.sceneTime, 0.041667);
});

test("anime two-frame and three-frame exposure runs become exact hold intervals", () => {
  const hashes = ["a", "a", "b", "b", "b", "c"];
  const result = analyzeFrameRisks(metadata(hashes.map((checksum, frame) => ({
    frame,
    checksum,
    yAverage: 100 + frame,
    mafd: frame === 2 || frame === 5 ? 4 : 0.1,
    sceneScore: frame === 2 || frame === 5 ? 2 : 0.1,
  }))));

  assert.equal(result.detectorRevision, detectorRevision);
  assert.deepEqual(result.exactDuplicateIntervals.map((interval) => ({
    range: [interval.startFrame, interval.endFrameExclusive],
    holds: interval.holdBoundariesAfter,
    action: interval.recommendedAction,
  })), [
    { range: [0, 2], holds: [0], action: "hold" },
    { range: [2, 5], holds: [2, 3], action: "hold" },
  ]);
  assert.equal(result.nearDuplicateRisks.length, 0);
  assert.deepEqual(result.cadenceRisks.map((risk) => ({
    range: [risk.startFrame, risk.endFrameExclusive],
    exposureFrames: risk.evidence.exposureFrames,
    action: risk.recommendedAction,
  })), [
    { range: [0, 2], exposureFrames: 2, action: "review" },
    { range: [2, 5], exposureFrames: 3, action: "review" },
  ]);
});

test("near duplicates remain review-only and never become automatic holds", () => {
  const result = analyzeFrameRisks(metadata([
    { frame: 0, checksum: "a", yAverage: 100, uAverage: 128, vAverage: 128 },
    { frame: 1, checksum: "b", yAverage: 100.4, uAverage: 128.1, vAverage: 128, mafd: 0.2, sceneScore: 0.1 },
    { frame: 2, checksum: "c", yAverage: 100.8, uAverage: 128.1, vAverage: 128.1, mafd: 0.3, sceneScore: 0.2 },
  ]));

  assert.equal(result.exactDuplicateIntervals.length, 0);
  assert.equal(result.nearDuplicateRisks.length, 1);
  assert.equal(result.nearDuplicateRisks[0]?.recommendedAction, "review");
  assert.deepEqual(
    [result.nearDuplicateRisks[0]?.startFrame, result.nearDuplicateRisks[0]?.endFrameExclusive],
    [0, 3],
  );
});

test("a one-frame flash suppresses both false hard-cut boundaries", () => {
  const result = analyzeFrameRisks(metadata([
    { frame: 0, yAverage: 100, uAverage: 128, vAverage: 128 },
    { frame: 1, yAverage: 242, uAverage: 128, vAverage: 128, mafd: 25, sceneScore: 18 },
    { frame: 2, yAverage: 101, uAverage: 128, vAverage: 128, mafd: 24, sceneScore: 17 },
    { frame: 3, yAverage: 102, uAverage: 128, vAverage: 128, mafd: 1, sceneScore: 0.5 },
  ]));

  assert.equal(result.flashRisks.length, 1);
  assert.equal(result.flashRisks[0]?.previewFrame, 1);
  assert.equal(result.hardCuts.length, 0);
  assert.deepEqual(result.previewFrames[0]?.kinds, ["flash"]);
});

test("a one-frame black flash can be identified from blackframe percentages", () => {
  const result = analyzeFrameRisks(metadata([
    { frame: 0, yAverage: 100, blackPercent: 0 },
    { frame: 1, yAverage: 5, blackPercent: 99, mafd: 22, sceneScore: 15 },
    { frame: 2, yAverage: 101, blackPercent: 0, mafd: 21, sceneScore: 14 },
  ]));

  assert.equal(result.flashRisks.length, 1);
  assert.equal(result.flashRisks[0]?.evidence.blackPercentDelta, 99);
  assert.equal(result.hardCuts.length, 0);
});

test("a sustained coherent fade is reported as one gradual-transition preview", () => {
  const result = analyzeFrameRisks(metadata([80, 86, 92, 98, 104].map((yAverage, frame) => ({
    frame,
    yAverage,
    uAverage: 128,
    vAverage: 128,
    ...(frame === 0 ? {} : { mafd: 3, sceneScore: 2 }),
  }))));

  assert.equal(result.gradualTransitionRisks.length, 1);
  assert.deepEqual(
    [result.gradualTransitionRisks[0]?.startFrame, result.gradualTransitionRisks[0]?.endFrameExclusive],
    [0, 5],
  );
  assert.equal(result.gradualTransitionRisks[0]?.previewFrame, 3);
  assert.equal(result.hardCuts.length, 0);
});

test("text or particle-like local variation is warned without becoming a cut or dissolve", () => {
  const result = analyzeFrameRisks(metadata([100, 100.2, 99.9, 100.1, 100].map((yAverage, frame) => ({
    frame,
    yAverage,
    uAverage: 128,
    vAverage: 128,
    ...(frame === 0 ? {} : { mafd: 9, sceneScore: 3 }),
  }))));

  assert.equal(result.highVariationRisks.length, 1);
  assert.equal(result.highVariationRisks[0]?.recommendedAction, "review");
  assert.equal(result.gradualTransitionRisks.length, 0);
  assert.equal(result.hardCuts.length, 0);
  assert.equal(result.nearDuplicateRisks.length, 0);
});

test("a real scdet boundary remains a hard cut and gets a scored preview", () => {
  const result = analyzeFrameRisks(metadata([
    { frame: 10, ptsTime: 10 / 24, yAverage: 40, uAverage: 120, vAverage: 130 },
    { frame: 11, ptsTime: 11 / 24, yAverage: 180, uAverage: 145, vAverage: 100, mafd: 30, sceneScore: 16 },
    { frame: 12, ptsTime: 12 / 24, yAverage: 181, uAverage: 145, vAverage: 100, mafd: 1, sceneScore: 0.2 },
  ]));

  assert.equal(result.hardCuts.length, 1);
  assert.equal(result.hardCuts[0]?.previewFrame, 11);
  assert.equal(result.hardCuts[0]?.previewTime, 11 / 24);
  assert.equal((result.hardCuts[0]?.score ?? 0) > 0.9, true);
  assert.equal(result.flashRisks.length, 0);
});

test("preview selection is bounded while retaining risk-type representatives", () => {
  const result = analyzeFrameRisks(metadata([
    { frame: 0, checksum: "same", yAverage: 100 },
    { frame: 1, checksum: "same", yAverage: 100, mafd: 0, sceneScore: 0 },
    { frame: 2, checksum: "next", yAverage: 160, mafd: 20, sceneScore: 15 },
  ]), { maxPreviewFrames: 2 });

  assert.equal(result.previewFrames.length, 2);
  assert.deepEqual(
    new Set(result.previewFrames.flatMap((preview) => preview.kinds)),
    new Set(["hard-cut", "cadence", "exact-duplicate"]),
  );
});

test("diagnostic selection prefers a review risk over an automatic duplicate hold", () => {
  const selected = selectDiagnosticRiskPreview({
    detectorRevision,
    frameCount: 4,
    exactDuplicateIntervals: [],
    cadenceRisks: [],
    nearDuplicateRisks: [],
    hardCuts: [],
    flashRisks: [],
    gradualTransitionRisks: [],
    highVariationRisks: [],
    previewFrames: [
      { frame: 1, score: 1, kinds: ["exact-duplicate"] },
      { frame: 3, score: 0.6, kinds: ["flash"] },
    ],
  });
  assert.equal(selected?.frame, 3);
});
