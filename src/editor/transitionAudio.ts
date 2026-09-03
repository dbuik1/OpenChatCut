import { isAudioTransition } from './types';
import type { TimelineItem, TransitionItem } from './types';
import { sourceFrameAt } from './sourceLimit';

const FRAME_EPSILON = 0.01;

function canShareAudio(
  previous: TimelineItem,
  next: TimelineItem,
  audioTransitionPairs: Set<string>,
): boolean {
  const previousAudio = previous.denoisedSrc || previous.src;
  const nextAudio = next.denoisedSrc || next.src;
  if (!previousAudio || previousAudio !== nextAudio || previous.track !== next.track) return false;
  if ((previous.denoisedSrc || next.denoisedSrc)
    && (previous.src !== next.src
      || (previous.denoiseStrength ?? 100) !== (next.denoiseStrength ?? 100))) return false;
  if (previous.startFrame + previous.durationInFrames !== next.startFrame) return false;
  if (Math.abs((previous.playbackRate ?? 1) - (next.playbackRate ?? 1)) > FRAME_EPSILON) return false;
  if (audioTransitionPairs.has(`${previous.id}:${next.id}`)) return false;
  return Math.abs(sourceFrameAt(previous, previous.durationInFrames) - sourceFrameAt(next, 0)) <= FRAME_EPSILON;
}

export function continuousVideoAudioGroups(
  items: TimelineItem[],
  transitions?: TransitionItem[],
): TimelineItem[][] {
  const audioTransitionPairs = new Set((transitions ?? [])
    .filter((transition) => transition.enabled !== false && isAudioTransition(transition.type))
    .map((transition) => `${transition.outgoingItemId}:${transition.incomingItemId}`));
  const videos = items
    .filter((item) => item.kind === 'video' && !!item.src)
    .sort((a, b) => a.track.localeCompare(b.track) || a.startFrame - b.startFrame);
  const groups: TimelineItem[][] = [];
  for (const item of videos) {
    const group = groups.at(-1);
    if (group?.length && canShareAudio(group.at(-1)!, item, audioTransitionPairs)) group.push(item);
    else groups.push([item]);
  }
  return groups.filter((group) => group.length > 1);
}

/** Whether a clip can join a shared-visual group: one decoder element plays
 *  the consecutive same-source run. Any per-clip rendering concern (GL effect,
 *  background fill, transition extension/entrance, denoise, animated
 *  transform/keyframes/zoom, filters) keeps the clip on its own element. */
export function shareableVisualItem(input: {
  item: TimelineItem;
  hasBackgroundFill: boolean;
  hasExtendBefore: boolean;
  hasExtendAfter: boolean;
  hasEntrance: boolean;
  hasGlEffect: boolean;
}): boolean {
  const { item } = input;
  return item.kind === 'video'
    && !!item.src
    && !item.denoisedSrc
    && !input.hasGlEffect
    && !input.hasBackgroundFill
    && !input.hasExtendBefore
    && !input.hasExtendAfter
    && !input.hasEntrance
    && !item.transform
    && !item.keyframes
    && !item.filters;
}

/**
 * Equal-power crossfade gain for a position in [0,1] through the transition.
 *
 * Two clips crossfading are uncorrelated signals, so their powers add while
 * their amplitudes do not. Ramping amplitude linearly puts both sides at 0.5 in
 * the middle, which sums to half the power of either side alone — an audible
 * dip at the centre of every audio transition. Taking the square root holds the
 * summed power constant across the whole ramp.
 */
export function equalPowerGain(position: number): number {
  return Math.sqrt(Math.min(1, Math.max(0, position)));
}
