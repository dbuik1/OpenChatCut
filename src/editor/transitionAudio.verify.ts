import assert from 'node:assert/strict';
import { anchorDuckRanges, duckEnvelopeAt, duckGainFor, equalPowerGain } from './transitionAudio';

// The property that matters: across the whole ramp the two sides of a crossfade
// sum to constant power. A linear ramp fails this at the midpoint, where both
// sides sit at 0.5 amplitude and the pair carries half the power of either clip
// alone — the -3 dB dip.
for (let step = 0; step <= 100; step += 1) {
  const position = step / 100;
  const incoming = equalPowerGain(position);
  const outgoing = equalPowerGain(1 - position);
  const power = incoming ** 2 + outgoing ** 2;
  assert.ok(
    Math.abs(power - 1) < 1e-9,
    `crossfade power must stay flat, got ${power.toFixed(6)} at ${position}`,
  );
}

// The midpoint is where a linear ramp is most wrong: it reaches 0.5 there, an
// equal-power ramp reaches 1/sqrt(2).
assert.ok(Math.abs(equalPowerGain(0.5) - Math.SQRT1_2) < 1e-12);

// The endpoints still hand the clip its full level and full silence, so a
// transition neither ducks the body of a clip nor leaves a tail audible.
assert.equal(equalPowerGain(0), 0);
assert.equal(equalPowerGain(1), 1);

// Positions outside the ramp are clamped rather than producing NaN from a
// square root of a negative number.
assert.equal(equalPowerGain(-0.5), 0);
assert.equal(equalPowerGain(2), 1);

// ── Ducking envelope ────────────────────────────────────────────────────────

const FPS = 30;
// Attack is 0.08s, release 0.4s at this frame rate.
const ATTACK = Math.round(FPS * 0.08);
const RELEASE = Math.round(FPS * 0.4);
const anchor: readonly (readonly [number, number])[] = [[100, 200]];

// Full depth for the whole anchor, and the attack has finished by the frame the
// anchor starts — a ramp that is still climbing there ducks the first syllable late.
assert.equal(duckEnvelopeAt(100, anchor, FPS), 1);
assert.equal(duckEnvelopeAt(150, anchor, FPS), 1);
assert.equal(duckEnvelopeAt(199, anchor, FPS), 1);

// Silence outside the ramps, so a follower plays at its own level between anchors.
assert.equal(duckEnvelopeAt(100 - ATTACK, anchor, FPS), 0);
assert.equal(duckEnvelopeAt(0, anchor, FPS), 0);
assert.equal(duckEnvelopeAt(200 + RELEASE, anchor, FPS), 0);
assert.equal(duckEnvelopeAt(1000, anchor, FPS), 0);

// Both ramps are monotonic and strictly between the endpoints, which is the
// whole difference from the step this replaced.
for (let frame = 100 - ATTACK + 1; frame < 100; frame += 1) {
  const here = duckEnvelopeAt(frame, anchor, FPS);
  assert.ok(here > 0 && here < 1, `attack must ramp, got ${here} at ${frame}`);
  assert.ok(here > duckEnvelopeAt(frame - 1, anchor, FPS), `attack must rise at ${frame}`);
}
for (let frame = 201; frame < 200 + RELEASE; frame += 1) {
  const here = duckEnvelopeAt(frame, anchor, FPS);
  assert.ok(here > 0 && here < 1, `release must ramp, got ${here} at ${frame}`);
  assert.ok(here < duckEnvelopeAt(frame - 1, anchor, FPS), `release must fall at ${frame}`);
}

// Anchors closer together than the release length must not let the follower
// swell back up between them: the envelope takes the strongest of the ranges.
const closePair: readonly (readonly [number, number])[] = [[100, 200], [205, 300]];
for (let frame = 200; frame < 205; frame += 1) {
  assert.ok(duckEnvelopeAt(frame, closePair, FPS) > 0.5, `gap must stay ducked at ${frame}`);
}

// No anchors, or an unusable frame rate, means no ducking rather than NaN.
assert.equal(duckEnvelopeAt(150, [], FPS), 0);
assert.equal(duckEnvelopeAt(150, anchor, 0), 0);

// Depth is applied in dB and only at full envelope; a closed envelope is unity gain.
assert.equal(duckGainFor(-12, 0), 1);
assert.ok(Math.abs(duckGainFor(-12, 1) - 10 ** (-12 / 20)) < 1e-12);
assert.ok(Math.abs(duckGainFor(-12, 0.5) - 10 ** (-6 / 20)) < 1e-12);

// ── Anchor ranges follow speech, not clip extent ────────────────────────────

const clip = { kind: 'video', startFrame: 100, durationInFrames: 300, srcInFrame: 0 } as const;
const word = (start: number, end: number, text: string) => ({ text, start, end });
const wholeClip = [[100, 400]];

// A clip whose word timings are unavailable ducks its whole extent: an anchor
// with no transcript is not an anchor that never speaks, and not ducking it at
// all is a worse failure than ducking it through its pauses.
assert.deepEqual(anchorDuckRanges({ ...clip }, FPS), wholeClip);
assert.deepEqual(anchorDuckRanges({ ...clip, transcriptStale: true, transcript: [word(0, 500, 'a')] }, FPS), wholeClip);
assert.deepEqual(anchorDuckRanges({ ...clip, transcript: [word(0, 500, 'a')] }, 0), wholeClip);

// A pause the bed can climb out of becomes a gap between ranges, so a talking
// head that is 40% silence no longer buries the music for its whole length.
const withPause = anchorDuckRanges(
  { ...clip, transcript: [word(0, 500, 'a'), word(500, 1000, 'b'), word(5000, 5500, 'c')] },
  FPS,
);
assert.deepEqual(withPause, [[100, 130], [250, 265]]);
assert.equal(duckEnvelopeAt(190, withPause, FPS), 0, 'the bed comes back up mid-pause');

// A gap shorter than attack + release is not a gap: the envelope could not
// recover through it, and splitting there would only pump. Merging also keeps
// the range count proportional to real pauses rather than to word count, which
// matters because this list is walked once per audio frame.
assert.deepEqual(
  anchorDuckRanges({ ...clip, transcript: [word(0, 500, 'a'), word(800, 1300, 'b')] }, FPS),
  [[100, 139]],
);

// Deleted words are not spoken, so the bed is untouched where they were.
assert.deepEqual(
  anchorDuckRanges(
    { ...clip, transcript: [word(0, 500, 'a'), word(500, 1000, 'b'), word(5000, 5500, 'c')], deletedWordIdx: [2] },
    FPS,
  ),
  [[100, 130]],
);

console.log('transitionAudio.verify: crossfade holds constant power, ducking ramps in and out');
