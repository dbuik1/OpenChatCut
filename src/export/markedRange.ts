/**
 * The timeline's in/out marks, reduced to the bound an export can actually
 * carry. Marks are set independently — I without O is a normal half-finished
 * gesture — so anything but a positive-length pair means "whole timeline".
 */
export interface MarkedRange {
  startFrame: number;
  endFrameExclusive: number;
}

export function markedRangeFromZone(
  zone: { inFrame: number | null; outFrame: number | null } | null | undefined,
): MarkedRange | null {
  const start = zone?.inFrame;
  const end = zone?.outFrame;
  if (start == null || end == null) return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start) return null;
  return { startFrame: start, endFrameExclusive: end };
}
