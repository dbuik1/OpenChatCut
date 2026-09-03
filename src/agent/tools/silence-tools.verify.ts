import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { TimelineItem } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { vadSilenceRemovalEnabled } from '../../audio/vad';
import { execSilenceTool } from './silence-tools';

const clip: TimelineItem = {
  id: 'clip_silence',
  kind: 'video',
  track: 'V1',
  startFrame: 0,
  durationInFrames: 300,
  name: 'talk',
  src: '/media/uploads/talk.mp4',
};

const draft = makeDraft(docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  assets: [{
    id: 'asset_s',
    name: 'talk.mp4',
    kind: 'video',
    src: '/media/uploads/talk.mp4',
    durationInFrames: 300,
  }],
  items: [clip],
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video' } },
}));

const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

// The build flag is off under the verify runner, so this exercises the same
// path a packaged build without VAD takes.
assert.equal(vadSilenceRemovalEnabled(undefined), false);

const before = draft.getState().items.map((item) => ({ ...item }));
const result = await execSilenceTool('remove_silence', {}, ctx) as Record<string, unknown>;

// A refusal, not a success: reporting ok with an empty edit list told the model
// the timeline had been tightened when nothing had been touched.
assert.ok(typeof result.error === 'string', 'disabled remove_silence must return an error');
assert.equal(result.ok, undefined);
assert.equal(result.edited, undefined);
assert.match(String(result.error), /clean_script/, 'the refusal must name the tool that does work');
assert.deepEqual(draft.getState().items, before, 'a refusal must not change the timeline');

const unknown = await execSilenceTool('not_a_tool', {}, ctx) as Record<string, unknown>;
assert.match(String(unknown.error), /unknown tool/);

console.log('silence-tools.verify ok');
