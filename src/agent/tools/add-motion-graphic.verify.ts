// Runnable: `node scripts/run-check.mjs src/agent/tools/add-motion-graphic.verify.ts`
// (plain tsx chokes on the .frag?raw chain that execEditItemTool now pulls in
// via edit-item-validate.ts / edit-item-shared.ts -> gl/fx/effects.ts.)
import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import { TEMPLATES } from '../../editor/initial';
import type { AgentContext } from '../context';
import { execCoreTool } from './core-tools';
import type { MediaAsset } from '../../editor/types';

const templates = TEMPLATES.slice(0, 20);
const tplA = templates[0];
const tplB = templates[1];

function freshCtx(assets: MediaAsset[] = []) {
  const draft = makeDraft(docFromTimeline({
    fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets,
  }));
  const ctx: AgentContext = {
    commands: draft.commands,
    getState: draft.getState,
    getDoc: draft.getDoc,
    getCreativeMode: () => null,
    templates,
    audio: [],
  };
  return { draft, ctx };
}

async function addMg(templateName: string, ctx: AgentContext, extra: Record<string, unknown> = {}) {
  return execCoreTool('add_motion_graphic', { templateName, ...extra }, ctx, []);
}

// ── 1. exact UUID id resolves ───────────────────────────────────────────────
{
  const { draft, ctx } = freshCtx();
  const result = await addMg(tplA.id, ctx) as { ok?: boolean; templateId?: string; added?: string };
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.templateId, tplA.id);
  assert.equal(result.added, tplA.name);
  const item = draft.getState().items.find((i) => i.name === tplA.name);
  assert.ok(item, 'template placed on the timeline');
}

// ── 2. library:motion-graphic:<id> prefix resolves ──────────────────────────
{
  const { ctx } = freshCtx();
  const result = await addMg(`library:motion-graphic:${tplB.id}`, ctx) as { ok?: boolean; templateId?: string };
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.templateId, tplB.id);
}

// ── 3. an id prefix of >= 8 chars resolves ──────────────────────────────────
{
  const { ctx } = freshCtx();
  const prefix = tplA.id.slice(0, 8);
  assert.ok(prefix.length >= 8);
  const result = await addMg(prefix, ctx) as { ok?: boolean; templateId?: string };
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.templateId, tplA.id);
}

// ── 4. a name substring still resolves (existing behaviour) ────────────────
{
  const { ctx } = freshCtx();
  const substring = tplA.name.slice(0, Math.max(4, Math.floor(tplA.name.length / 2))).toLowerCase();
  const result = await addMg(substring, ctx) as { ok?: boolean; templateId?: string };
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.templateId, tplA.id);
}

// ── 5. unknown name → error + nearest (<= 8, closest by token) + hint, never `available` ──
{
  const { ctx } = freshCtx();
  const result = await addMg('zzz_totally_unmatched_zzz', ctx) as {
    error?: string; nearest?: string[]; hint?: string; available?: unknown;
  };
  assert.ok(result.error, 'expected an error');
  assert.ok(Array.isArray(result.nearest), 'nearest must be an array');
  assert.ok(result.nearest!.length <= 8, 'nearest is capped at 8');
  assert.ok(result.hint && result.hint.includes('edit_item'), 'hint must mention edit_item');
  assert.equal(result.available, undefined, 'no `available` field on a miss');
}
{
  // "nearest" actually contains the closest match by shared token, not just any 8 names.
  const { ctx } = freshCtx();
  const [firstToken] = tplA.name.toLowerCase().split(/[\s_-]+/).filter((t) => t.length > 1);
  assert.ok(firstToken, 'template name must have a matchable token');
  const result = await addMg(`${firstToken}-but-not-a-real-template-xyz`, ctx) as { error?: string; nearest?: string[] };
  assert.ok(result.error);
  assert.ok(result.nearest!.includes(tplA.name), `expected ${tplA.name} among nearest matches, got ${JSON.stringify(result.nearest)}`);
}

// ── 6. a UUID that is a media-pool asset with kind 'motion-graphic' places via edit_item, no error ──
{
  const poolAsset: MediaAsset = {
    id: crypto.randomUUID(),
    name: 'Generated MG',
    kind: 'motion-graphic',
    src: '',
    code: 'const X = ({item}) => <AbsoluteFill/>;',
    durationInFrames: 30,
    width: 1920,
    height: 1080,
    props: {},
  };
  const { draft, ctx } = freshCtx([poolAsset]);
  const result = await addMg(poolAsset.id, ctx) as {
    error?: string; ok?: boolean;
    results?: Array<{ ok?: boolean; error?: string; placed?: { itemId?: string; assetId?: string } }>;
  };
  assert.equal(result.error, undefined, `expected no error, got ${JSON.stringify(result)}`);
  assert.equal(result.ok, true, `expected ok:true, got ${JSON.stringify(result)}`);
  const op = result.results?.[0];
  assert.equal(op?.error, undefined, `expected no per-op error, got ${JSON.stringify(op)}`);
  assert.equal(op?.placed?.assetId, poolAsset.id);
  const item = draft.getDoc().timelines[0].items.find((i) => i.id === op?.placed?.itemId);
  assert.ok(item, 'media-pool motion graphic placed on the timeline via edit_item');
  assert.equal(item!.kind, 'motion-graphic');
}

console.log('add-motion-graphic.verify: ok — id/prefix/library-prefix/name resolution, unknown-name nearest+hint, and media-pool asset placement all pass');
