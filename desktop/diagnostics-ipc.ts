import { ipcMain, shell } from 'electron';
import {
  DESKTOP_DIAGNOSTICS_CHANNELS,
  clampDiagnosticsReport,
  isDesktopDiagnosticsReport,
} from '../shared/desktop-diagnostics.ts';
import { assertTrustedDesktopSenderUrl } from './page-origin.ts';
import type { DiagnosticsLog } from './diagnostics-log.ts';

export function installDiagnosticsIpc(trustedOrigin: string, log: DiagnosticsLog): void {
  ipcMain.handle(DESKTOP_DIAGNOSTICS_CHANNELS.report, (event, report: unknown) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    if (!isDesktopDiagnosticsReport(report)) throw new Error('invalid diagnostics report');
    const safe = clampDiagnosticsReport(report);
    const where = safe.url ? ` @ ${safe.url}` : '';
    log.write('error', `renderer:${safe.kind}`, `${safe.message}${where}${safe.stack ? `\n${safe.stack}` : ''}`);
  });
  ipcMain.handle(DESKTOP_DIAGNOSTICS_CHANNELS.logPath, (event) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    return log.path;
  });
  ipcMain.handle(DESKTOP_DIAGNOSTICS_CHANNELS.openLogFolder, async (event) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    // Touch the file first so the folder exists even before the first failure.
    log.write('info', 'diagnostics', 'log folder opened from settings');
    const failure = await shell.openPath(log.dir);
    if (failure) throw new Error(failure);
  });
}
