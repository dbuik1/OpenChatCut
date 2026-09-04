// Runnable check: `npx tsx src/export/markedRange.verify.ts`.
import assert from 'node:assert/strict';
import { markedRangeFromZone } from './markedRange';

assert.deepEqual(markedRangeFromZone({ inFrame: 12, outFrame: 48 }), { startFrame: 12, endFrameExclusive: 48 });
assert.equal(markedRangeFromZone(null), null, 'no marks is the whole timeline');
assert.equal(markedRangeFromZone(undefined), null, 'an unmounted timeline is the whole timeline');
assert.equal(markedRangeFromZone({ inFrame: 12, outFrame: null }), null, 'an in-point alone bounds nothing');
assert.equal(markedRangeFromZone({ inFrame: null, outFrame: 48 }), null, 'an out-point alone bounds nothing');
assert.equal(markedRangeFromZone({ inFrame: 48, outFrame: 48 }), null, 'a collapsed range bounds nothing');
assert.equal(markedRangeFromZone({ inFrame: 60, outFrame: 12 }), null, 'an inverted range bounds nothing');
assert.equal(markedRangeFromZone({ inFrame: -1, outFrame: 48 }), null, 'a negative in-point is not a bound');
assert.equal(markedRangeFromZone({ inFrame: 1.5, outFrame: 48 }), null, 'a fractional mark is not a frame');

console.log('markedRange.verify: ok (paired marks only, positive length, integral frames)');
