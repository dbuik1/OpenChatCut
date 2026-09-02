// clean_script's filler set was fixed in code, so a speaker whose tics are
// "like" or "basically" had no mechanical path at all. These cases pin the
// optional extraFillers list: the built-ins stay unconditional, supplied
// tokens are additive, and they normalise on exactly the same terms as the
// built-ins — a caller must not have to guess how ASR punctuated a word.
// npx tsx src/agent/tools/clean-script-extra-fillers.verify.ts
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import assert from 'node:assert/strict';
import type { AgentContext } from '../context.ts';
import { historyReduce, type AtomicAction, type History } from '../../editor/reduce.ts';
import type { EditorCommands } from '../../editor/store.ts';
import { activeEditorState, activeTimeline, type ProjectDoc } from '../../editor/types.ts';
import {
  fillerIndices,
  isFiller,
  MAX_EXTRA_FILLERS,
  parseExtraFillers,
} from '../../transcript/edit.ts';
import { execTranscriptTool, TRANSCRIPT_TOOL_SCHEMAS } from './transcript-tools.ts';

const words = [
  { text: 'um', start: 0, end: 100 },
  { text: 'Like,', start: 200, end: 400 },
  { text: 'hello', start: 500, end: 700 },
  { text: 'basically', start: 800, end: 1000 },
  { text: 'world', start: 2000, end: 2200 },
];

// ── The built-in set is the default and is never replaced ──────────────────
assert.deepEqual(fillerIndices(words), [0], 'no extras supplied: only the built-in filler goes');
assert.ok(isFiller('Um...'), 'built-ins still match through punctuation');
assert.ok(!isFiller('like'), 'like is not a built-in filler');

const extra = new Set(parseExtraFillers(['like', 'basically']));
assert.deepEqual(fillerIndices(words, extra), [0, 1, 3], 'extras are additive, not a replacement');
assert.ok(isFiller('um', extra), 'the built-in set stays active when extras are supplied');

// ── Extras normalise exactly like the built-ins ────────────────────────────
// "Like," in the transcript must match the token "like" for the same reason
// "Um..." matches "um": one normalisation, applied to both sides.
assert.ok(isFiller('Like,', new Set(parseExtraFillers(['LIKE!']))), 'case and punctuation are normalised on both sides');
assert.deepEqual(parseExtraFillers(['  Basically.  ']), ['basically'], 'surrounding whitespace and punctuation are stripped');
assert.deepEqual(parseExtraFillers(['嗯嗯']), ['嗯嗯'], 'Chinese tokens survive normalisation');

// ── Duplicates and empties are ignored, not errors ─────────────────────────
assert.deepEqual(parseExtraFillers(['like', 'Like', 'like,']), ['like'], 'duplicates collapse after normalisation');
assert.deepEqual(parseExtraFillers(['', '   ', '...', 'like']), ['like'], 'tokens that normalise to nothing are dropped');
assert.deepEqual(parseExtraFillers(undefined), [], 'omitting the list is not an error');
assert.deepEqual(parseExtraFillers(null), [], 'a null list is not an error');

// ── Rejections a caller must hear about ────────────────────────────────────
assert.throws(
  () => parseExtraFillers(['you know']),
  /multi-word phrases: "you know"/,
  'a phrase is named in the error rather than silently ignored',
);
assert.throws(() => parseExtraFillers(Array.from({ length: MAX_EXTRA_FILLERS + 1 }, (_, i) => `w${i}`)), /at most 200 tokens/);
assert.doesNotThrow(() => parseExtraFillers(Array.from({ length: MAX_EXTRA_FILLERS }, (_, i) => `w${i}`)), 'the cap itself is allowed');
assert.throws(() => parseExtraFillers([42]), /must contain strings/);
assert.throws(() => parseExtraFillers('like'), /must be an array/);

// ── The tool surface ───────────────────────────────────────────────────────
const schema = TRANSCRIPT_TOOL_SCHEMAS.find((tool) => tool.name === 'clean_script')!;
const properties = schema.input_schema.properties as Record<string, { maxItems?: number; description?: string }>;
assert.ok(properties.extraFillers, 'clean_script advertises extraFillers');
assert.equal(properties.extraFillers.maxItems, MAX_EXTRA_FILLERS, 'the schema cap matches the enforced cap');
assert.match(String(properties.extraFillers.description), /Multi-word phrases/, 'the schema states the phrase limitation');

const initial: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'timeline_main',
  timelines: [{
    id: 'timeline_main', name: 'Main', order: 0, fps: 30, width: 1920, height: 1080,
    trackOrder: ['audio_main'], tracks: { audio_main: { kind: 'audio' } }, selectedId: null,
    items: [
      { id: 'clip_one', track: 'audio_main', startFrame: 0, durationInFrames: 90, kind: 'audio', name: 'One', src: '/one.wav', transcript: words },
    ],
  }],
};

let history: History = { past: [], present: structuredClone(initial), future: [] };
const commands = {
  batch: (actions: AtomicAction[], label?: string) => {
    history = historyReduce(history, { type: 'batch', actions, label });
  },
} as EditorCommands;
const ctx = {
  commands,
  getState: () => activeEditorState(history.present),
  getDoc: () => history.present,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
} satisfies AgentContext;

const defaults = await execTranscriptTool('clean_script', { track: 'A1' }, ctx) as Record<string, unknown>;
assert.equal(defaults.ok, true);
assert.equal(defaults.extraFillers, null, 'no extras supplied is reported as none');
assert.deepEqual(activeTimeline(history.present).items[0]?.deletedWordIdx, [0], 'built-ins strip with no extras supplied');

history = historyReduce(history, { type: 'undo' });
assert.deepEqual(history.present, initial, 'undo restores the clip before the next case');

const withExtras = await execTranscriptTool('clean_script', {
  track: 'A1',
  extraFillers: ['Like', 'basically', 'like'],
}, ctx) as Record<string, unknown>;
assert.equal(withExtras.ok, true);
assert.deepEqual(withExtras.extraFillers, ['like', 'basically'], 'the normalised, deduplicated list comes back');
assert.equal(withExtras.fillersRemoved, 3);
assert.deepEqual(
  activeTimeline(history.present).items[0]?.deletedWordIdx,
  [0, 1, 3],
  'extras strip additively through the reducer, built-in included',
);
assert.equal(history.past.length, 1, 'the whole clean is still one undo step');

history = historyReduce(history, { type: 'undo' });

// only:'fillers' takes the deleteWords branch, where the executor's own index
// list is what reaches the store — a separate path from the cleanScript action.
const typedOnly = await execTranscriptTool('clean_script', {
  track: 'A1',
  only: 'fillers',
  extraFillers: ['basically'],
}, ctx) as Record<string, unknown>;
assert.equal(typedOnly.ok, true);
assert.deepEqual(
  activeTimeline(history.present).items[0]?.deletedWordIdx,
  [0, 3],
  'only:fillers strips the built-in and the extra through the deleteWords path',
);

const rejected = await execTranscriptTool('clean_script', {
  track: 'A1',
  extraFillers: ['you know'],
}, ctx) as Record<string, unknown>;
assert.match(String(rejected.error), /multi-word phrases: "you know"/, 'the tool reports the phrase instead of ignoring it');
assert.equal(history.past.length, 1, 'a rejected call changes nothing');

const oversized = await execTranscriptTool('clean_script', {
  track: 'A1',
  extraFillers: Array.from({ length: MAX_EXTRA_FILLERS + 1 }, (_, i) => `w${i}`),
}, ctx) as Record<string, unknown>;
assert.match(String(oversized.error), /at most 200 tokens/);
assert.equal(history.past.length, 1, 'an oversized list changes nothing');

console.log('clean-script extra filler checks passed');
