import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError, inspectMedia, verifyMedia, type CommandRunner } from "../src/index.js";

const ffprobeJson = JSON.stringify({
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      width: 1136,
      height: 800,
      sample_aspect_ratio: "64:45",
      display_aspect_ratio: "16:9",
      pix_fmt: "yuv420p",
      color_space: "bt709",
      color_primaries: "bt709",
      color_transfer: "bt709",
      color_range: "tv",
      avg_frame_rate: "24/1",
      r_frame_rate: "24/1",
      nb_read_frames: "720",
      duration: "30.0",
    },
    { index: 1, codec_type: "audio", codec_name: "aac" },
  ],
  frames: [
    { best_effort_timestamp_time: "0.000000" },
    { best_effort_timestamp_time: "0.041667" },
    { best_effort_timestamp_time: "0.083333" },
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "30.0", size: "12345" },
});

test("ffprobe JSON is normalized and verification reports every mismatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallpaper-media-"));
  const input = join(directory, "source.mp4");
  await writeFile(input, "stub");
  let requestedEntries = "";
  const runner: CommandRunner = async (command) => {
    requestedEntries = command.args[command.args.indexOf("-show_entries") + 1] ?? "";
    return { exitCode: 0, stdout: ffprobeJson, stderr: "" };
  };
  try {
    const media = await inspectMedia(input, { runner, ffprobePath: "ffprobe-stub" });
    assert.match(requestedEntries, /sample_aspect_ratio/);
    assert.match(requestedEntries, /display_aspect_ratio/);
    assert.equal(media.video.frameCount, 720);
    assert.equal(media.video.frameRate, 24);
    assert.equal(media.video.frameRateMode, "constant");
    assert.equal(media.video.sampleAspectRatio, "64:45");
    assert.equal(media.video.displayAspectRatio, "16:9");
    assert.equal(media.audio[0]?.codec, "aac");
    const verification = await verifyMedia(input, {
      width: 2560,
      sampleAspectRatio: "1:1",
      frameCount: 720,
      colorPrimaries: "bt709",
      colorTransfer: "bt709",
      colorRange: "tv",
      audio: "none",
    }, { runner, ffprobePath: "ffprobe-stub" });
    assert.equal(verification.passed, false);
    assert.deepEqual(verification.checks.map((check) => [check.name, check.passed]), [
      ["width", false],
      ["sampleAspectRatio", false],
      ["frameCount", true],
      ["colorPrimaries", true],
      ["colorTransfer", true],
      ["colorRange", true],
      ["audioStreams", false],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspection marks varying frame timestamps as variable frame rate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallpaper-vfr-"));
  const input = join(directory, "source.mp4");
  await writeFile(input, "stub");
  const parsed = JSON.parse(ffprobeJson) as { frames: Array<{ best_effort_timestamp_time: string }> };
  parsed.frames = [
    { best_effort_timestamp_time: "0.000000" },
    { best_effort_timestamp_time: "0.041667" },
    { best_effort_timestamp_time: "0.125000" },
  ];
  const runner: CommandRunner = async () => ({
    exitCode: 0,
    stdout: JSON.stringify(parsed),
    stderr: "",
  });
  try {
    const media = await inspectMedia(input, { runner, ffprobePath: "ffprobe-stub" });
    assert.equal(media.video.frameRateMode, "variable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("square-pixel verification rejects anamorphic output metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallpaper-anamorphic-"));
  const output = join(directory, "output.mp4");
  await writeFile(output, "stub");
  const runner: CommandRunner = async () => ({ exitCode: 0, stdout: ffprobeJson, stderr: "" });
  try {
    const verification = await verifyMedia(output, {
      sampleAspectRatio: "1:1",
    }, { runner, ffprobePath: "ffprobe-stub" });
    assert.equal(verification.passed, false);
    assert.deepEqual(verification.checks, [{
      name: "sampleAspectRatio",
      expected: "1:1",
      actual: "64:45",
      passed: false,
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("full verification decodes every frame and rejects catastrophic black or frozen output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallpaper-health-"));
  const output = join(directory, "output.mp4");
  await writeFile(output, "stub");
  let healthArguments: string[] = [];
  const verifyWithLog = async (stderr: string) => await verifyMedia(output, { frameCount: 720 }, {
    ffprobePath: "ffprobe-stub",
    ffmpegPath: "ffmpeg-stub",
    fullDecode: true,
    runner: async (command) => {
      if (command.executable === "ffprobe-stub") {
        return { exitCode: 0, stdout: ffprobeJson, stderr: "" };
      }
      healthArguments = command.args;
      return { exitCode: 0, stdout: "", stderr };
    },
  });
  try {
    const healthy = await verifyWithLog("");
    assert.equal(healthy.passed, true);
    assert.equal(healthy.health?.fullDecodeCompleted, true);
    assert.equal(healthArguments.includes("-xerror"), true);
    assert.match(healthArguments[healthArguments.indexOf("-vf") + 1] ?? "", /blackdetect=.*freezedetect=/);
    assert.deepEqual(healthArguments.slice(-3), ["-f", "null", "-"]);
    assert.deepEqual(healthy.checks.slice(-3).map((check) => [check.name, check.passed]), [
      ["fullDecode", true],
      ["catastrophicBlack", true],
      ["catastrophicFreeze", true],
    ]);

    const black = await verifyWithLog("[blackdetect] black_start:0 black_end:30 black_duration:30\n");
    assert.equal(black.passed, false);
    assert.equal(black.health?.catastrophicBlack, true);

    const frozen = await verifyWithLog([
      "[freezedetect] lavfi.freezedetect.freeze_start: 0",
      "[freezedetect] lavfi.freezedetect.freeze_duration: 30",
      "[freezedetect] lavfi.freezedetect.freeze_end: 30",
    ].join("\n"));
    assert.equal(frozen.passed, false);
    assert.equal(frozen.health?.catastrophicFreeze, true);

    const briefTransition = await verifyWithLog("[blackdetect] black_start:4 black_end:4.5 black_duration:0.5\n");
    assert.equal(briefTransition.passed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reference-aware full verification only rejects newly catastrophic output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallpaper-reference-health-"));
  const source = join(directory, "source.mp4");
  const output = join(directory, "output.mp4");
  await writeFile(source, "source");
  await writeFile(output, "output");
  const referenceMedia = await inspectMedia(source, {
    ffprobePath: "ffprobe-stub",
    runner: async () => ({ exitCode: 0, stdout: ffprobeJson, stderr: "" }),
  });
  const black = (duration: number): string =>
    `[blackdetect] black_start:0 black_end:${duration} black_duration:${duration}\n`;
  const frozen = (duration: number): string => [
    "[freezedetect] lavfi.freezedetect.freeze_start: 0",
    `[freezedetect] lavfi.freezedetect.freeze_duration: ${duration}`,
    `[freezedetect] lavfi.freezedetect.freeze_end: ${duration}`,
  ].join("\n");
  type DecodeOutcome = string | Error;
  let outputHealthArguments: string[] = [];
  let referenceHealthArguments: string[] = [];
  const verifyWithHealth = async (
    outputOutcome: DecodeOutcome,
    referenceOutcome: DecodeOutcome,
    sourceRanges?: Array<{ startFrame: number; endFrameExclusive: number }>,
  ) =>
    await verifyMedia(output, { frameCount: 720 }, {
      ffprobePath: "ffprobe-stub",
      ffmpegPath: "ffmpeg-stub",
      fullDecode: {
        reference: {
          inputPath: source,
          media: referenceMedia,
          ...(sourceRanges
            ? { sourceRanges }
            : { sourceRange: { startFrame: 240, endFrameExclusive: 480 } }),
        },
      },
      runner: async (command) => {
        if (command.executable === "ffprobe-stub") {
          return { exitCode: 0, stdout: ffprobeJson, stderr: "" };
        }
        const decodedPath = command.args[command.args.indexOf("-i") + 1];
        const isOutput = decodedPath === output;
        if (isOutput) outputHealthArguments = command.args;
        else referenceHealthArguments = command.args;
        const outcome = isOutput ? outputOutcome : referenceOutcome;
        if (outcome instanceof Error) throw outcome;
        return { exitCode: 0, stdout: "", stderr: outcome };
      },
    });

  try {
    const blackPreserved = await verifyWithHealth(black(30), black(10));
    assert.equal(blackPreserved.passed, true);
    assert.equal(blackPreserved.health?.catastrophicBlack, true);
    assert.equal(blackPreserved.referenceHealth?.catastrophicBlack, true);
    assert.deepEqual(blackPreserved.checks.slice(-4).map((check) => [check.name, check.passed]), [
      ["fullDecode", true],
      ["referenceFullDecode", true],
      ["catastrophicBlack", true],
      ["catastrophicFreeze", true],
    ]);

    const discontinuousBlack = await verifyWithHealth(black(30), black(10), [
      { startFrame: 0, endFrameExclusive: 120 },
      { startFrame: 600, endFrameExclusive: 720 },
    ]);
    assert.equal(discontinuousBlack.passed, true);
    assert.equal(
      referenceHealthArguments[referenceHealthArguments.indexOf("-vf") + 1],
      "select=between(n\\,0\\,119)+between(n\\,600\\,719),setpts=N/(24*TB),blackdetect=d=0.04:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=2",
    );

    const freezePreserved = await verifyWithHealth(frozen(30), frozen(10));
    assert.equal(freezePreserved.passed, true);
    assert.equal(freezePreserved.health?.catastrophicFreeze, true);
    assert.equal(freezePreserved.referenceHealth?.catastrophicFreeze, true);

    for (const outputLog of [black(30), frozen(30)]) {
      const regression = await verifyWithHealth(outputLog, "");
      assert.equal(regression.passed, false);
    }

    const newlyFrozen = await verifyWithHealth(frozen(30), black(10));
    assert.equal(newlyFrozen.passed, false);
    assert.equal(newlyFrozen.checks.find((check) => check.name === "catastrophicFreeze")?.passed, false);
    const newlyBlack = await verifyWithHealth(black(30), frozen(10));
    assert.equal(newlyBlack.passed, false);
    assert.equal(newlyBlack.checks.find((check) => check.name === "catastrophicBlack")?.passed, false);

    const outputDecodeFailure = await verifyWithHealth(
      new AppError("E_PROCESS_FAILED", "output decode failed"),
      black(10),
    );
    assert.equal(outputDecodeFailure.passed, false);
    assert.equal(outputDecodeFailure.health?.fullDecodeCompleted, false);
    assert.equal(outputDecodeFailure.referenceHealth?.catastrophicBlack, true);

    const referenceDecodeFailure = await verifyWithHealth(
      "",
      new AppError("E_PROCESS_FAILED", "reference decode failed"),
    );
    assert.equal(referenceDecodeFailure.passed, false);
    assert.equal(referenceDecodeFailure.health?.fullDecodeCompleted, true);
    assert.equal(referenceDecodeFailure.referenceHealth?.fullDecodeCompleted, false);
    assert.equal(
      referenceDecodeFailure.checks.find((check) => check.name === "referenceFullDecode")?.passed,
      false,
    );

    assert.equal(
      outputHealthArguments[outputHealthArguments.indexOf("-vf") + 1],
      "blackdetect=d=0.04:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=2",
    );
    assert.equal(
      referenceHealthArguments[referenceHealthArguments.indexOf("-vf") + 1],
      "trim=start_frame=240:end_frame=480,setpts=PTS-STARTPTS,blackdetect=d=0.04:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=2",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("full verification reports a truncated or otherwise undecodable output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallpaper-decode-failure-"));
  const output = join(directory, "output.mp4");
  await writeFile(output, "stub");
  const runner: CommandRunner = async (command) => {
    if (command.executable === "ffprobe-stub") return { exitCode: 0, stdout: ffprobeJson, stderr: "" };
    throw new AppError("E_PROCESS_FAILED", "invalid data found while decoding");
  };
  try {
    const result = await verifyMedia(output, {}, {
      runner,
      ffprobePath: "ffprobe-stub",
      ffmpegPath: "ffmpeg-stub",
      fullDecode: true,
    });
    assert.equal(result.passed, false);
    assert.equal(result.health?.fullDecodeCompleted, false);
    assert.match(result.health?.decodeError ?? "", /invalid data/);
    await assert.rejects(
      verifyMedia(output, {}, {
        runner,
        ffprobePath: "ffprobe-stub",
        ffmpegPath: "ffmpeg-stub",
        fullDecode: true,
        throwOnFailure: true,
      }),
      (error) => error instanceof AppError && error.code === "E_VERIFICATION_FAILED" &&
        (error.details as { health?: { fullDecodeCompleted?: boolean } }).health?.fullDecodeCompleted === false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
