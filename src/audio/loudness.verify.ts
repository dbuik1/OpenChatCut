// 只测纯函数(DOM-free);measureClipLoudness 依赖 fetch,node 环境下不可达,
// 不在此处调用——但它抛出的错误类型是纯的,可以在这里断言。
import assert from 'node:assert';
import {
  ClipLoudnessError,
  clipLoudnessRange,
  gainForTarget,
  integratedLoudnessFromSamples,
  isNoAudioLoudnessError,
} from './loudness';

const SAMPLE_RATE = 48000;

function sine(seconds: number, amplitude: number): Float32Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  const freq = 1000; // 1kHz 测试音,周期整除采样率,块边界无相位误差
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  return out;
}

// 满幅 1kHz 正弦波:均方=0.5,理论 LUFS = -0.691 + 10*log10(0.5) ≈ -3.70(0dB 附近,
// 非满 0——满幅正弦的均方本就比峰值功率低约 3dB)。
const fullScale = integratedLoudnessFromSamples(sine(1, 1), SAMPLE_RATE);
assert.ok(fullScale > -6 && fullScale < 0, `full-scale sine should read near 0 dB-ish, got ${fullScale}`);

// 振幅 ×0.1(低 20dB)→ 均方 ×0.01 → 应比满幅低约 20 LUFS
const quieter = integratedLoudnessFromSamples(sine(1, 0.1), SAMPLE_RATE);
const delta = fullScale - quieter;
assert.ok(Math.abs(delta - 20) < 0.5, `20dB quieter signal should measure ~20 LUFS lower, got delta=${delta}`);

// 静音 buffer 不该是 NaN/Infinity(guard log10(0))
const silent = integratedLoudnessFromSamples(new Float32Array(SAMPLE_RATE), SAMPLE_RATE);
assert.ok(Number.isFinite(silent), `silent buffer must not be NaN/Infinity, got ${silent}`);

// 空数组同样要防炸
const empty = integratedLoudnessFromSamples(new Float32Array(0), SAMPLE_RATE);
assert.ok(Number.isFinite(empty), `empty buffer must not be NaN/Infinity, got ${empty}`);

// gainForTarget: -24 → -14 需要 +10dB,线性增益 = 10^(10/20) ≈ 3.1623
const gain = gainForTarget(-24, -14);
assert.ok(Math.abs(gain - 3.1623) < 0.01, `gain should be ~3.1623, got ${gain}`);

// 极端值必须夹在合理范围内,不会算出会爆音或几乎静音的增益
assert.ok(gainForTarget(-60, 0) <= 8, 'gain must clamp to the max');
assert.ok(gainForTarget(0, -60) >= 0.05, 'gain must clamp to the min');

// 非法输入(NaN/Infinity)不能让增益跟着炸
assert.ok(Number.isFinite(gainForTarget(NaN, -14)), 'gain must stay finite for NaN current');
assert.ok(Number.isFinite(gainForTarget(-14, Infinity)), 'gain must stay finite for Infinite target');

// ── A silent clip is not a failed measurement ────────────────────────────────
// Both leave the volume untouched, so without the distinction a user whose
// b-roll carries no audio track is told that loudness measurement is failing.
assert.equal(isNoAudioLoudnessError(new ClipLoudnessError('source has no audio track: x.mp4', true)), true);
assert.equal(isNoAudioLoudnessError(new ClipLoudnessError('ffmpeg exited 1', false)), false);
assert.equal(isNoAudioLoudnessError(new Error('source has no audio track')), false,
  'the flag is carried by the error type, never sniffed out of a message');

// ── The measured window is the clip's trimmed range, not the whole file ──────
// Measuring the whole recording gives a short excerpt the whole recording's
// loudness, so the corrective gain lands on the wrong material.
const trimmed = clipLoudnessRange(
  { src: '/media/uploads/a.mp4', srcInFrame: 300, playbackRate: 1, durationInFrames: 150 },
  30,
);
assert.ok(trimmed, 'a clip with a source has a measurable range');
assert.equal(trimmed.startSeconds, 10, 'srcInFrame 300 @30fps starts the window at 10s');
assert.equal(trimmed.durationSeconds, 5, '150 frames @30fps is a 5s window');

// Voice isolation replaces the audio that plays, so it is what gets measured.
const denoised = clipLoudnessRange(
  { src: '/media/uploads/a.mp4', denoisedSrc: '/media/uploads/a.denoised.wav', srcInFrame: 0, playbackRate: 1, durationInFrames: 30 },
  30,
);
assert.equal(denoised?.src, '/media/uploads/a.denoised.wav');

assert.equal(clipLoudnessRange({ src: '', srcInFrame: 0, playbackRate: 1, durationInFrames: 30 }, 30), null);
assert.equal(clipLoudnessRange({ src: '/media/uploads/a.mp4', srcInFrame: 0, playbackRate: 1, durationInFrames: 30 }, 0), null);

console.log('loudness.check: ok');
