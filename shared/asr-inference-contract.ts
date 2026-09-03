export const ASR_INFERENCE_CONTRACT = {
  id: 'whisper-q8-16khz-word-v1',
  sampleRate: 16_000,
  // No duration ceiling: long-form recordings — multi-hour VODs, lectures,
  // podcasts — are the intended input, and whisper already transcribes them by
  // sliding a fixed window, so length alone costs nothing. What genuinely
  // constrains a run is memory, because the whole 16 kHz mono PCM has to exist
  // at once (a Float32Array in the browser worker, a WAV on disk on desktop).
  // The limit is therefore expressed in bytes of decoded PCM, and callers
  // report the shortfall in hours so a user can act on it.
  maxPcmBytes: 1024 * 1024 * 1024,
  chunkSeconds: 30,
  strideSeconds: 5,
  dtype: 'q8',
  // transformers.js v4 per-module dtypes for the WebGPU path. Measured on
  // M5: encoder fp16 on WebGPU yields empty transcripts (silent failure);
  // encoder fp32 + decoder fp16 produces full, correct text at ~1.4-1.7x the
  // wasm q8 speed. int8/q8 models are not supported on the WebGPU EP at all.
  webgpuDtype: { encoder_model: 'fp32', decoder_model_merged: 'fp16' },
} as const;

/** Longest PCM the memory budget admits, in 16 kHz mono samples. */
export const ASR_MAX_AUDIO_SAMPLES =
  ASR_INFERENCE_CONTRACT.maxPcmBytes / Float32Array.BYTES_PER_ELEMENT;

/** The same budget as a duration, for bounds checks and user-facing messages. */
export const ASR_MAX_AUDIO_SECONDS =
  ASR_MAX_AUDIO_SAMPLES / ASR_INFERENCE_CONTRACT.sampleRate;

/** Render a sample count as hours and minutes, for messages a user has to act on. */
export function formatAsrDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total - hours * 3600) / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
