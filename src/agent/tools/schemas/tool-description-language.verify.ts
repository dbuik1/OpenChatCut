// The published tool catalogue is the whole of what a model is told about each
// tool. A description written in Chinese is unreadable to an English-only model
// driving the app through the tool catalogue, and there is no second channel it
// can fall back on — so every description and every input_schema description
// must be English. This asserts that, over both the in-memory schemas and the
// generated assets/agent/openchatcut-tool-schemas.json.
// npx tsx src/agent/tools/schemas/tool-description-language.verify.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASK_MODE_TOOL_SCHEMAS } from '../../ask-mode-tools';
import { TOOL_SCHEMAS } from '../../tools';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

type Hit = { tool: string; path: string; text: string };

function scan(label: string, tool: { name?: unknown; description?: unknown; input_schema?: unknown }): Hit[] {
  const name = typeof tool.name === 'string' ? tool.name : '(unnamed)';
  const hits: Hit[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (CJK.test(node)) hits.push({ tool: `${label}:${name}`, path, text: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
    }
  };
  walk(tool.description, 'description');
  walk(tool.input_schema, 'input_schema');
  return hits;
}

const sourceHits = [
  ...TOOL_SCHEMAS.flatMap((tool) => scan('edit', tool)),
  ...ASK_MODE_TOOL_SCHEMAS.flatMap((tool) => scan('ask', tool)),
];
assert.deepEqual(
  sourceHits.map((hit) => `${hit.tool} ${hit.path}`),
  [],
  `tool schemas carry CJK text a non-Chinese model cannot read:\n${
    sourceHits.map((hit) => `  ${hit.tool} ${hit.path}: ${hit.text}`).join('\n')}`,
);

const catalogUrl = new URL('../../../../assets/agent/openchatcut-tool-schemas.json', import.meta.url);
const catalog = JSON.parse(readFileSync(catalogUrl, 'utf8')) as Record<string, unknown>;
const catalogHits = (['edit', 'ask'] as const).flatMap((mode) => {
  const tools = catalog[mode];
  assert.ok(Array.isArray(tools) && tools.length > 0, `catalogue has no ${mode} tools`);
  return tools.flatMap((tool) => scan(mode, tool as Record<string, unknown>));
});
assert.deepEqual(
  catalogHits.map((hit) => `${hit.tool} ${hit.path}`),
  [],
  `the published tool catalogue carries CJK text:\n${
    catalogHits.map((hit) => `  ${hit.tool} ${hit.path}: ${hit.text}`).join('\n')}`,
);

// A scanner that matches nothing would pass this file for ever.
assert.ok(CJK.test('字幕'), 'the CJK detector must match Chinese text');
assert.ok(!CJK.test('Captions — "bottom-center", 1080×1920'), 'the CJK detector must not match English punctuation');

console.log(
  `tool-description-language.verify: ${TOOL_SCHEMAS.length} edit + ${ASK_MODE_TOOL_SCHEMAS.length} ask schemas and the published catalogue are English-only`,
);
