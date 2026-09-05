// An adjustment layer grades the tracks below it for its range; its opacity
// is the grade's strength, so a faded-out grade shows ungraded footage.
// npx tsx src/editor/adjustment.verify.ts
import assert from 'node:assert/strict';
import { adjustmentFilterAt, foldAdjustmentLayers, scaledFilters } from './adjustment';
import { makeDraft } from './store';
import { docFromTimeline } from '../persist/projectStore';
import type { TimelineItem } from './types';

const layer = (over: Partial<TimelineItem>): TimelineItem => ({
  id: 'adj', track: 'V2', kind: 'adjustment', name: '调整图层',
  startFrame: 10, durationInFrames: 20, width: 1920, height: 1080,
  filters: { brightness: 1.5, contrast: 0.5, saturate: 2, blur: 4 },
  ...over,
} as TimelineItem);

// Range: active on [start, end), undefined outside.
assert.equal(adjustmentFilterAt(layer({}), 9), undefined);
assert.equal(adjustmentFilterAt(layer({}), 10), 'brightness(1.5) contrast(0.5) saturate(2) blur(4px)');
assert.equal(adjustmentFilterAt(layer({}), 29), 'brightness(1.5) contrast(0.5) saturate(2) blur(4px)');
assert.equal(adjustmentFilterAt(layer({}), 30), undefined);
// A layer with identity filters wraps nothing.
assert.equal(adjustmentFilterAt(layer({ filters: undefined }), 15), undefined);
assert.equal(adjustmentFilterAt(layer({ filters: { brightness: 1 } }), 15), undefined);

// Strength scales every field toward identity, never toward black.
assert.deepEqual(scaledFilters({ brightness: 1.5, contrast: 0.5, saturate: 2, blur: 4 }, 0.5),
  { brightness: 1.25, contrast: 0.75, saturate: 1.5, blur: 2 });
assert.deepEqual(scaledFilters({ brightness: 1.5 }, 0), { brightness: 1, contrast: 1, saturate: 1, blur: 0 });
// A fade-in ramps the grade, and at strength 0 the wrapper is unfiltered.
const fading = layer({ fadeInFrames: 10 });
assert.equal(adjustmentFilterAt(fading, 10), undefined, 'frame 0 of a fade-in is strength 0');
assert.equal(adjustmentFilterAt(fading, 15), 'brightness(1.25) contrast(0.75) saturate(1.5) blur(2px)');
// transform.opacity is a constant strength.
assert.equal(adjustmentFilterAt(layer({ transform: { opacity: 0.5 } }), 12), 'brightness(1.25) contrast(0.75) saturate(1.5) blur(2px)');

// Paint order: each adjustment wraps what was painted below it; content on
// its own track paints above the wrapper; a lower adjustment nests inside.
const a1 = layer({ id: 'a1', track: 'V2', startFrame: 0 });
const a2 = layer({ id: 'a2', track: 'V3', startFrame: 0 });
const a3 = layer({ id: 'a3', track: 'V3', startFrame: 50 });
const painted = foldAdjustmentLayers<string>([
  { adjustments: [], content: ['v1a', 'v1b'] },
  { adjustments: [a1], content: ['v2a'] },
  { adjustments: [a3, a2], content: [] },
  { adjustments: [], content: ['v4a'] },
], (adjustment, below) => `${adjustment.id}(${below.join(',')})`);
assert.deepEqual(painted, ['a3(a2(a1(v1a,v1b),v2a))', 'v4a']);
// No adjustments: flat paint order, unchanged.
assert.deepEqual(foldAdjustmentLayers<string>([
  { adjustments: [], content: ['x'] }, { adjustments: [], content: ['y'] },
], () => 'never'), ['x', 'y']);

// Creation lands over footage: the topmost video track when it is clear for
// the range, otherwise one new track above, in one undo step.
const base = docFromTimeline({
  fps: 30, width: 1920, height: 1080, selectedId: null, assets: [],
  trackOrder: ['V2', 'V1', 'A1'],
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, A1: { kind: 'audio' } },
  items: [{ id: 'clip', track: 'V1', kind: 'solid', name: 'bg', startFrame: 0, durationInFrames: 300, width: 1920, height: 1080 } as TimelineItem],
});
const draft = makeDraft(base);
const topTrack = draft.getState().trackOrder![0]!;
const bottomTrack = draft.getState().trackOrder![1]!;
const first = draft.commands.addAdjustmentItem({ startFrame: 0 });
const firstItem = draft.getState().items.find((item) => item.id === first)!;
assert.equal(firstItem.kind, 'adjustment');
assert.equal(firstItem.track, topTrack, 'the clear top track is used');
assert.equal(firstItem.durationInFrames, 150, 'defaults to 5 s at the timeline fps');
assert.equal(firstItem.width, 1920);
const second = draft.commands.addAdjustmentItem({ startFrame: 60, durationInFrames: 30 });
const secondItem = draft.getState().items.find((item) => item.id === second)!;
assert.notEqual(secondItem.track, topTrack, 'an occupied top track gets a new one above');
const order = draft.getState().trackOrder ?? [];
assert.equal(order[0], secondItem.track, 'the new track is the topmost video track');
assert.equal(draft.getState().tracks?.[secondItem.track]?.kind, 'video');
const third = draft.commands.addAdjustmentItem({ startFrame: 200, durationInFrames: 30 });
assert.equal(draft.getState().items.find((item) => item.id === third)!.track, secondItem.track, 'a clear range reuses the top track');
const pinned = draft.commands.addAdjustmentItem({ startFrame: 0, track: bottomTrack, name: 'look' });
const pinnedItem = draft.getState().items.find((item) => item.id === pinned)!;
assert.equal(pinnedItem.track, bottomTrack, 'an explicit track is honoured');
assert.equal(pinnedItem.name, 'look');

console.log('adjustment.verify: ok');
