import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCube, type CubeLut } from './cube';

// ?raw is a bundler import; the verify runner reads the shader from disk instead.
const lutFrag = readFileSync('src/gl/fx/lut.frag', 'utf8');

// The LUT pass has no transfer function of its own: the GL runtime uploads media
// as raw bytes (UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE) into an RGBA8
// texture and writes back to an RGBA8 framebuffer, so the sampled value is
// still in the source file's own encoding — which is the domain a .cube LUT is
// authored against. Encoding on the way in and decoding on the way out moved
// the lookup to a luminance the footage never had. Both round-trip to a no-op
// at intensity 0 and through an identity LUT, which is why it went unnoticed.
for (const banned of ['linearToBt709', 'bt709ToLinear', 'pow(']) {
  assert.ok(
    !lutFrag.includes(banned),
    `lut.frag must not apply a transfer function (found ${banned})`,
  );
}

/** GL sampler3D with linear filtering and clamp-to-edge, in floating point. */
function sampleLut(lut: CubeLut, rgb: readonly [number, number, number]): [number, number, number] {
  const n = lut.size;
  const axis = rgb.map((value, channel) => {
    const lo = lut.domainMin[channel];
    const hi = lut.domainMax[channel];
    const normalized = (Math.min(hi, Math.max(lo, value)) - lo) / (hi - lo);
    const position = normalized * (n - 1);
    const index = Math.min(n - 2, Math.floor(position));
    return { index, frac: n === 1 ? 0 : position - index };
  });
  const at = (r: number, g: number, b: number): [number, number, number] => {
    // .cube storage is red-fastest.
    const offset = ((b * n + g) * n + r) * 3;
    return [lut.data[offset], lut.data[offset + 1], lut.data[offset + 2]];
  };
  const out: [number, number, number] = [0, 0, 0];
  for (let corner = 0; corner < 8; corner += 1) {
    const dr = corner & 1;
    const dg = (corner >> 1) & 1;
    const db = (corner >> 2) & 1;
    const weight = (dr ? axis[0].frac : 1 - axis[0].frac)
      * (dg ? axis[1].frac : 1 - axis[1].frac)
      * (db ? axis[2].frac : 1 - axis[2].frac);
    if (weight === 0) continue;
    const corners = at(axis[0].index + dr, axis[1].index + dg, axis[2].index + db);
    for (let channel = 0; channel < 3; channel += 1) out[channel] += corners[channel] * weight;
  }
  return out;
}

const bt709Oetf = (value: number): number =>
  (value < 0.018 ? value * 4.5 : 1.099 * value ** 0.45 - 0.099);

const sony = parseCube(readFileSync('assets/luts/Sony_Slog3_s709.cube', 'utf8'));

// S-Log3 places 18% scene grey at code 0.41. A Rec.709 conversion LUT has to
// bring it back to Rec.709 mid grey, which the Rec.709 OETF puts near 0.41 too.
const SLOG3_MID_GREY = 0.41;
const graded = sampleLut(sony, [SLOG3_MID_GREY, SLOG3_MID_GREY, SLOG3_MID_GREY]);
for (const channel of graded) {
  assert.ok(
    channel > 0.30 && channel < 0.55,
    `S-Log3 mid grey must land near Rec.709 mid grey, got ${channel.toFixed(3)}`,
  );
}

// The previous shader indexed the LUT at the BT.709 OETF of the sample and then
// ran the LUT's own Rec.709 output back through the inverse OETF. Reproduced
// here so the size of the error stays on the record rather than in a comment.
const bt709Eotf = (value: number): number =>
  (value < 0.081 ? value / 4.5 : ((value + 0.099) / 1.099) ** (1 / 0.45));
const encodedFirst = bt709Oetf(SLOG3_MID_GREY);
const previous = bt709Eotf(sampleLut(sony, [encodedFirst, encodedFirst, encodedFirst])[1]);
assert.ok(
  previous - graded[1] > 0.2,
  'the encode/decode wrap must be materially wrong, or this verify proves nothing',
);

console.log(
  `lut-domain.verify: S-Log3 mid grey ${SLOG3_MID_GREY} -> ${graded[1].toFixed(3)} `
  + `(the encode/decode wrap rendered it at ${previous.toFixed(3)})`,
);
