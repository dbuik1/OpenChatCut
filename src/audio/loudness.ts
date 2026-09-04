// Loudness normalization analysis core. The naming style is the same as isolate_voice(verb_noun).
//
// Split into two halves: pure functions that run under node, and the clip
// measurement, which asks the server's ffmpeg loudnorm route rather than
// decoding media in the renderer.
import type { TimelineItem } from '../editor/types';
import { sourceWindowForTimelineRange } from '../editor/sourceLimit';

// ── Pure function (node-testable) ────────────────────────────────────────────

// A simplified BS.1770: integrated loudness approximated from 400ms block mean
// square energy plus the absolute silence gate. It omits K-weighting pre-filtering
// and relative thresholding, so for steady material (speech, music) it lands within
// a few LUFS and material with long silences plus sudden peaks deviates further.
// The clip path measures through ffmpeg's loudnorm, which implements the full
// process; this stays as the sample-level measurement usable without a server.
export function integratedLoudnessFromSamples(samples: Float32Array, sampleRate: number): number {
  if (samples.length === 0 || sampleRate <= 0) return -70; // Empty/illegal input → Silence lower limit, do not return NaN
  const blockSize = Math.max(1, Math.round(sampleRate * 0.4)); // BS.1770 gating block = 400ms
  const blockMeanSquares: number[] = [];
  for (let start = 0; start < samples.length; start += blockSize) {
    const end = Math.min(start + blockSize, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    blockMeanSquares.push(sum / (end - start));
  }
  // Mean square threshold corresponding to BS.1770 absolute threshold (blocks below -70 LUFS are considered silent and not included in the average)
  const ABSOLUTE_GATE_MS = 10 ** ((-70 + 0.691) / 10);
  const gated = blockMeanSquares.filter((ms) => ms > ABSOLUTE_GATE_MS);
  const kept = gated.length > 0 ? gated : blockMeanSquares; // When fully silent, it degenerates to use all blocks to avoid empty arrays.
  const meanSquare = kept.reduce((a, b) => a + b, 0) / kept.length;
  const EPS = 1e-10; // Anti-log10(0) = -Infinity
  return -0.691 + 10 * Math.log10(Math.max(meanSquare, EPS));
}

const MIN_GAIN = 0.05;
const MAX_GAIN = 8;

/** The linear gain multiple required to achieve the target loudness, sandwiched between [MIN_GAIN, MAX_GAIN] to prevent blasting/silencing. */
export function gainForTarget(currentLufs: number, targetLufs: number): number {
  if (!Number.isFinite(currentLufs) || !Number.isFinite(targetLufs)) return 1; // Illegal input → Keep gain unchanged and prevent NaN from spreading
  const gain = 10 ** ((targetLufs - currentLufs) / 20);
  if (!Number.isFinite(gain)) return MAX_GAIN;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain));
}

// ── Browser only (fetch + WebAudio decoding) ─────────────────────────────────

/** Loudness of one clip's trimmed range, plus the range that was measured. */
export interface ClipLoudness {
  integratedLufs: number;
  truePeakDb: number;
  loudnessRange: number;
  startSeconds: number;
  durationSeconds: number;
}

export interface ClipLoudnessRange {
  src: string;
  startSeconds: number;
  durationSeconds: number;
}

/**
 * A measurement that could not be made, carrying whether the cause was the
 * clip rather than the measurement.
 *
 * A silent clip and a broken measurement both leave the volume untouched, but
 * only one of them is worth retrying, and only one means the selection was
 * wrong. Collapsing them into one message tells a user whose b-roll has no
 * audio track that loudness measurement is failing.
 */
export class ClipLoudnessError extends Error {
  readonly noAudio: boolean;

  constructor(message: string, noAudio: boolean) {
    super(message);
    this.name = 'ClipLoudnessError';
    this.noAudio = noAudio;
  }
}

export function isNoAudioLoudnessError(error: unknown): boolean {
  return error instanceof ClipLoudnessError && error.noAudio;
}

/**
 * The source-media window a clip actually plays, in seconds.
 *
 * Measuring the whole file gives a short excerpt of a long recording the whole
 * recording's loudness, so the gain lands on the wrong clip. Voice isolation
 * replaces the audio that plays, so its output is what gets measured when it
 * is present.
 */
export function clipLoudnessRange(
  item: Pick<TimelineItem, 'src' | 'denoisedSrc' | 'srcInFrame' | 'playbackRate' | 'durationInFrames'>,
  fps: number,
): ClipLoudnessRange | null {
  const src = item.denoisedSrc || item.src;
  if (!src || fps <= 0) return null;
  const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  return {
    src,
    startSeconds: window.startFrame / fps,
    durationSeconds: Math.max(0, window.endFrame - window.startFrame) / fps,
  };
}

/**
 * Measure a clip's trimmed range through the server's ffmpeg loudnorm route.
 *
 * The measurement is deliberately not done here. Decoding in the renderer meant
 * pulling the whole container into an AudioBuffer, which is why loudness work
 * used to be restricted to standalone audio clips — a video clip would have
 * decoded gigabytes in the tab. ffmpeg streams the decode, so a video clip's
 * audio costs the same as an audio clip's, and it runs the full BS.1770 gating
 * rather than the approximation in integratedLoudnessFromSamples.
 */
export async function measureClipLoudness(range: ClipLoudnessRange): Promise<ClipLoudness> {
  const res = await fetch('/api/measure-loudness', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(range),
  });
  const body = (await res.json().catch(() => null)) as
    | (Partial<ClipLoudness> & { ok?: boolean; error?: string; noAudio?: boolean })
    | null;
  if (!res.ok || !body?.ok || typeof body.integratedLufs !== 'number') {
    throw new ClipLoudnessError(
      body?.error ?? `loudness measurement failed (HTTP ${res.status})`,
      body?.noAudio === true,
    );
  }
  return {
    integratedLufs: body.integratedLufs,
    truePeakDb: body.truePeakDb ?? 0,
    loudnessRange: body.loudnessRange ?? 0,
    startSeconds: range.startSeconds,
    durationSeconds: range.durationSeconds,
  };
}
