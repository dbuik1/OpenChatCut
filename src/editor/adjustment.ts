import type { ClipFilters, TimelineItem } from './types';
import { clipOpacityAt } from './clipFade';

/**
 * An adjustment layer draws nothing of its own. For every frame it covers it
 * grades the composite of every video track beneath it with its `filters`,
 * so the same brightness/contrast/saturation/blur controls a clip carries
 * apply to a whole stack at once. Its opacity (fades, the opacity keyframe,
 * transform.opacity) is the grade's strength: at 0 the picture below shows
 * ungraded, never black, because fading a grade out must not fade the
 * footage out.
 */

const IDENTITY: Required<ClipFilters> = { brightness: 1, contrast: 1, saturate: 1, blur: 0 };

export function isAdjustmentActiveAt(item: TimelineItem, frame: number): boolean {
  return frame >= item.startFrame && frame < item.startFrame + item.durationInFrames;
}

/** Filters interpolated from identity by `strength` (0..1). */
export function scaledFilters(filters: ClipFilters | undefined, strength: number): Required<ClipFilters> {
  const k = Math.max(0, Math.min(1, strength));
  const mix = (value: number | undefined, identity: number) => identity + ((value ?? identity) - identity) * k;
  return {
    brightness: mix(filters?.brightness, IDENTITY.brightness),
    contrast: mix(filters?.contrast, IDENTITY.contrast),
    saturate: mix(filters?.saturate, IDENTITY.saturate),
    blur: mix(filters?.blur, IDENTITY.blur),
  };
}

/**
 * CSS filter for the wrapper around the tracks below at `frame`, or undefined
 * when the layer is outside its range or grades nothing. The string matches
 * the per-clip filter string so a grade moved from a clip to a layer looks
 * the same.
 */
export function adjustmentFilterAt(item: TimelineItem, frame: number): string | undefined {
  if (!isAdjustmentActiveAt(item, frame)) return undefined;
  // The wrapper sits outside the layer's own Sequence, so `frame` is the
  // composition frame; opacity, fades and keyframes are item-local.
  const f = scaledFilters(item.filters, clipOpacityAt(item, frame - item.startFrame));
  if (f.brightness === 1 && f.contrast === 1 && f.saturate === 1 && f.blur === 0) return undefined;
  return `brightness(${f.brightness}) contrast(${f.contrast}) saturate(${f.saturate}) blur(${f.blur}px)`;
}

export interface AdjustmentTrackLayer<T> {
  /** Adjustment items on this track, any order. */
  adjustments: readonly TimelineItem[];
  /** Everything else painted on this track, already in paint order. */
  content: readonly T[];
}

/**
 * Fold a bottom-up list of track layers into paint order. Each adjustment
 * wraps everything painted before it (the tracks below); content on the
 * adjustment's own track paints above the wrapper, so a layer never grades
 * a clip beside it. Two adjustments on one track wrap in start order, which
 * is only observable when their ranges overlap.
 */
export function foldAdjustmentLayers<T>(
  layersBottomUp: readonly AdjustmentTrackLayer<T>[],
  wrap: (adjustment: TimelineItem, below: T[]) => T,
): T[] {
  let painted: T[] = [];
  for (const layer of layersBottomUp) {
    const ordered = [...layer.adjustments].sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
    for (const adjustment of ordered) painted = [wrap(adjustment, painted)];
    painted = [...painted, ...layer.content];
  }
  return painted;
}
