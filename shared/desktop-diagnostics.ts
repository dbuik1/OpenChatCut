export const DESKTOP_DIAGNOSTICS_CHANNELS = {
  report: 'openchatcut:diagnostics-report',
  openLogFolder: 'openchatcut:diagnostics-open-log-folder',
  logPath: 'openchatcut:diagnostics-log-path',
} as const;

export type DesktopDiagnosticsReportKind = 'error' | 'unhandledrejection' | 'render-error';

/** One renderer-side failure, forwarded to the main process so it lands in
 *  the same log file as main-process and embedded-server failures. */
export interface DesktopDiagnosticsReport {
  readonly kind: DesktopDiagnosticsReportKind;
  readonly message: string;
  readonly stack?: string;
  readonly url?: string;
}

const REPORT_KINDS = new Set<DesktopDiagnosticsReportKind>(['error', 'unhandledrejection', 'render-error']);
/** A report is written verbatim into a size-rotated file; a runaway message must not eat a whole rotation. */
export const DIAGNOSTICS_REPORT_MAX_CHARS = 8_000;

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isDesktopDiagnosticsReport(value: unknown): value is DesktopDiagnosticsReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  return REPORT_KINDS.has(report.kind as DesktopDiagnosticsReportKind)
    && typeof report.message === 'string'
    && optionalString(report.stack)
    && optionalString(report.url);
}

/** Clamp every text field so a malicious or runaway renderer cannot flood the log. */
export function clampDiagnosticsReport(report: DesktopDiagnosticsReport): DesktopDiagnosticsReport {
  const clamp = (text: string | undefined): string | undefined => (
    text === undefined ? undefined : text.slice(0, DIAGNOSTICS_REPORT_MAX_CHARS)
  );
  return {
    kind: report.kind,
    message: clamp(report.message) ?? '',
    ...(report.stack !== undefined ? { stack: clamp(report.stack) } : {}),
    ...(report.url !== undefined ? { url: clamp(report.url) } : {}),
  };
}
