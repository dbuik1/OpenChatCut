import assert from 'node:assert/strict';
import { parseLoudnormJson, uploadNameFromSrc } from './measure-loudness.ts';

// Only files inside the uploads directory are measurable, and the name is the
// one the media directory would accept — the route hands this straight to the
// filesystem, so traversal must not survive decoding or a query string.
assert.equal(uploadNameFromSrc('/media/uploads/clip.mp4'), 'clip.mp4');
assert.equal(uploadNameFromSrc('/media/uploads/clip.mp4?v=2'), 'clip.mp4');
assert.equal(uploadNameFromSrc('/media/uploads/%2e%2e%2fsecret'), null);
assert.equal(uploadNameFromSrc('/media/uploads/sub/clip.mp4'), null);
assert.equal(uploadNameFromSrc('/etc/passwd'), null);
assert.equal(uploadNameFromSrc(''), null);

// The real shape: ffmpeg's own log first, then the loudnorm summary last.
const realStderr = [
  'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'/media/uploads/clip.mp4\':',
  '  Duration: 00:12:03.41, start: 0.000000, bitrate: 8123 kb/s',
  '[Parsed_loudnorm_0 @ 0x55f] ',
  '{',
  '\t"input_i" : "-23.41",',
  '\t"input_tp" : "-1.20",',
  '\t"input_lra" : "7.30",',
  '\t"input_thresh" : "-33.60",',
  '\t"output_i" : "-14.00",',
  '\t"normalization_type" : "dynamic"',
  '}',
].join('\n');
const measured = parseLoudnormJson(realStderr);
assert.deepEqual(measured, {
  integratedLufs: -23.41,
  truePeakDb: -1.2,
  loudnessRange: 7.3,
  thresholdLufs: -33.6,
});

// A silent range is a real measurement, not a failure: loudnorm prints -inf,
// which has to become the BS.1770 silence floor so the caller can still act.
const silent = parseLoudnormJson('{\n"input_i" : "-inf",\n"input_tp" : "-inf",\n"input_lra" : "0.00",\n"input_thresh" : "-inf"\n}');
assert.equal(silent?.integratedLufs, -70);
assert.equal(silent?.truePeakDb, -70);
assert.equal(silent?.loudnessRange, 0);

// Anything that is not a loudnorm summary is a null measurement, so the route
// reports the ffmpeg failure rather than normalizing to an invented number.
assert.equal(parseLoudnormJson(''), null);
assert.equal(parseLoudnormJson('ffmpeg: no such file or directory'), null);
assert.equal(parseLoudnormJson('{ not json'), null);
assert.equal(parseLoudnormJson('{"output_i" : "-14.00"}'), null);

console.log('measure-loudness.verify: upload names are constrained and loudnorm output parses, silence included');
