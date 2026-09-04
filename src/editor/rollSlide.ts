import type { TimelineItem, TimelineState } from './types';
import { hasOperationalTranscript } from '../transcript/types';
import {
  remainingSourceFrames,
  sourceFramesToTimelineFrames,
  timelineFramesToSourceFrames,
} from './sourceLimit';
import { retimeItemWithGroups } from './linkGroups';

/**
 * Roll and slide are trims that move a cut without opening a gap or overlap.
 *
 * Roll moves one cut: the outgoing clip's end and the incoming clip's start
 * travel together, so the timeline stays the same length.
 *
 * Slide moves one clip: its content and duration stay fixed while the flush
 * neighbour before it absorbs the shift at its end and the one after at its
 * start.
 *
 * Both are bounded by every touched clip keeping at least one frame and by
 * the source handles of any clip that grows. A neighbour counts only when it
 * is flush (no gap), because a gap is what the user would otherwise expect to
 * move into. Preview, reducer, inspector and agent all consume these planners
 * so a drag never shows a result the commit would clamp away.
 */

export type RollEdge = 'start' | 'end';

export type NeighbourTrimFailureCode =
  | 'unknown-item'
  | 'locked-track'
  | 'no-neighbour'
  | 'unsupported-kind'
  | 'invalid-delta'
  | 'no-room';

export interface NeighbourTrimFailure {
  ok: false;
  code: NeighbourTrimFailureCode;
  itemId: string;
  error: string;
}

export interface TimingPatch {
  id: string;
  startFrame: number;
  durationInFrames: number;
  srcInFrame: number;
}

export interface NeighbourTrimPlan {
  ok: true;
  operation: 'roll' | 'slide';
  itemId: string;
  requestedDeltaInFrames: number;
  appliedDeltaInFrames: number;
  minDeltaInFrames: number;
  maxDeltaInFrames: number;
  clamped: boolean;
  /** Every clip the edit rewrites, in a safe apply order. */
  patches: TimingPatch[];
}

export type NeighbourTrimResult = NeighbourTrimFailure | NeighbourTrimPlan;

const EPSILON = 1e-6;

function failure(itemId: string, code: NeighbourTrimFailureCode, error: string): NeighbourTrimFailure {
  return { ok: false, code, itemId, error };
}

export interface FlushNeighbours {
  previous: TimelineItem | null;
  next: TimelineItem | null;
}

/** Same-track clips whose edge sits exactly on the item's edge. */
export function flushNeighbours(items: readonly TimelineItem[], item: TimelineItem): FlushNeighbours {
  const end = item.startFrame + item.durationInFrames;
  let previous: TimelineItem | null = null;
  let next: TimelineItem | null = null;
  for (const candidate of items) {
    if (candidate.id === item.id || candidate.track !== item.track) continue;
    if (candidate.startFrame + candidate.durationInFrames === item.startFrame) previous = candidate;
    if (candidate.startFrame === end) next = candidate;
  }
  return { previous, next };
}

/** Nearest same-track edge in each direction, for a clip with no flush neighbour on that side. */
function gapRoom(items: readonly TimelineItem[], item: TimelineItem): { before: number; after: number } {
  const end = item.startFrame + item.durationInFrames;
  let before = item.startFrame;
  let after = Infinity;
  for (const candidate of items) {
    if (candidate.id === item.id || candidate.track !== item.track) continue;
    const candidateEnd = candidate.startFrame + candidate.durationInFrames;
    if (candidateEnd <= item.startFrame) before = Math.min(before, item.startFrame - candidateEnd);
    if (candidate.startFrame >= end) after = Math.min(after, candidate.startFrame - end);
  }
  return { before, after };
}

/** Timeline frames a clip can grow at its end before its source runs out (Infinity when unbounded). */
function tailHandle(item: TimelineItem, assets: TimelineState['assets']): number {
  const remaining = remainingSourceFrames(item, item.srcInFrame ?? 0, assets);
  return remaining === null ? Infinity : Math.max(0, remaining - item.durationInFrames);
}

/** Timeline frames a clip can grow at its start before its source in-point reaches zero. */
function headHandle(item: TimelineItem): number {
  if (item.kind !== 'video' && item.kind !== 'audio' && item.kind !== 'sequence') return Infinity;
  const wordDriven = item.kind === 'audio' && hasOperationalTranscript(item);
  return Math.floor(wordDriven ? (item.srcInFrame ?? 0) : sourceFramesToTimelineFrames(item, item.srcInFrame ?? 0));
}

/** A clip whose in-point moves must address source frames; word-driven audio addresses an edited stream instead. */
function inPointMovable(item: TimelineItem): boolean {
  return !(item.kind === 'audio' && hasOperationalTranscript(item));
}

function shiftedSrcIn(item: TimelineItem, timelineDelta: number): number {
  const sourceDelta = timelineFramesToSourceFrames(item, timelineDelta);
  return Math.max(0, Math.round((item.srcInFrame ?? 0) + sourceDelta));
}

function clampDelta(requested: number, min: number, max: number): { applied: number; clamped: boolean } {
  const applied = Math.round(Math.min(Math.max(requested, min), max));
  return { applied, clamped: Math.abs(applied - requested) > 0.5 + EPSILON };
}

/** Roll the cut at one edge of `itemId`; positive moves the cut later. */
export function planRoll(
  state: TimelineState,
  itemId: string,
  edge: RollEdge,
  requestedDeltaInFrames: number,
): NeighbourTrimResult {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) return failure(itemId, 'unknown-item', `item not found: ${itemId}`);
  if (state.tracks?.[item.track]?.locked) return failure(itemId, 'locked-track', `track ${item.track} is locked`);
  const neighbours = flushNeighbours(state.items, item);
  const outgoing = edge === 'end' ? item : neighbours.previous;
  const incoming = edge === 'end' ? neighbours.next : item;
  if (!outgoing || !incoming) {
    return failure(itemId, 'no-neighbour', `no clip is flush against the ${edge} of ${itemId}, so there is no cut to roll`);
  }
  if (!inPointMovable(incoming)) {
    return failure(itemId, 'unsupported-kind', 'the incoming clip is word-driven audio, whose in-point cannot roll');
  }
  if (!Number.isFinite(requestedDeltaInFrames)) return failure(itemId, 'invalid-delta', 'deltaInFrames must be a finite number');
  const min = -Math.min(outgoing.durationInFrames - 1, headHandle(incoming));
  const max = Math.min(incoming.durationInFrames - 1, tailHandle(outgoing, state.assets));
  if (min > -1 + EPSILON && max < 1 - EPSILON) {
    return failure(itemId, 'no-room', 'neither clip has a frame to give at this cut');
  }
  const { applied, clamped } = clampDelta(requestedDeltaInFrames, min, max);
  // Shrinking side first so the intermediate state never overlaps.
  const shrinkIncoming: TimingPatch = {
    id: incoming.id,
    startFrame: incoming.startFrame + applied,
    durationInFrames: incoming.durationInFrames - applied,
    srcInFrame: shiftedSrcIn(incoming, applied),
  };
  const growOutgoing: TimingPatch = {
    id: outgoing.id,
    startFrame: outgoing.startFrame,
    durationInFrames: outgoing.durationInFrames + applied,
    srcInFrame: outgoing.srcInFrame ?? 0,
  };
  return {
    ok: true,
    operation: 'roll',
    itemId,
    requestedDeltaInFrames,
    appliedDeltaInFrames: applied,
    minDeltaInFrames: min,
    maxDeltaInFrames: max,
    clamped,
    patches: applied >= 0 ? [shrinkIncoming, growOutgoing] : [growOutgoing, shrinkIncoming],
  };
}

/** Slide `itemId` in time; positive moves it later. Flush neighbours absorb the shift. */
export function planSlide(
  state: TimelineState,
  itemId: string,
  requestedDeltaInFrames: number,
): NeighbourTrimResult {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) return failure(itemId, 'unknown-item', `item not found: ${itemId}`);
  if (state.tracks?.[item.track]?.locked) return failure(itemId, 'locked-track', `track ${item.track} is locked`);
  if (!Number.isFinite(requestedDeltaInFrames)) return failure(itemId, 'invalid-delta', 'deltaInFrames must be a finite number');
  const { previous, next } = flushNeighbours(state.items, item);
  if (!previous && !next) {
    return failure(itemId, 'no-neighbour', `no clip is flush against ${itemId}; move it instead of sliding it`);
  }
  if (next && !inPointMovable(next)) {
    return failure(itemId, 'unsupported-kind', 'the following clip is word-driven audio, whose in-point cannot move');
  }
  const room = gapRoom(state.items, item);
  // Moving earlier shrinks the previous clip (or eats the gap before) and
  // grows the next clip at its start; moving later is the mirror image. A
  // growing neighbour is bounded by its source handle whether or not the
  // other side is flush.
  const min = -Math.min(
    previous ? previous.durationInFrames - 1 : room.before,
    next ? headHandle(next) : Infinity,
  );
  const max = Math.min(
    next ? next.durationInFrames - 1 : room.after,
    previous ? tailHandle(previous, state.assets) : Infinity,
  );
  if (min > -1 + EPSILON && max < 1 - EPSILON) {
    return failure(itemId, 'no-room', 'the neighbouring clips have no frame to give');
  }
  const { applied, clamped } = clampDelta(requestedDeltaInFrames, min, max);
  const moved: TimingPatch = {
    id: item.id,
    startFrame: item.startFrame + applied,
    durationInFrames: item.durationInFrames,
    srcInFrame: item.srcInFrame ?? 0,
  };
  const previousPatch: TimingPatch | null = previous ? {
    id: previous.id,
    startFrame: previous.startFrame,
    durationInFrames: previous.durationInFrames + applied,
    srcInFrame: previous.srcInFrame ?? 0,
  } : null;
  const nextPatch: TimingPatch | null = next ? {
    id: next.id,
    startFrame: next.startFrame + applied,
    durationInFrames: next.durationInFrames - applied,
    srcInFrame: shiftedSrcIn(next, applied),
  } : null;
  // Whichever side shrinks goes first so no intermediate state overlaps.
  const ordered = applied >= 0
    ? [nextPatch, moved, previousPatch]
    : [previousPatch, moved, nextPatch];
  return {
    ok: true,
    operation: 'slide',
    itemId,
    requestedDeltaInFrames,
    appliedDeltaInFrames: applied,
    minDeltaInFrames: min,
    maxDeltaInFrames: max,
    clamped,
    patches: ordered.filter((patch): patch is TimingPatch => patch !== null),
  };
}

/**
 * Apply a plan's patches through the link-group retime so a linked partner
 * (a video's audio) follows. Returns the original state when nothing applies.
 */
export function applyNeighbourTrimPlan(state: TimelineState, plan: NeighbourTrimPlan): TimelineState {
  if (Math.abs(plan.appliedDeltaInFrames) < EPSILON) return state;
  let next = state;
  for (const patch of plan.patches) {
    const applied = retimeItemWithGroups(next, patch.id, patch);
    if (!applied) return state;
    next = applied;
  }
  return next;
}

/** Geometry the timeline should draw for `itemId` while a plan is being previewed. */
export function plannedGeometry(plan: NeighbourTrimResult | null, itemId: string): TimingPatch | null {
  if (!plan?.ok) return null;
  return plan.patches.find((patch) => patch.id === itemId) ?? null;
}
