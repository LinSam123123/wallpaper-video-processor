import { open, stat } from "node:fs/promises";

export interface PngDimensions {
  width: number;
  height: number;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer | null> {
  const buffer = Buffer.alloc(length);
  const result = await handle.read(buffer, 0, length, position);
  return result.bytesRead === length ? buffer : null;
}

export async function inspectPng(path: string): Promise<PngDimensions | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const fileSize = (await stat(path)).size;
    if (fileSize < 57) return null;
    handle = await open(path, "r");
    const signature = await readExactly(handle, 8, 0);
    if (!signature?.equals(SIGNATURE)) return null;

    let offset = 8;
    let dimensions: PngDimensions | null = null;
    let sawImageData = false;
    let chunkCount = 0;
    while (offset + 12 <= fileSize && chunkCount < 100_000) {
      const header = await readExactly(handle, 8, offset);
      if (!header) return null;
      const dataLength = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      const nextOffset = offset + 12 + dataLength;
      if (nextOffset > fileSize) return null;
      if (chunkCount === 0) {
        if (type !== "IHDR" || dataLength !== 13) return null;
        const ihdr = await readExactly(handle, 13, offset + 8);
        if (!ihdr) return null;
        const width = ihdr.readUInt32BE(0);
        const height = ihdr.readUInt32BE(4);
        if (width === 0 || height === 0) return null;
        dimensions = { width, height };
      }
      if (type === "IDAT") sawImageData = true;
      if (type === "IEND") {
        if (dataLength !== 0 || !dimensions || !sawImageData) return null;
        return dimensions;
      }
      offset = nextOffset;
      chunkCount += 1;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function validatePng(path: string, expected?: PngDimensions): Promise<boolean> {
  const actual = await inspectPng(path);
  if (!actual) return false;
  return expected === undefined || (actual.width === expected.width && actual.height === expected.height);
}
