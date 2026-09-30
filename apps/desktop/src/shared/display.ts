export function physicalDisplaySize(
  size: { width: number; height: number },
  scaleFactor: number,
): { width: number; height: number } {
  const toEvenPixels = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  return {
    width: toEvenPixels(size.width * scaleFactor),
    height: toEvenPixels(size.height * scaleFactor),
  };
}
