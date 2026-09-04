import type { SlipFailure } from '../../editor/slip';
import type { NeighbourTrimFailure, NeighbourTrimPlan } from '../../editor/rollSlide';

export type OpResult = Record<string, unknown>;

export function slipFailureToOpResult(failure: SlipFailure): OpResult {
  return {
    ok: false,
    code: failure.code,
    itemId: failure.itemId,
    error: failure.error,
  };
}

export function neighbourTrimFailureToOpResult(failure: NeighbourTrimFailure): OpResult {
  return {
    ok: false,
    code: failure.code,
    itemId: failure.itemId,
    error: failure.error,
  };
}

/** The agent-facing shape of a roll/slide plan: what moved, by how much, and where the limits are. */
export function neighbourTrimPlanToOpResult(plan: NeighbourTrimPlan): OpResult {
  return {
    ok: true,
    itemId: plan.itemId,
    requestedDeltaInFrames: plan.requestedDeltaInFrames,
    appliedDeltaInFrames: plan.appliedDeltaInFrames,
    minDeltaInFrames: plan.minDeltaInFrames,
    maxDeltaInFrames: plan.maxDeltaInFrames,
    clamped: plan.clamped,
    affected: plan.patches.map((patch) => ({
      itemId: patch.id,
      startFrame: patch.startFrame,
      durationInFrames: patch.durationInFrames,
      srcInFrame: patch.srcInFrame,
    })),
  };
}
