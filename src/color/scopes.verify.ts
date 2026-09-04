// Runnable check: `npx tsx src/color/scopes.verify.ts`.
// Verification: Oscilloscope statistics on synthetic RGBA patterns - grayscale (neutral/no dominant color), pure orange (main hue/warm bias),
// Overexposure (highlight overflow), teal-orange double cluster, segmented color cast with bluish shadows, and empty input.
import assert from 'node:assert/strict';
import { compareColorScopes } from '../agent/tools/color-scope-tools';
import { analyzeRgbaPixels, analyzeScopeFields, describeScopeStats } from './scopes';

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) < eps;

/** Construct RGBA buffer: give [r,g,b](0..255) row by row, n pixels per color block. */
function rgba(blocks: Array<[r: number, g: number, b: number, n: number]>): Uint8Array {
  const total = blocks.reduce((a, [, , , n]) => a + n, 0);
  const out = new Uint8Array(total * 4);
  let at = 0;
  for (const [r, g, b, n] of blocks) {
    for (let i = 0; i < n; i++) {
      out[at] = r; out[at + 1] = g; out[at + 2] = b; out[at + 3] = 255;
      at += 4;
    }
  }
  return out;
}

// ── Grayscale gradient: black and white dots, no saturation, no main color, color shift ≈ 0 ──
{
  const blocks: Array<[number, number, number, number]> = [];
  for (let v = 0; v <= 255; v += 5) blocks.push([v, v, v, 40]);
  const s = analyzeRgbaPixels(rgba(blocks), 1);
  assert.ok(s.blackPoint < 0.03 && s.whitePoint > 0.97, '灰阶黑白点贴边');
  assert.ok(s.saturationMean < 0.01, '灰阶无饱和');
  assert.deepEqual(s.dominantHues, [], '灰阶无主色相');
  assert.ok(near(s.warmCool, 0, 1e-6) && near(s.greenMagenta, 0, 1e-6), '灰阶零色偏');
  assert.ok(describeScopeStats(s).some((line) => line.includes('near-neutral')), '判读提示中性');
}

// ── Pure orange picture: main hue orange, warm, high saturation ──
{
  const s = analyzeRgbaPixels(rgba([[255, 128, 0, 5000]]), 1);
  assert.equal(s.dominantHues[0], 'orange', '主色相 orange');
  assert.ok(s.warmCool > 0.5, '暖冷平衡明显偏暖');
  assert.ok(s.saturationMean > 0.9, '高饱和');
  assert.ok(near(s.hueHistogram.find((b) => b.label === 'orange')!.pct, 1, 1e-6), '直方图集中在 orange bin');
}

// ── Overexposure: 35% pure white → highlight bloom ratio ≈ 0.35, white point = 1 ──
{
  const s = analyzeRgbaPixels(rgba([[255, 255, 255, 3500], [120, 120, 120, 6500]]), 1);
  assert.ok(near(s.clippedHighlightsPct, 0.35, 0.01), `高光溢出≈35%(${s.clippedHighlightsPct})`);
  assert.ok(s.whitePoint > 0.99, '白点贴顶');
  assert.ok(s.clippedShadowsPct < 0.01, '暗部无溢出');
}

// ── teal-orange: Both main color clusters are recognized ──
{
  const s = analyzeRgbaPixels(rgba([[230, 140, 40, 4000], [20, 160, 180, 4000], [128, 128, 128, 2000]]), 1);
  assert.ok(s.dominantHues.includes('orange') && (s.dominantHues.includes('cyan') || s.dominantHues.includes('azure')),
    `teal-orange 双簇(${s.dominantHues.join(',')})`);
}

// ── Segmented color cast: dark parts are bluer, bright parts are warmer, and the segmented tilts should be different from each other ──
{
  const s = analyzeRgbaPixels(rgba([[20, 25, 60, 4000], [235, 210, 170, 4000]]), 1);
  assert.ok(s.tilt.shadows.warmCool < -0.05, `暗部偏蓝(${s.tilt.shadows.warmCool})`);
  assert.ok(s.tilt.highlights.warmCool > 0.05, `亮部偏暖(${s.tilt.highlights.warmCool})`);
}

// ── Empty input will not explode ──
{
  const s = analyzeRgbaPixels(new Uint8Array(0));
  assert.equal(s.sampledPixels, 0);
  assert.deepEqual(s.dominantHues, []);
}

// ── Reference shot comparison: signed difference + named knob suggestion after dead zone ──
{
  const target = analyzeRgbaPixels(rgba([[230, 135, 40, 5000]]), 1);
  const reference = analyzeRgbaPixels(rgba([[100, 100, 100, 5000]]), 1);
  const compared = compareColorScopes(target, reference);
  assert.ok(compared.targetMinusReference.meanLuma > 0, '目标比参考更亮时差值为正');
  assert.ok(compared.targetMinusReference.warmCool > 0, '目标比参考更暖时差值为正');
  assert.deepEqual(
    compared.suggestions.map((entry) => [entry.control, entry.direction]),
    [['brightness', 'decrease'], ['saturate', 'decrease'], ['temperature', 'cooler']],
  );
  assert.deepEqual(compareColorScopes(reference, reference).suggestions, [], '死区内不生成无意义建议');
}


// ── Drawn scope fields: a horizontal grey ramp climbs column by column ──
{
  const width = 8;
  const height = 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const v = Math.round((255 * x) / (width - 1));
      pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v; pixels[i + 3] = 255;
    }
  }
  const f = analyzeScopeFields(pixels, width, height, { columns: 8, bins: 16, vectorSize: 16 });
  const litBin = (column: number): number =>
    [...f.luma.slice(column * f.bins, (column + 1) * f.bins)].findIndex((v) => v > 0);
  assert.equal(litBin(0), 0, 'black column sits on the floor of the trace');
  assert.equal(litBin(7), f.bins - 1, 'white column sits on the ceiling of the trace');
  for (let c = 1; c < 8; c += 1) {
    assert.ok(litBin(c) > litBin(c - 1), `column ${c} reads brighter than ${c - 1}`);
  }
  // A neutral ramp has no chroma, so every sample lands on the vectorscope centre.
  const centre = Math.round((f.vectorSize - 1) / 2);
  assert.equal(f.vector[centre * f.vectorSize + centre], 1, 'neutral pixels land at the vectorscope origin');
  const offCentre = [...f.vector].filter((v, i) => v > 0 && i !== centre * f.vectorSize + centre);
  assert.equal(offCentre.length, 0, 'a neutral frame paints nothing off the vectorscope origin');
}

// ── Parade separates channels, and the vectorscope places red above neutral ──
{
  const width = 2;
  const height = 1;
  const pixels = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]);
  const f = analyzeScopeFields(pixels, width, height, { columns: 2, bins: 8, vectorSize: 65 });
  const lit = (field: Float32Array): number => [...field.slice(0, f.bins)].findIndex((v) => v > 0);
  assert.equal(lit(f.red), f.bins - 1, 'red channel reads full');
  assert.equal(lit(f.green), 0, 'green channel reads zero');
  assert.equal(lit(f.blue), 0, 'blue channel reads zero');
  const centre = Math.round((f.vectorSize - 1) / 2);
  const hit = [...f.vector].findIndex((v) => v > 0);
  const hy = Math.floor(hit / f.vectorSize);
  const hx = hit % f.vectorSize;
  assert.ok(hy < centre, 'pure red sits above the vectorscope origin');
  assert.ok(hx < centre, 'pure red sits left of the vectorscope origin');
}

// ── Degenerate frames return empty fields rather than throwing ──
{
  const f = analyzeScopeFields(new Uint8Array(0), 0, 0);
  assert.ok(f.luma.every((v) => v === 0), 'an empty frame paints no trace');
  const short = analyzeScopeFields(new Uint8Array(4), 8, 8);
  assert.ok(short.vector.every((v) => v === 0), 'a truncated buffer paints no trace');
}

console.log('scopes.verify: ok (灰阶/主色相/溢出/双簇/分段色偏/参考对比/空输入/示波器场)');
