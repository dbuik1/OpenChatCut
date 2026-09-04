import type { DesktopDiagnosticsReport } from '../../shared/desktop-diagnostics';
import { describeRendererError } from './describeRendererError';

/** Identical failures fired in a tight loop (a broken effect re-running on
 *  every frame) would otherwise write thousands of lines; one per message
 *  inside this window is enough evidence. */
const REPEAT_WINDOW_MS = 5_000;

export interface RendererErrorSink {
  report(report: DesktopDiagnosticsReport): void;
}

export function createRendererErrorReporter(sink: RendererErrorSink, now: () => number = Date.now) {
  const recent = new Map<string, number>();
  return (report: DesktopDiagnosticsReport): boolean => {
    const key = `${report.kind}\n${report.message}`;
    const at = now();
    const last = recent.get(key);
    if (last !== undefined && at - last < REPEAT_WINDOW_MS) return false;
    recent.set(key, at);
    if (recent.size > 200) {
      for (const [entry, seen] of recent) if (at - seen >= REPEAT_WINDOW_MS) recent.delete(entry);
    }
    sink.report(report);
    return true;
  };
}

function desktopSink(): RendererErrorSink | null {
  const api = typeof window !== 'undefined' ? window.openChatCutDesktop?.diagnostics : undefined;
  return api ? { report: (report) => api.report(report) } : null;
}

let installed: ((report: DesktopDiagnosticsReport) => boolean) | null = null;

/** Route window-level failures to the desktop log. In a plain browser there is
 *  no log file, so the handlers are not installed and DevTools stays the
 *  only record, as before. */
export function installRendererErrorReporting(): void {
  if (installed) return;
  const sink = desktopSink();
  if (!sink) return;
  const report = createRendererErrorReporter(sink);
  installed = report;
  window.addEventListener('error', (event) => {
    const described = describeRendererError(event.error ?? event.message);
    report({ kind: 'error', ...described, url: `${window.location.pathname}${window.location.search}` });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const described = describeRendererError(event.reason);
    report({ kind: 'unhandledrejection', ...described, url: `${window.location.pathname}${window.location.search}` });
  });
}

/** Report a React render failure caught by the boundary. Safe before install: a browser build simply drops it. */
export function reportRenderError(error: unknown, componentStack: string | null | undefined): void {
  const described = describeRendererError(error);
  installed?.({
    kind: 'render-error',
    message: described.message,
    stack: [described.stack, componentStack ? `component stack:${componentStack}` : ''].filter(Boolean).join('\n') || undefined,
  });
}
