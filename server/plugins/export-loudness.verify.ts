// Export loudness target: request validation and the two-pass loudnorm filter.
// Run with: npx tsx server/plugins/export-loudness.verify.ts
import assert from 'node:assert/strict';
import { planExport } from './export-plan.ts';
import { loudnessAudioCodecArgs, loudnormFilter } from './export-loudness.ts';
import { EXPORT_LOUDNESS_TARGETS, isValidExportLoudnessTarget } from '../../src/export/loudnessTarget.ts';

const state = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [{ id: 'a', track: 'V1', startFrame: 0, durationInFrames: 60, name: 'a', kind: 'video' as const, src: '/media/uploads/a.mp4' }],
};

// The plan carries the target for video and audio alike, and only inside the shared range.
assert.equal(planExport({ state }).targetLufs, undefined);
assert.equal(planExport({ state, targetLufs: -14 }).targetLufs, -14);
assert.equal(planExport({ state, format: 'audio', codec: 'wav', targetLufs: -23 }).targetLufs, -23);
assert.throws(() => planExport({ state, targetLufs: -5 }), /targetLufs must be a number between -30 and -8/);
assert.throws(() => planExport({ state, targetLufs: Number.NaN }), /targetLufs/);
for (const target of EXPORT_LOUDNESS_TARGETS) assert.ok(isValidExportLoudnessTarget(target.lufs), `${target.lufs} is a valid preset`);
assert.equal(isValidExportLoudnessTarget('-14'), false);

// Pass two is linear, pinned to the measured values, with the streaming true-peak ceiling.
const filter = loudnormFilter(-14, { integratedLufs: -20.5, truePeakDb: -3.2, loudnessRange: 7.1, thresholdLufs: -31 });
assert.equal(filter, 'loudnorm=I=-14:TP=-1:LRA=11:measured_I=-20.5:measured_TP=-3.2:measured_LRA=7.1:measured_thresh=-31:linear=true:print_format=summary');

// loudnorm cannot stream-copy audio, so each container gets its native encoder.
assert.deepEqual(loudnessAudioCodecArgs('mp4'), ['-c:a', 'aac', '-b:a', '192k']);
assert.deepEqual(loudnessAudioCodecArgs('mp3'), ['-c:a', 'libmp3lame', '-b:a', '192k']);
assert.deepEqual(loudnessAudioCodecArgs('mov'), ['-c:a', 'pcm_s16le']);
assert.deepEqual(loudnessAudioCodecArgs('wav'), ['-c:a', 'pcm_s16le']);

console.log('export-loudness.verify: target validated on the plan, loudnorm pass two is linear and container-aware');
