import { stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function resolveAvailableOutputPath(preferredPath: string): Promise<string> {
  if (!preferredPath.trim()) {
    throw Object.assign(new Error("输出路径不能为空"), { code: "E_INVALID_ARGUMENT" });
  }

  const preferred = resolve(preferredPath.trim());
  const parent = dirname(preferred);
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory()) {
    throw Object.assign(new Error(`输出目录不是文件夹: ${parent}`), { code: "ENOTDIR", path: parent });
  }
  if (!await pathExists(preferred)) return preferred;

  const parsed = parse(preferred);
  const numbered = /^(.*) \((\d+)\)$/.exec(parsed.name);
  const parsedNumber = numbered ? Number(numbered[2]) : 0;
  const hasNumberedSuffix = numbered !== null && Number.isSafeInteger(parsedNumber) && parsedNumber >= 2;
  const baseName = hasNumberedSuffix ? numbered[1]! : parsed.name;
  let candidateNumber = hasNumberedSuffix ? parsedNumber + 1 : 2;

  while (Number.isSafeInteger(candidateNumber)) {
    const candidate = join(parsed.dir, `${baseName} (${candidateNumber})${parsed.ext}`);
    if (!await pathExists(candidate)) return candidate;
    candidateNumber += 1;
  }

  throw Object.assign(new Error("无法为输出视频分配可用编号"), { code: "E_IO" });
}
