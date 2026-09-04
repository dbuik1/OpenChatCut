// Runnable check: `npx tsx src/agent/tools/edit-item-roll-slide.verify.ts`.
import assert from 'node:assert/strict';
import { planRoll, planSlide } from '../../editor/rollSlide';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { applyGeneric, type GenericCommands, validateSlipUpdate } from './edit-item-generic';

const clip = (id: string, startFrame: number, srcInFrame: number): TimelineItem => ({
  id,
  track: 'video-main',
  startFrame,
  durationInFrames: 60,
  name: id,
  kind: 'video',
  src: '/media/uploads/agent.mp4',
  srcInFrame,
});

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [clip('A', 0, 30), clip('B', 60, 100), clip('C', 120, 20)],
  assets: [{ id: 'asset-agent-a', name: 'Agent source', kind: 'video', src: '/media/uploads/agent.mp4', durationInFrames: 300 }],
  selectedId: 'B',
  trackOrder: ['video-main'],
  tracks: { 'video-main': { kind: 'video' } },
};

function recorder(onCommit: (method: string, args: unknown[]) => unknown): GenericCommands {
  return new Proxy({}, {
    get: (_target, property) => (...args: unknown[]) => onCommit(String(property), args),
  }) as GenericCommands;
}

{
  const plan = validateSlipUpdate(state, { operation: 'roll', itemId: 'B', edge: 'end', deltaInFrames: 100 });
  assert.equal(plan.ok, true);
  assert.equal(plan.plan, 'roll');
  assert.equal(plan.status, 'clamped', 'the incoming clip must keep one frame, so 100 clamps to 59');
  assert.equal(plan.appliedDeltaInFrames, 59);

  const commits: Array<[string, unknown[]]> = [];
  const result = applyGeneric(plan, recorder((method, args) => {
    commits.push([method, args]);
    return planRoll(state, args[0] as string, args[1] as 'start' | 'end', args[2] as number);
  }));
  assert.deepEqual(commits, [['rollEdit', ['B', 'end', 59]]], 'the commit replays the validated delta as one roll action');
  assert.equal(result?.ok, true);
  assert.equal(result?.status, 'clamped');
  assert.deepEqual(
    (result?.affected as Array<{ itemId: string }>).map((entry) => entry.itemId).sort(),
    ['B', 'C'],
    'the result names every clip the roll rewrote',
  );
}

{
  const plan = validateSlipUpdate(state, { operation: 'slide', itemId: 'B', deltaInFrames: -10 });
  assert.equal(plan.ok, true);
  assert.equal(plan.plan, 'slide');
  assert.equal(plan.status, 'planned');
  const commits: Array<[string, unknown[]]> = [];
  const result = applyGeneric(plan, recorder((method, args) => {
    commits.push([method, args]);
    return planSlide(state, args[0] as string, args[1] as number);
  }));
  assert.deepEqual(commits, [['slideItem', ['B', -10]]]);
  assert.equal(result?.ok, true);
  assert.deepEqual(
    (result?.affected as Array<{ itemId: string }>).map((entry) => entry.itemId).sort(),
    ['A', 'B', 'C'],
  );
}

{
  const missingEdge = validateSlipUpdate(state, { operation: 'roll', itemId: 'B', deltaInFrames: 5 });
  assert.deepEqual({ ok: missingEdge.ok, code: missingEdge.code }, { ok: false, code: 'invalid-edge' });
  const badEdge = validateSlipUpdate(state, { operation: 'roll', itemId: 'B', edge: 'middle', deltaInFrames: 5 });
  assert.deepEqual({ ok: badEdge.ok, code: badEdge.code }, { ok: false, code: 'invalid-edge' });
  const slideWithEdge = validateSlipUpdate(state, { operation: 'slide', itemId: 'B', edge: 'end', deltaInFrames: 5 });
  assert.equal(slideWithEdge.ok, false, 'slide has no edge; passing one is rejected rather than ignored');
  const gap = validateSlipUpdate(state, { operation: 'roll', itemId: 'C', edge: 'end', deltaInFrames: 5 });
  assert.deepEqual({ ok: gap.ok, code: gap.code }, { ok: false, code: 'no-neighbour' });
  const unknownField = validateSlipUpdate(state, { operation: 'slide', itemId: 'B', deltaInFrames: 5, ripple: true });
  assert.equal(unknownField.code, 'unknown-field');
  assert.ok(typeof unknownField.error === 'string' && unknownField.error.includes('ripple'), 'the rejection names the stray field');
}

console.log('edit-item-roll-slide.verify: roll/slide validation, clamping, affected clips, edge rules and one commit action ok');
