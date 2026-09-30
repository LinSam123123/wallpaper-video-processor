import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "@wallpaper-video/core";
import { optionalStringFlag, parseArguments, previewOptionsFromFlags } from "../src/arguments.js";

test("work-dir accepts separate and equals-style values", () => {
  const separate = parseArguments(["preview", "--config", "job.json", "--work-dir", "D:\\scratch space"]);
  assert.equal(separate.command, "preview");
  assert.equal(optionalStringFlag(separate.flags, "work-dir"), "D:\\scratch space");

  const equals = parseArguments(["process", "--config=job.json", "--work-dir=D:\\scratch"]);
  assert.equal(equals.command, "process");
  assert.equal(optionalStringFlag(equals.flags, "work-dir"), "D:\\scratch");
});

test("work-dir requires a path when present", () => {
  const { flags } = parseArguments(["process", "--config", "job.json", "--work-dir"]);
  assert.throws(
    () => optionalStringFlag(flags, "work-dir"),
    (error: unknown) => {
      if (!(error instanceof AppError)) return false;
      assert.deepEqual(error.toJSON(), {
        code: "E_INVALID_ARGUMENT",
        message: "--work-dir requires a value",
      });
      return true;
    },
  );
});

test("rife accepts separate and equals-style executable paths", () => {
  const separate = parseArguments(["doctor", "--rife", "D:\\tools\\rife-ncnn-vulkan.exe"]);
  assert.equal(optionalStringFlag(separate.flags, "rife"), "D:\\tools\\rife-ncnn-vulkan.exe");

  const equals = parseArguments(["preview", "--config=job.json", "--rife=D:\\rife\\rife.exe"]);
  assert.equal(optionalStringFlag(equals.flags, "rife"), "D:\\rife\\rife.exe");
});

test("preview controls parse segment and ping-pong boundary modes", () => {
  const segment = parseArguments(["preview", "--center", "4.5", "--frames", "60"]);
  assert.deepEqual(previewOptionsFromFlags(segment.flags, "pingpong"), {
    centerSeconds: 4.5,
    frameCount: 60,
  });

  const boundary = parseArguments([
    "preview",
    "--preview-mode", "loop-boundary",
    "--turn", "start",
  ]);
  assert.deepEqual(previewOptionsFromFlags(boundary.flags, "pingpong"), {
    previewMode: "loop-boundary",
    turn: "start",
  });
});

test("preview controls reject invalid modes and incompatible combinations", () => {
  const cases: Array<{ argv: string[]; loopMode?: "pingpong" | "none"; message: string }> = [
    { argv: ["preview", "--preview-mode", "boundary"], message: "--preview-mode must be" },
    { argv: ["preview", "--turn", "middle"], message: "--turn must be" },
    {
      argv: ["preview", "--preview-mode", "loop-boundary", "--center", "2"],
      message: "--center cannot be used",
    },
    { argv: ["preview", "--turn", "end"], message: "--turn requires" },
    {
      argv: ["preview", "--preview-mode", "loop-boundary", "--turn", "end"],
      loopMode: "none",
      message: "--turn requires",
    },
  ];
  for (const entry of cases) {
    const parsed = parseArguments(entry.argv);
    assert.throws(
      () => previewOptionsFromFlags(parsed.flags, entry.loopMode ?? "pingpong"),
      (error: unknown) => error instanceof AppError &&
        error.code === "E_INVALID_ARGUMENT" &&
        error.message.includes(entry.message),
    );
  }
});
