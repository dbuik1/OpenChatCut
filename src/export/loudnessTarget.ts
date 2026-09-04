/**
 * Integrated-loudness targets an export can be normalised to. Shared by the
 * dialog and the server's request validation so both agree on the range.
 */
export interface ExportLoudnessTarget {
  lufs: number;
  /** Chinese label; the English dictionary carries the translation. */
  label: string;
}

export const EXPORT_LOUDNESS_TARGETS: readonly ExportLoudnessTarget[] = [
  { lufs: -14, label: '流媒体' },
  { lufs: -16, label: '播客' },
  { lufs: -23, label: '广播' },
];

export const MIN_EXPORT_LUFS = -30;
export const MAX_EXPORT_LUFS = -8;

export function isValidExportLoudnessTarget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_EXPORT_LUFS && value <= MAX_EXPORT_LUFS;
}
