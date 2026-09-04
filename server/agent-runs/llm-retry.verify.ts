import assert from 'node:assert/strict';
import { APICallError } from 'ai';
import {
  classifyLlmFailure,
  hasSideEffectsPerformed,
  isRetryableLlmFailure,
  markSideEffectsPerformed,
  MAX_LLM_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  resolveRetryDelayMs,
} from './llm-retry.ts';
import { CodexProcessError, CodexRpcError, CodexTimeoutError } from '../codex/app-server.ts';

function apiError(statusCode: number, body = '', headers?: Record<string, string>): APICallError {
  return new APICallError({
    message: 'call failed',
    url: 'https://example.invalid/v1/chat',
    requestBodyValues: {},
    statusCode,
    responseBody: body,
    responseHeaders: headers,
    isRetryable: false,
  });
}

// Deterministic failures are never retried.
assert.equal(classifyLlmFailure(apiError(401)).code, 'AUTH');
assert.equal(classifyLlmFailure(apiError(403)).code, 'AUTH');
assert.equal(classifyLlmFailure(apiError(400)).code, 'INVALID_REQUEST');
assert.equal(classifyLlmFailure(apiError(422, '')).code, 'INVALID_REQUEST');
assert.equal(classifyLlmFailure(apiError(402, '')).code, 'QUOTA');
assert.equal(classifyLlmFailure(apiError(200, '{"error":"insufficient_quota"}')).code, 'QUOTA');
assert.equal(classifyLlmFailure(new Error('boom')).code, 'UNKNOWN');

// Context overflow is detected from the response body, not retried.
assert.equal(
  classifyLlmFailure(apiError(400, 'This model\'s maximum context length is 65536 tokens.')).code,
  'CONTEXT_WINDOW_EXCEEDED',
);

// Transient failures are retryable.
assert.equal(classifyLlmFailure(apiError(500)).code, 'SERVER');
assert.equal(classifyLlmFailure(apiError(502)).code, 'SERVER');
assert.equal(classifyLlmFailure(apiError(429, '', { 'retry-after': '3' })).code, 'RATE_LIMIT');
assert.equal(
  classifyLlmFailure(apiError(429, '', { 'retry-after': '3' })).retryAfterMs,
  3000,
);
assert.equal(classifyLlmFailure(new TypeError('fetch failed')).code, 'TRANSPORT');
// AI SDK chunk/step timers abort with a TimeoutError DOMException — transient, retryable.
assert.equal(
  classifyLlmFailure(new DOMException('Chunk timeout of 120000ms exceeded', 'TimeoutError')).code,
  'TIMEOUT',
);
assert.equal(
  classifyLlmFailure(new DOMException('The operation was aborted.', 'AbortError')).code,
  'TIMEOUT',
);
assert.equal(classifyLlmFailure(new (class extends Error {})('x')).code, 'UNKNOWN');
// Retryable set matches the classification above.
for (const code of ['RATE_LIMIT', 'TIMEOUT', 'SERVER', 'TRANSPORT', 'EMPTY_RESPONSE']) {
  assert.equal(isRetryableLlmFailure(code as never), true, code);
}
for (const code of ['AUTH', 'INVALID_REQUEST', 'QUOTA', 'CONTEXT_WINDOW_EXCEEDED', 'UNKNOWN']) {
  assert.equal(isRetryableLlmFailure(code as never), false, code);
}

// Rate-limit retries honor Retry-After within the max cap.
const rateLimited = { code: 'RATE_LIMIT' as const, message: '', retryAfterMs: 3000 };
assert.equal(resolveRetryDelayMs(rateLimited, 0), 3000);
assert.equal(
  resolveRetryDelayMs({ code: 'RATE_LIMIT', message: '', retryAfterMs: 60_000 }, 0),
  MAX_RETRY_DELAY_MS,
);

// Transient backoff grows exponentially and stays within bounds.
for (let attempt = 0; attempt < MAX_LLM_ATTEMPTS; attempt += 1) {
  const delay = resolveRetryDelayMs({ code: 'SERVER', message: '' }, attempt);
  assert.ok(delay >= 0 && delay <= MAX_RETRY_DELAY_MS, `attempt ${attempt}: ${delay}`);
}

// ── Codex backend failures ──────────────────────────────────────────────────
// The Codex path never raises APICallError; it throws its own error types over
// JSON-RPC. Before these were classified every Codex failure fell through to
// UNKNOWN and the retry budget wrapping the turn was never spent.
assert.equal(classifyLlmFailure(new CodexTimeoutError('turn/start')).code, 'TIMEOUT');
assert.equal(classifyLlmFailure(new CodexProcessError()).code, 'TRANSPORT');
assert.equal(classifyLlmFailure(new CodexRpcError('turn/start', -32603)).code, 'SERVER');
// A malformed call repeats identically, so it is not worth another attempt.
assert.equal(classifyLlmFailure(new CodexRpcError('turn/start', -32600)).code, 'INVALID_REQUEST');
assert.equal(classifyLlmFailure(new CodexRpcError('turn/start', -32602)).code, 'INVALID_REQUEST');
assert.equal(classifyLlmFailure(new CodexRpcError('turn/start', null)).code, 'SERVER');
// The turn path also throws plain Errors carrying only a message.
assert.equal(classifyLlmFailure(new Error('Codex turn timed out after 600s.')).code, 'TIMEOUT');
assert.equal(
  classifyLlmFailure(new Error('Codex app-server stopped unexpectedly.')).code,
  'TRANSPORT',
);
assert.equal(
  classifyLlmFailure(new Error('Codex turn ended without a terminal event.')).code,
  'TRANSPORT',
);
// An unrelated message still classifies as UNKNOWN rather than being retried.
assert.equal(classifyLlmFailure(new Error('something else entirely')).code, 'UNKNOWN');

// ── Side-effect gate ────────────────────────────────────────────────────────
// Tool calls reach the editor while the turn streams, so a failure raised after
// one has run must not be replayed even when its cause is retryable.
const replayable = new CodexTimeoutError('turn/start');
assert.equal(hasSideEffectsPerformed(replayable), false);
assert.equal(isRetryableLlmFailure(classifyLlmFailure(replayable).code), true);
markSideEffectsPerformed(replayable);
assert.equal(hasSideEffectsPerformed(replayable), true);
// The marker does not change the classification, only whether it is replayed.
assert.equal(classifyLlmFailure(replayable).code, 'TIMEOUT');
// It survives being thrown and caught, and is not enumerable.
assert.equal(Object.keys(replayable).includes('sideEffects'), false);
assert.deepEqual(
  Object.getOwnPropertyNames(replayable).filter((key) => key.includes('side')),
  [],
);
assert.equal(hasSideEffectsPerformed(null), false);
assert.equal(hasSideEffectsPerformed('a string'), false);
assert.equal(hasSideEffectsPerformed(undefined), false);

console.log('server llm-retry classification checks passed, Codex failures and side-effect gate included');
