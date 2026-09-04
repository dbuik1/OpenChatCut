import assert from 'node:assert/strict';
import { createRendererErrorReporter } from './rendererErrorReporting';
import { describeRendererError } from './describeRendererError';

assert.deepEqual(describeRendererError('text'), { message: 'text' });
assert.equal(describeRendererError(new RangeError('r')).message, 'RangeError: r');
assert.equal(describeRendererError({ a: 1 }).message, '{"a":1}');

// Repeats of the same failure inside the window are dropped; a different
// message, or the same one after the window, goes through.
let clock = 0;
const sent: string[] = [];
const report = createRendererErrorReporter({ report: (r) => sent.push(r.message) }, () => clock);
assert.equal(report({ kind: 'error', message: 'a' }), true);
assert.equal(report({ kind: 'error', message: 'a' }), false);
assert.equal(report({ kind: 'unhandledrejection', message: 'a' }), true, 'kind is part of the identity');
assert.equal(report({ kind: 'error', message: 'b' }), true);
clock = 6_000;
assert.equal(report({ kind: 'error', message: 'a' }), true);
assert.deepEqual(sent, ['a', 'a', 'b', 'a']);

console.log('rendererErrorReporting.verify: ok');
