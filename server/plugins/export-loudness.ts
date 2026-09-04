// Two-pass EBU R128 normalisation of a finished export: measure with loudnorm,
// then re-encode the audio with the measured values so the correction is a
// single linear gain rather than a limiter chasing the signal. Video is copied
// untouched, so the pass costs one audio decode and encode.
import { measureFileLoudness } from './measure-loudness.ts';
import { runFfmpeg } from './export-runtime.ts';

/** True-peak ceiling: streaming platforms reject exports that peak above -1 dBTP. */
const TRUE_PEAK_DBTP = -1;
const LOUDNESS_RANGE_LU = 11;
const OUTPUT_SAMPLE_RATE = 48_000;

export type ExportLoudnessOutcome =
  | { applied: true; measuredLufs: number; targetLufs: number }
  | { applied: false; reason: 'no-audio' };

/** Container-appropriate audio encoders; loudnorm cannot stream-copy. */
export function loudnessAudioCodecArgs(ext: string): string[] {
  switch (ext) {
    case 'mp4': return ['-c:a', 'aac', '-b:a', '192k'];
    case 'webm': return ['-c:a', 'libopus', '-b:a', '160k'];
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', '192k'];
    default: return ['-c:a', 'pcm_s16le'];
  }
}

export function loudnormFilter(
  targetLufs: number,
  measured: { integratedLufs: number; truePeakDb: number; loudnessRange: number; thresholdLufs: number },
): string {
  return [
    `loudnorm=I=${targetLufs}`,
    `TP=${TRUE_PEAK_DBTP}`,
    `LRA=${LOUDNESS_RANGE_LU}`,
    `measured_I=${measured.integratedLufs}`,
    `measured_TP=${measured.truePeakDb}`,
    `measured_LRA=${measured.loudnessRange}`,
    `measured_thresh=${measured.thresholdLufs}`,
    'linear=true',
    'print_format=summary',
  ].join(':');
}

export async function normalizeExportLoudness(
  input: string,
  output: string,
  targetLufs: number,
  ext: string,
  signal?: AbortSignal,
): Promise<ExportLoudnessOutcome> {
  const measured = await measureFileLoudness(input);
  if (measured.noAudio) return { applied: false, reason: 'no-audio' };
  if (!measured.measurement) {
    throw new Error(`loudness measurement failed before normalisation: ${measured.stderr.slice(-400)}`);
  }
  await runFfmpeg([
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-map', '0',
    '-c:v', 'copy', '-c:s', 'copy',
    '-af', loudnormFilter(targetLufs, measured.measurement),
    '-ar', String(OUTPUT_SAMPLE_RATE),
    ...loudnessAudioCodecArgs(ext),
    output,
  ], signal);
  return { applied: true, measuredLufs: measured.measurement.integratedLufs, targetLufs };
}
