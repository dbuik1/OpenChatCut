import { isAudioTransition } from './types';
import type { TimelineItem, TransitionItem } from './types';
import { sourceFrameAt } from './sourceLimit';
import { itemEditOpts, itemWindow, keptSegments } from '../transcript/edit';
import { hasOperationalTranscript, msToFrame, type TranscriptCarrier } from '../transcript/types';

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

/** Track gain as a linear multiplier; the ceiling stops a runaway value from clipping every clip on the lane. */
export const TRACK_GAIN_MIN_DB = -60;
export const TRACK_GAIN_MAX_DB = 12;

export function clampTrackGainDb(gainDb: number): number {
  if (!Number.isFinite(gainDb)) return 0;
  return Math.max(TRACK_GAIN_MIN_DB, Math.min(TRACK_GAIN_MAX_DB, gainDb));
}

export function trackGainFor(gainDb: number | undefined): number {
  if (!gainDb) return 1;
  return 10 ** (clampTrackGainDb(gainDb) / 20);
}

/**
 * The frames an anchor clip is actually speaking, as duck ranges.
 *
 * Ducking the whole clip holds the bed down through every pause, so a clip
 * that is 40% silence still buries the music for its entire length. Word
 * timings put the bed back up in the gaps.
 *
 * Two constraints shape this. Ranges closer together than the envelope can
 * recover through are merged, because a gap the bed cannot climb out of is not
 * a gap — that also keeps the range count proportional to real pauses rather
 * than to word count, which matters when this is evaluated once per audio
 * frame. And a clip whose transcript is missing or stale falls back to its
 * whole extent: an anchor with no word timings is not an anchor that never
 * speaks, and silently declining to duck it would be worse than ducking it
 * too much.
 */
export function anchorDuckRanges(
  item: Pick<TimelineItem, 'startFrame' | 'durationInFrames' | 'deletedWordIdx'>
    & TranscriptCarrier
    & Parameters<typeof itemEditOpts>[0]
    & Parameters<typeof itemWindow>[0],
  fps: number,
): DuckRange[] {
  const wholeClip: DuckRange[] = [[item.startFrame, item.startFrame + item.durationInFrames]];
  if (fps <= 0 || !hasOperationalTranscript(item)) return wholeClip;

  const segments = keptSegments(
    item.transcript,
    new Set(item.deletedWordIdx ?? []),
    fps,
    item.startFrame,
    { ...itemEditOpts(item), window: itemWindow(item) },
  );
  if (!segments.length) return wholeClip;

  const spoken: DuckRange[] = [];
  for (const word of item.transcript) {
    const srcStart = msToFrame(word.start, fps);
    const srcEnd = Math.max(srcStart, msToFrame(word.end, fps));
    const segment = segments.find((candidate) => (
      srcStart >= candidate.srcStartFrame && srcStart < candidate.srcEndFrame
    ));
    if (!segment) continue; // deleted, reordered out, or outside the clip's window
    const srcSpan = segment.srcEndFrame - segment.srcStartFrame;
    // A retimed clip plays its source span over a different number of timeline
    // frames, so word positions have to be projected, not offset.
    const scale = srcSpan > 0 ? segment.durFrames / srcSpan : 1;
    const from = segment.fromFrame + (srcStart - segment.srcStartFrame) * scale;
    const to = segment.fromFrame + (Math.min(srcEnd, segment.srcEndFrame) - segment.srcStartFrame) * scale;
    spoken.push([Math.round(from), Math.max(Math.round(from) + 1, Math.round(to))]);
  }
  if (!spoken.length) return wholeClip;

  spoken.sort((a, b) => a[0] - b[0]);
  const recovery = Math.max(1, Math.round(fps * (DUCK_ATTACK_SECONDS + DUCK_RELEASE_SECONDS)));
  const merged: DuckRange[] = [spoken[0]!];
  for (const [from, to] of spoken.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (from - last[1] <= recovery) merged[merged.length - 1] = [last[0], Math.max(last[1], to)];
    else merged.push([from, to]);
  }
  return merged;
}
