import assert from 'node:assert/strict';
import { equalPowerGain } from './transitionAudio';

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

console.log('transitionAudio.verify: crossfade holds constant power across the ramp');
