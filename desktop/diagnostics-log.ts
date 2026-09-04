import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Main-process, embedded-server and renderer failures all land in one
 *  append-only file under Electron's userData, rotated by size so a crash
 *  loop cannot fill the disk. Nothing leaves the machine: the file exists so a
 *  user can attach it to a bug report, not so anything can phone home. */

export const DIAGNOSTICS_LOG_FILE = 'openchatcut.log';
export const DIAGNOSTICS_LOG_ROTATE_BYTES = 2 * 1024 * 1024;
/** Current file plus this many rotated predecessors (`openchatcut.log.1` … `.N`). */
export const DIAGNOSTICS_LOG_KEEP = 3;
/** A single line is capped so one oversized payload cannot consume a whole rotation. */
export const DIAGNOSTICS_LINE_MAX_CHARS = 8_000;

export type DiagnosticsLevel = 'info' | 'warn' | 'error';

export interface DiagnosticsFs {
  appendFileSync(path: string, data: string): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): unknown;
  renameSync(from: string, to: string): void;
  statSync(path: string): { size: number };
  unlinkSync(path: string): void;
}

export interface DiagnosticsLogOptions {
  readonly dir: string;
  readonly fs?: DiagnosticsFs;
  readonly now?: () => Date;
  readonly rotateBytes?: number;
  readonly keep?: number;
}

const nodeFs: DiagnosticsFs = { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync };

/** Render an unknown thrown value the way a bug report needs it: stack when present, else message, else its JSON. */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export function formatDiagnosticsLine(level: DiagnosticsLevel, scope: string, message: string, at: Date): string {
  const flat = message.replace(/\r?\n/g, '\n    ');
  const clipped = flat.length > DIAGNOSTICS_LINE_MAX_CHARS
    ? `${flat.slice(0, DIAGNOSTICS_LINE_MAX_CHARS)}… [truncated ${flat.length - DIAGNOSTICS_LINE_MAX_CHARS} chars]`
    : flat;
  return `${at.toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${clipped}\n`;
}

/** Names of every file the log may occupy, current first. */
export function diagnosticsLogFiles(dir: string, keep: number = DIAGNOSTICS_LOG_KEEP): string[] {
  const files = [join(dir, DIAGNOSTICS_LOG_FILE)];
  for (let index = 1; index <= keep; index += 1) files.push(join(dir, `${DIAGNOSTICS_LOG_FILE}.${index}`));
  return files;
}

export class DiagnosticsLog {
  readonly dir: string;
  readonly path: string;
  private readonly fs: DiagnosticsFs;
  private readonly now: () => Date;
  private readonly rotateBytes: number;
  private readonly keep: number;
  private ready = false;
  private broken = false;

  constructor(options: DiagnosticsLogOptions) {
    this.dir = options.dir;
    this.path = join(options.dir, DIAGNOSTICS_LOG_FILE);
    this.fs = options.fs ?? nodeFs;
    this.now = options.now ?? (() => new Date());
    this.rotateBytes = options.rotateBytes ?? DIAGNOSTICS_LOG_ROTATE_BYTES;
    this.keep = options.keep ?? DIAGNOSTICS_LOG_KEEP;
  }

  /** Synchronous on purpose: the caller is often a crash handler with no
   *  next tick to flush an async write in. A failing disk disables the log
   *  rather than throwing inside the handler that is already handling a throw. */
  write(level: DiagnosticsLevel, scope: string, message: string): void {
    if (this.broken) return;
    try {
      if (!this.ready) {
        this.fs.mkdirSync(this.dir, { recursive: true });
        this.ready = true;
      }
      this.rotateIfNeeded();
      this.fs.appendFileSync(this.path, formatDiagnosticsLine(level, scope, message, this.now()));
    } catch {
      this.broken = true;
    }
  }

  private rotateIfNeeded(): void {
    if (!this.fs.existsSync(this.path) || this.fs.statSync(this.path).size < this.rotateBytes) return;
    const files = diagnosticsLogFiles(this.dir, this.keep);
    const oldest = files[files.length - 1];
    if (this.fs.existsSync(oldest)) this.fs.unlinkSync(oldest);
    for (let index = files.length - 1; index > 0; index -= 1) {
      const from = files[index - 1];
      if (this.fs.existsSync(from)) this.fs.renameSync(from, files[index]);
    }
  }
}

type ConsoleMethod = (...args: unknown[]) => void;
export interface TeeableConsole {
  log: ConsoleMethod;
  info: ConsoleMethod;
  warn: ConsoleMethod;
  error: ConsoleMethod;
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map((arg) => (typeof arg === 'string' ? arg : describeThrown(arg))).join(' ');
}

/** Copy every console line the main process emits (its own `[desktop]`
 *  lines and the embedded server's, which logs through the same console)
 *  into the file, leaving the terminal output untouched. Returns a restore
 *  function so a verify can undo it. */
export function teeConsoleToDiagnostics(log: DiagnosticsLog, target: TeeableConsole = console): () => void {
  const original = { log: target.log, info: target.info, warn: target.warn, error: target.error };
  const tee = (level: DiagnosticsLevel, method: ConsoleMethod): ConsoleMethod => (...args) => {
    method.apply(target, args);
    log.write(level, 'console', formatConsoleArgs(args));
  };
  target.log = tee('info', original.log);
  target.info = tee('info', original.info);
  target.warn = tee('warn', original.warn);
  target.error = tee('error', original.error);
  return () => Object.assign(target, original);
}

export interface CrashCaptureProcess {
  on(event: 'uncaughtException', listener: (error: unknown) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

/** Electron's default for an uncaught main-process exception is a modal
 *  "A JavaScript error occurred" dialog that nobody can copy from and that
 *  has deadlocked headless runs on Windows. Registering a listener replaces
 *  that dialog with a log line; the process keeps running, as it did once the
 *  dialog was dismissed. */
export function installProcessCrashCapture(log: DiagnosticsLog, proc: CrashCaptureProcess, stderr: (line: string) => void): void {
  proc.on('uncaughtException', (error) => {
    const text = describeThrown(error);
    log.write('error', 'main:uncaught', text);
    stderr(`[desktop] uncaught exception: ${text}\n`);
  });
  proc.on('unhandledRejection', (reason) => {
    const text = describeThrown(reason);
    log.write('error', 'main:unhandled-rejection', text);
    stderr(`[desktop] unhandled rejection: ${text}\n`);
  });
}

interface GoneDetails { readonly reason: string; readonly exitCode?: number }
interface ChildGoneDetails extends GoneDetails { readonly type: string; readonly name?: string }
export interface GoneCaptureApp {
  on(event: 'render-process-gone', listener: (event: unknown, contents: unknown, details: GoneDetails) => void): unknown;
  on(event: 'child-process-gone', listener: (event: unknown, details: ChildGoneDetails) => void): unknown;
}

/** Record every renderer or helper process loss on every platform. The
 *  Windows-only reload-and-recover logic stays separate; this only writes
 *  the evidence a bug report needs. */
export function installProcessGoneCapture(log: DiagnosticsLog, app: GoneCaptureApp): void {
  app.on('render-process-gone', (_event, _contents, details) => {
    if (details.reason === 'clean-exit') return;
    log.write('error', 'renderer:gone', `${details.reason} (exit code ${details.exitCode ?? 'n/a'})`);
  });
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    const label = details.name ? `${details.type} "${details.name}"` : details.type;
    log.write('error', 'child:gone', `${label}: ${details.reason} (exit code ${details.exitCode ?? 'n/a'})`);
  });
}

export function diagnosticsLogDir(app: { getPath(name: 'userData'): string }): string {
  return join(app.getPath('userData'), 'logs');
}
