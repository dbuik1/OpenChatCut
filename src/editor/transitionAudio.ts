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

/** Attack completes by the time the anchor starts, so nothing is ducked late. */
const DUCK_ATTACK_SECONDS = 0.08;
/** Release is slower than attack: a fast recovery pumps between close anchors. */
const DUCK_RELEASE_SECONDS = 0.4;

export type DuckRange = readonly [from: number, to: number];

/**
 * How far a follower track is ducked at a frame, from 0 (untouched) to 1 (full
 * depth), given the frames an anchor occupies.
 *
 * Stepping straight to full depth at an anchor boundary is an instantaneous
 * gain change, which is audible as a click and, between clips, as pumping. The
 * ramp down finishes as the anchor begins rather than starting there, so the
 * anchor's first word is never heard over an un-ducked bed. Overlapping anchors
 * take the deepest envelope, so a gap between two of them cannot briefly
 * un-duck the bed.
 */
export function duckEnvelopeAt(frame: number, ranges: readonly DuckRange[], fps: number): number {
  if (!ranges.length || fps <= 0) return 0;
  const attack = Math.max(1, Math.round(fps * DUCK_ATTACK_SECONDS));
  const release = Math.max(1, Math.round(fps * DUCK_RELEASE_SECONDS));
  let envelope = 0;
  for (const [from, to] of ranges) {
    if (frame >= from && frame < to) return 1;
    if (frame < from) {
      if (frame > from - attack) envelope = Math.max(envelope, (frame - (from - attack)) / attack);
      continue;
    }
    if (frame < to + release) envelope = Math.max(envelope, 1 - (frame - to) / release);
  }
  return Math.min(1, Math.max(0, envelope));
}

/** Linear gain for a duck depth in dB at a given envelope position. */
export function duckGainFor(depthDb: number, envelope: number): number {
  return 10 ** ((depthDb * envelope) / 20);
}
