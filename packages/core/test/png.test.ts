import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectPng, validatePng } from "../src/index.js";
import { testPng } from "./test-png.js";

test("PNG inspection accepts a complete image and reports its dimensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-png-valid-"));
  const path = join(root, "frame.png");
  try {
    await writeFile(path, testPng(16, 10));
    assert.deepEqual(await inspectPng(path), { width: 16, height: 10 });
    assert.equal(await validatePng(path, { width: 16, height: 10 }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PNG inspection rejects empty, signature-only, and unterminated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-png-invalid-"));
  try {
    const empty = join(root, "empty.png");
    const signature = join(root, "signature.png");
    const unterminated = join(root, "unterminated.png");
    const complete = testPng(16, 10);
    await Promise.all([
      writeFile(empty, Buffer.alloc(0)),
      writeFile(signature, complete.subarray(0, 8)),
      writeFile(unterminated, complete.subarray(0, -12)),
    ]);
    assert.equal(await inspectPng(empty), null);
    assert.equal(await inspectPng(signature), null);
    assert.equal(await inspectPng(unterminated), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PNG validation rejects dimensions that do not match the expected frame size", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallpaper-png-size-"));
  const path = join(root, "frame.png");
  try {
    await writeFile(path, testPng(16, 10));
    assert.equal(await validatePng(path, { width: 48, height: 30 }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
