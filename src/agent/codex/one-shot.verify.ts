import assert from 'node:assert/strict';
import { runCodexOneShot } from './one-shot.ts';

const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const submitted: Record<string, unknown>[] = [];

function stubTurn(events: readonly Record<string, unknown>[]): void {
  globalThis.fetch = (async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (path !== '/api/codex/turn') throw new Error(`Unexpected fetch: ${path}`);
    submitted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }) as typeof fetch;
}

const request = {
  label: 'text generation',
  system: 'You write component code.',
  prompt: 'A title card.',
  projectId: 'unsaved-project',
  maxOutputTokens: 2_000,
};

try {
  stubTurn([
    { type: 'text-delta', delta: 'const Title' },
    { type: 'text-delta', delta: ' = () => null;\n' },
    { type: 'done' },
  ]);
  assert.equal(await runCodexOneShot(request), 'const Title = () => null;');
  // The turn carries no tools and cannot mutate: a text generation is not a
  // conversation with the editor.
  const sent = submitted.at(-1)!;
  assert.deepEqual(sent.tools, []);
  assert.equal(sent.askOnly, true);
  assert.equal(sent.projectId, 'unsaved-project');

  // A stream that ends without the terminal event produced a truncated answer,
  // not a finished one.
  stubTurn([{ type: 'text-delta', delta: 'partial' }]);
  await assert.rejects(
    runCodexOneShot(request),
    /Codex text generation ended before completion/,
    'the label names which call failed',
  );

  // The output ceiling is enforced against the accumulated text.
  stubTurn([{ type: 'text-delta', delta: 'x'.repeat(80) }, { type: 'done' }]);
  await assert.rejects(
    runCodexOneShot({ ...request, maxOutputTokens: 4 }),
    /Codex text generation exceeded its output limit/,
  );

  stubTurn([{ type: 'error', message: 'app-server is unavailable' }]);
  await assert.rejects(runCodexOneShot(request), /app-server is unavailable/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('one-shot.verify: toolless Codex text generation, labelled failures, output ceiling');
