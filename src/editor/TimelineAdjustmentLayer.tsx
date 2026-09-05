import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import type { TimelineItem } from './types';
import { adjustmentFilterAt } from './adjustment';

/**
 * Wraps the tracks painted below an adjustment layer. The wrapper is always
 * mounted so the media elements inside keep their identity across the
 * layer's in and out points; only the filter toggles with the frame.
 */
export function AdjustmentLayer({ item, children }: { item: TimelineItem; children: ReactNode }) {
  const frame = useCurrentFrame();
  const filter = adjustmentFilterAt(item, frame);
  return (
    <AbsoluteFill data-adjustment={item.id} style={filter ? { filter } : undefined}>
      {children}
    </AbsoluteFill>
  );
}
