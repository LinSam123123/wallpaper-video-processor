import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../src/index.js";

test("command capture reports truncation instead of silently returning only the tail", async () => {
  const result = await runCommand({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(4096)); process.stderr.write('y'.repeat(2048))"],
  }, { maxCaptureBytes: 128 });

  assert.equal(result.stdout.length, 128);
  assert.equal(result.stderr.length, 128);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});
