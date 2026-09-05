import assert from 'node:assert/strict';
import type { MediaAsset, TimelineState } from '../../editor/types';
import {
  AUTHORED_ADD_KINDS,
  GENERIC_ADD_KINDS,
  validateAuthoredAdd,
  validateGenericAdd,
} from './edit-item-generic';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';

assert.ok(AUTHORED_ADD_KINDS.has('text') && AUTHORED_ADD_KINDS.has('solid') && AUTHORED_ADD_KINDS.has('adjustment'));
assert.ok(!GENERIC_ADD_KINDS.has('text') && !GENERIC_ADD_KINDS.has('solid'));

const state = {
  items: [],
  fps: 30,
  trackOrder: ['V2', 'V1', 'A1'],
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, A1: { kind: 'audio' } },
  width: 1920,
  height: 1080,
  selectedId: null,
} as unknown as TimelineState;

const textPlan = validateAuthoredAdd(state, {
  type: 'text',
  text: '你好世界',
  color: '#ffcc00',
  fontSize: 72,
  align: 'center',
  track: 'V2',
  fromFrame: 30,
  durationInFrames: 120,
});
assert.equal(textPlan.error, undefined, String(textPlan.error));
assert.equal(textPlan.plan, 'addText');
assert.equal(textPlan.text, '你好世界');
assert.equal(textPlan.startFrame, 30);
assert.equal(textPlan.durationInFrames, 120);

const solidPlan = validateAuthoredAdd(state, { type: 'solid', color: '#101010', name: '黑底' });
assert.equal(solidPlan.plan, 'addSolid');
assert.equal(solidPlan.color, '#101010');

assert.ok(validateAuthoredAdd(state, { type: 'text', assetId: 'x', text: 'a' }).error);

// An adjustment layer is authored with timing only; the track is chosen at commit.
const adjustmentPlan = validateAuthoredAdd(state, { type: 'adjustment', fromFrame: 30, durationInFrames: 90, name: 'look' });
assert.equal(adjustmentPlan.error, undefined, String(adjustmentPlan.error));
assert.equal(adjustmentPlan.plan, 'addAdjustment');
assert.equal(adjustmentPlan.track, undefined, 'no track until commit picks a clear one');
assert.equal(adjustmentPlan.startFrame, 30);
assert.equal(adjustmentPlan.durationInFrames, 90);
assert.equal(validateAuthoredAdd(state, { type: 'adjustment', track: 'V1' }).track, 'V1');
assert.ok(validateAuthoredAdd(state, { type: 'adjustment', track: 'V9' }).error, 'unknown explicit track rejects');
assert.ok(validateAuthoredAdd(state, { type: 'adjustment', color: '#fff' }).error, 'text/solid fields reject');
assert.ok(validateAuthoredAdd(state, { type: 'adjustment', assetId: 'x' }).error);
assert.equal(validateGenericAdd(state, [] as MediaAsset[], { type: 'text', text: 'via generic' }).plan, 'addText');

// Commit via editor commands (same surface agent commit uses).
const base = docFromTimeline({
  fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [],
  trackOrder: ['V2', 'V1', 'A1'],
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, A1: { kind: 'audio' } },
});
const draft = makeDraft(base);
const itemId = draft.commands.addTextClip({
  track: String(textPlan.track),
  startFrame: Number(textPlan.startFrame),
  durationInFrames: Number(textPlan.durationInFrames),
  text: String(textPlan.text),
  color: String(textPlan.color),
  fontSize: Number(textPlan.fontSize),
  align: 'center',
});
const item = draft.getState().items.find((entry) => entry.id === itemId);
assert.equal(item?.kind, 'text');
assert.equal(item?.props?.text, '你好世界');
assert.equal(item?.props?.color, '#ffcc00');
assert.equal(item?.startFrame, 30);

const solidId = draft.commands.addSolidItem({
  color: String(solidPlan.color),
  name: String(solidPlan.name),
});
assert.equal(draft.getState().items.find((entry) => entry.id === solidId)?.kind, 'solid');

const adjustmentId = draft.commands.addAdjustmentItem({
  startFrame: Number(adjustmentPlan.startFrame),
  durationInFrames: Number(adjustmentPlan.durationInFrames),
  name: String(adjustmentPlan.name),
});
const adjustment = draft.getState().items.find((entry) => entry.id === adjustmentId);
assert.equal(adjustment?.kind, 'adjustment');
assert.equal(adjustment?.name, 'look');
assert.equal(adjustment?.durationInFrames, 90);

console.log('edit-item-authored.verify: ok');
