// Runnable check: `npx tsx src/editor/rollSlide.verify.ts`.
import assert from 'node:assert/strict';
import { reduce } from './reduce';
import { applyNeighbourTrimPlan, flushNeighbours, planRoll, planSlide, plannedGeometry } from './rollSlide';
import type { MediaAsset, TimelineItem, TimelineState } from './types';

const asset: MediaAsset = {
  id: 'asset-a',
  name: 'Source A',
  kind: 'video',
  src: '/media/uploads/a.mp4',
  durationInFrames: 300,
};

const clip = (id: string, startFrame: number, durationInFrames: number, srcInFrame: number, patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id,
  track: 'video-main',
  startFrame,
  durationInFrames,
  name: id,
  kind: 'video',
  src: asset.src,
  srcInFrame,
  ...patch,
});

// A | B | C are flush; a 20-frame gap; then D | E flush.
// Head handles: A 30, B 100, C 20, D 0, E 10. Tail handles (300-frame source): A 210, B 140, C 220, D 270, E 260.
const items = (): TimelineItem[] => [
  clip('A', 0, 60, 30),
  clip('B', 60, 60, 100),
  clip('C', 120, 60, 20),
  clip('D', 200, 30, 0),
  clip('E', 230, 30, 10),
];

const stateOf = (candidates: TimelineItem[] = items(), tracks: TimelineState['tracks'] = { 'video-main': { kind: 'video' } }): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items: candidates,
  assets: [asset],
  selectedId: null,
  trackOrder: ['video-main'],
  tracks,
});

const geometry = (state: TimelineState, id: string) => {
  const item = state.items.find((candidate) => candidate.id === id)!;
  return { startFrame: item.startFrame, durationInFrames: item.durationInFrames, srcInFrame: item.srcInFrame };
};
const timelineEnd = (state: TimelineState) => Math.max(...state.items.map((item) => item.startFrame + item.durationInFrames));

{
  const state = stateOf();
  const neighbours = flushNeighbours(state.items, state.items[1]!);
  assert.deepEqual([neighbours.previous?.id, neighbours.next?.id], ['A', 'C']);
  const edgeOfGap = flushNeighbours(state.items, state.items[2]!);
  assert.deepEqual([edgeOfGap.previous?.id, edgeOfGap.next?.id], ['B', undefined], 'a gap is not a neighbour');
}

{
  const state = stateOf();
  const plan = planRoll(state, 'B', 'end', 20);
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.deepEqual(
      { min: plan.minDeltaInFrames, max: plan.maxDeltaInFrames, applied: plan.appliedDeltaInFrames, clamped: plan.clamped },
      { min: -20, max: 59, applied: 20, clamped: false },
      'roll is bounded by the incoming head handle going earlier and by the incoming clip keeping a frame going later',
    );
    assert.equal(plan.patches[0]!.id, 'C', 'the shrinking clip is patched first so no intermediate state overlaps');
  }
  const next = reduce(state, { type: 'roll', id: 'B', edge: 'end', deltaInFrames: 20 });
  assert.deepEqual(geometry(next, 'B'), { startFrame: 60, durationInFrames: 80, srcInFrame: 100 });
  assert.deepEqual(geometry(next, 'C'), { startFrame: 140, durationInFrames: 40, srcInFrame: 40 }, 'the incoming clip keeps its out-point');
  assert.deepEqual(geometry(next, 'A'), geometry(state, 'A'));
  assert.equal(timelineEnd(next), timelineEnd(state), 'a roll never changes the timeline length');
}

{
  const state = stateOf();
  const plan = planRoll(state, 'B', 'end', -30);
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.deepEqual(
      { applied: plan.appliedDeltaInFrames, clamped: plan.clamped },
      { applied: -20, clamped: true },
      'rolling earlier stops when the incoming clip runs out of source before its in-point',
    );
    assert.equal(plan.patches[0]!.id, 'B', 'going earlier, the outgoing clip shrinks first');
  }
  const next = reduce(state, { type: 'roll', id: 'B', edge: 'end', deltaInFrames: -30 });
  assert.deepEqual(geometry(next, 'B'), { startFrame: 60, durationInFrames: 40, srcInFrame: 100 });
  assert.deepEqual(geometry(next, 'C'), { startFrame: 100, durationInFrames: 80, srcInFrame: 0 });
}

{
  const state = stateOf();
  const next = reduce(state, { type: 'roll', id: 'B', edge: 'start', deltaInFrames: -20 });
  assert.deepEqual(geometry(next, 'A'), { startFrame: 0, durationInFrames: 40, srcInFrame: 30 }, 'rolling the start edge earlier shortens the previous clip');
  assert.deepEqual(geometry(next, 'B'), { startFrame: 40, durationInFrames: 80, srcInFrame: 80 });
  assert.equal(timelineEnd(next), timelineEnd(state));
}

{
  const state = stateOf();
  const atGap = planRoll(state, 'C', 'end', 5);
  assert.deepEqual({ ok: atGap.ok, code: atGap.ok ? null : atGap.code }, { ok: false, code: 'no-neighbour' });
  const unknown = planRoll(state, 'missing', 'end', 5);
  assert.deepEqual({ ok: unknown.ok, code: unknown.ok ? null : unknown.code }, { ok: false, code: 'unknown-item' });
  const invalid = planRoll(state, 'B', 'end', Number.NaN);
  assert.deepEqual({ ok: invalid.ok, code: invalid.ok ? null : invalid.code }, { ok: false, code: 'invalid-delta' });
  const locked = planRoll(stateOf(items(), { 'video-main': { kind: 'video', locked: true } }), 'B', 'end', 5);
  assert.deepEqual({ ok: locked.ok, code: locked.ok ? null : locked.code }, { ok: false, code: 'locked-track' });
  assert.strictEqual(
    reduce(state, { type: 'roll', id: 'C', edge: 'end', deltaInFrames: 5 }),
    state,
    'a roll with nothing to roll leaves the state object untouched',
  );
  assert.strictEqual(reduce(state, { type: 'roll', id: 'B', edge: 'end', deltaInFrames: 0 }), state, 'a zero roll is a no-op');
}

{
  // Word-driven audio addresses an edited stream, so its in-point cannot roll.
  const transcript = [{ text: 'a', start: 0, end: 1_000 }, { text: 'b', start: 1_000, end: 2_000 }];
  const spoken = clip('S', 60, 30, 15, { kind: 'audio', track: 'audio-main', transcript, deletedWordIdx: [] });
  const bed = clip('M', 0, 60, 0, { kind: 'audio', track: 'audio-main' });
  const state = stateOf([bed, spoken], { 'audio-main': { kind: 'audio' } });
  const roll = planRoll(state, 'M', 'end', 5);
  assert.deepEqual({ ok: roll.ok, code: roll.ok ? null : roll.code }, { ok: false, code: 'unsupported-kind' });
  const slide = planSlide(state, 'M', 5);
  assert.deepEqual({ ok: slide.ok, code: slide.ok ? null : slide.code }, { ok: false, code: 'unsupported-kind' });
}

{
  const state = stateOf();
  const plan = planSlide(state, 'B', 10);
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.deepEqual(
      { min: plan.minDeltaInFrames, max: plan.maxDeltaInFrames, applied: plan.appliedDeltaInFrames },
      { min: -20, max: 59, applied: 10 },
    );
    assert.deepEqual(plan.patches.map((patch) => patch.id), ['C', 'B', 'A'], 'sliding later shrinks the next clip before anything grows');
    assert.deepEqual(plannedGeometry(plan, 'C'), { id: 'C', startFrame: 130, durationInFrames: 50, srcInFrame: 30 });
    assert.equal(plannedGeometry(plan, 'D'), null, 'an untouched clip has no planned geometry');
  }
  const next = reduce(state, { type: 'slide', id: 'B', deltaInFrames: 10 });
  assert.deepEqual(geometry(next, 'A'), { startFrame: 0, durationInFrames: 70, srcInFrame: 30 });
  assert.deepEqual(geometry(next, 'B'), { startFrame: 70, durationInFrames: 60, srcInFrame: 100 }, 'the slid clip keeps its duration and content');
  assert.deepEqual(geometry(next, 'C'), { startFrame: 130, durationInFrames: 50, srcInFrame: 30 });
  assert.equal(timelineEnd(next), timelineEnd(state));

  const back = reduce(state, { type: 'slide', id: 'B', deltaInFrames: -50 });
  assert.deepEqual(geometry(back, 'A'), { startFrame: 0, durationInFrames: 40, srcInFrame: 30 }, 'sliding earlier clamps to the next clip\'s head handle');
  assert.deepEqual(geometry(back, 'B'), { startFrame: 40, durationInFrames: 60, srcInFrame: 100 });
  assert.deepEqual(geometry(back, 'C'), { startFrame: 100, durationInFrames: 80, srcInFrame: 0 });
}

{
  // Only one flush side: the open side is bounded by the gap, the flush side
  // still by its source handle.
  const state = stateOf();
  const plan = planSlide(state, 'D', -50);
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.deepEqual(
      { min: plan.minDeltaInFrames, max: plan.maxDeltaInFrames, applied: plan.appliedDeltaInFrames, clamped: plan.clamped },
      { min: -10, max: 29, applied: -10, clamped: true },
      'the 20-frame gap before D would allow -20, but E has only 10 head frames to grow into',
    );
  }
  const next = reduce(state, { type: 'slide', id: 'D', deltaInFrames: -50 });
  assert.deepEqual(geometry(next, 'D'), { startFrame: 190, durationInFrames: 30, srcInFrame: 0 });
  assert.deepEqual(geometry(next, 'E'), { startFrame: 220, durationInFrames: 40, srcInFrame: 0 });
  assert.deepEqual(geometry(next, 'C'), geometry(state, 'C'), 'a clip across a gap is not touched');
}

{
  const lone = stateOf([clip('L', 0, 60, 0)]);
  const plan = planSlide(lone, 'L', 5);
  assert.deepEqual({ ok: plan.ok, code: plan.ok ? null : plan.code }, { ok: false, code: 'no-neighbour' });
  assert.strictEqual(reduce(lone, { type: 'slide', id: 'L', deltaInFrames: 5 }), lone);
}

{
  // Linked partners follow every patch, so a video's audio never drifts from its picture.
  const video = clip('V', 60, 60, 100);
  const audio = clip('VA', 60, 60, 100, { kind: 'audio', track: 'audio-main' });
  const state: TimelineState = {
    ...stateOf([clip('A', 0, 60, 30), video, clip('C', 120, 60, 20), audio], { 'video-main': { kind: 'video' }, 'audio-main': { kind: 'audio' } }),
    linkGroups: [{ id: 'g', itemIds: ['V', 'VA'], anchorItemId: 'V', mode: 'linked' }],
  };
  const plan = planSlide(state, 'V', 10);
  assert.equal(plan.ok, true);
  const next = plan.ok ? applyNeighbourTrimPlan(state, plan) : state;
  assert.deepEqual(geometry(next, 'VA'), geometry(next, 'V'), 'the linked audio rides with the slid video');
}

console.log('rollSlide.verify: roll bounds and order, slide bounds on both and one flush side, no-op stability, linked partners ok');
