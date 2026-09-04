import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIAGNOSTICS_LINE_MAX_CHARS,
  DIAGNOSTICS_LOG_FILE,
  DiagnosticsLog,
  describeThrown,
  diagnosticsLogDir,
  diagnosticsLogFiles,
  formatDiagnosticsLine,
  installProcessCrashCapture,
  installProcessGoneCapture,
  teeConsoleToDiagnostics,
  type DiagnosticsFs,
} from './diagnostics-log.ts';
import {
  clampDiagnosticsReport,
  DIAGNOSTICS_REPORT_MAX_CHARS,
  isDesktopDiagnosticsReport,
} from '../shared/desktop-diagnostics.ts';

/** In-memory file system so rotation is observable without touching disk. */
function memoryFs(): DiagnosticsFs & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    appendFileSync(path, data) { files.set(path, (files.get(path) ?? '') + data); },
    existsSync(path) { return files.has(path) || dirs.has(path); },
    mkdirSync(path) { dirs.add(path); },
    renameSync(from, to) { files.set(to, files.get(from) ?? ''); files.delete(from); },
    statSync(path) { return { size: (files.get(path) ?? '').length }; },
    unlinkSync(path) { files.delete(path); },
  };
}

const at = new Date('2026-09-04T10:00:00.000Z');

// Line format: timestamp, padded level, scope, continuation lines indented.
assert.equal(
  formatDiagnosticsLine('warn', 'console', 'first\nsecond', at),
  '2026-09-04T10:00:00.000Z WARN  [console] first\n    second\n',
);
const long = formatDiagnosticsLine('error', 'x', 'a'.repeat(DIAGNOSTICS_LINE_MAX_CHARS + 50), at);
assert.ok(long.includes('… [truncated 50 chars]'), 'oversized lines are clipped, not dropped');

assert.equal(describeThrown('plain'), 'plain');
assert.match(describeThrown(new TypeError('boom')), /^TypeError: boom/);
assert.equal(describeThrown({ code: 7 }), '{"code":7}');
assert.equal(diagnosticsLogDir({ getPath: () => '/ud' }), join('/ud', 'logs'));
assert.deepEqual(diagnosticsLogFiles('/d', 2), [
  join('/d', DIAGNOSTICS_LOG_FILE), join('/d', `${DIAGNOSTICS_LOG_FILE}.1`), join('/d', `${DIAGNOSTICS_LOG_FILE}.2`),
]);

// Writes create the folder lazily and append in order.
{
  const fs = memoryFs();
  const log = new DiagnosticsLog({ dir: '/logs', fs, now: () => at });
  log.write('info', 'desktop', 'starting');
  log.write('error', 'main:uncaught', 'boom');
  assert.ok(fs.dirs.has('/logs'));
  const text = fs.files.get(join('/logs', DIAGNOSTICS_LOG_FILE)) ?? '';
  assert.equal(text.split('\n').filter(Boolean).length, 2);
  assert.match(text, /INFO {2}\[desktop\] starting\n.*ERROR \[main:uncaught\] boom\n$/s);
}

// Rotation: once the current file reaches the threshold the next write shifts
// the chain and drops the oldest, so at most keep+1 files ever exist.
{
  const fs = memoryFs();
  const log = new DiagnosticsLog({ dir: '/logs', fs, now: () => at, rotateBytes: 120, keep: 2 });
  for (let index = 0; index < 12; index += 1) log.write('info', 'rot', `line ${index} ${'x'.repeat(40)}`);
  const names = [...fs.files.keys()].sort();
  assert.deepEqual(names, diagnosticsLogFiles('/logs', 2).sort());
  const current = fs.files.get(join('/logs', DIAGNOSTICS_LOG_FILE)) ?? '';
  assert.match(current, /line 11/, 'newest line lives in the current file');
  const oldest = fs.files.get(join('/logs', `${DIAGNOSTICS_LOG_FILE}.2`)) ?? '';
  assert.doesNotMatch(oldest, /line 0 /, 'the earliest lines have been dropped');
}

// A failing disk disables the log instead of throwing into a crash handler.
{
  const fs = memoryFs();
  fs.appendFileSync = () => { throw new Error('EROFS'); };
  const log = new DiagnosticsLog({ dir: '/logs', fs });
  assert.doesNotThrow(() => log.write('error', 'x', 'y'));
  assert.doesNotThrow(() => log.write('error', 'x', 'y'));
}

// Console tee: terminal output is untouched, the file gets a copy, restore undoes it.
{
  const fs = memoryFs();
  const log = new DiagnosticsLog({ dir: '/logs', fs, now: () => at });
  const seen: string[] = [];
  const target = {
    log: (...args: unknown[]) => seen.push(`log:${args.join(' ')}`),
    info: (...args: unknown[]) => seen.push(`info:${args.join(' ')}`),
    warn: (...args: unknown[]) => seen.push(`warn:${args.join(' ')}`),
    error: (...args: unknown[]) => seen.push(`error:${args.join(' ')}`),
  };
  const restore = teeConsoleToDiagnostics(log, target);
  target.error('[embedded-server]', new Error('bad'));
  target.log('[desktop] hello');
  restore();
  target.warn('after restore');
  assert.deepEqual(seen.map((line) => line.split(' ')[0]), ['error:[embedded-server]', 'log:[desktop]', 'warn:after']);
  const text = fs.files.get(join('/logs', DIAGNOSTICS_LOG_FILE)) ?? '';
  assert.match(text, /ERROR \[console\] \[embedded-server\] Error: bad/);
  assert.match(text, /INFO {2}\[console\] \[desktop\] hello/);
  assert.doesNotMatch(text, /after restore/);
}

// Process capture: both hooks land in the file and echo to stderr.
{
  const fs = memoryFs();
  const log = new DiagnosticsLog({ dir: '/logs', fs, now: () => at });
  const listeners = new Map<string, (value: unknown) => void>();
  const stderr: string[] = [];
  installProcessCrashCapture(log, {
    on(event: string, listener: (value: unknown) => void) { listeners.set(event, listener); return undefined; },
  }, (line) => stderr.push(line));
  listeners.get('uncaughtException')?.(new Error('crash'));
  listeners.get('unhandledRejection')?.('reason');
  const text = fs.files.get(join('/logs', DIAGNOSTICS_LOG_FILE)) ?? '';
  assert.match(text, /ERROR \[main:uncaught\] Error: crash/);
  assert.match(text, /ERROR \[main:unhandled-rejection\] reason/);
  assert.equal(stderr.length, 2);
}

// Process-gone capture records every platform's losses and ignores clean exits.
{
  const fs = memoryFs();
  const log = new DiagnosticsLog({ dir: '/logs', fs, now: () => at });
  const handlers = new Map<string, (...args: unknown[]) => void>();
  installProcessGoneCapture(log, {
    on(event: string, listener: (...args: never[]) => void) { handlers.set(event, listener as (...args: unknown[]) => void); return undefined; },
  });
  handlers.get('render-process-gone')?.({}, {}, { reason: 'clean-exit', exitCode: 0 });
  handlers.get('render-process-gone')?.({}, {}, { reason: 'crashed', exitCode: 5 });
  handlers.get('child-process-gone')?.({}, { type: 'GPU', reason: 'killed', exitCode: 9 });
  const lines = (fs.files.get(join('/logs', DIAGNOSTICS_LOG_FILE)) ?? '').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[renderer:gone\] crashed \(exit code 5\)/);
  assert.match(lines[1], /\[child:gone\] GPU: killed \(exit code 9\)/);
}

// Renderer reports are validated and clamped before they reach the file.
assert.ok(isDesktopDiagnosticsReport({ kind: 'error', message: 'x' }));
assert.ok(isDesktopDiagnosticsReport({ kind: 'render-error', message: 'x', stack: 's', url: '/u' }));
assert.equal(isDesktopDiagnosticsReport({ kind: 'other', message: 'x' }), false);
assert.equal(isDesktopDiagnosticsReport({ kind: 'error', message: 1 }), false);
assert.equal(isDesktopDiagnosticsReport(null), false);
{
  const clamped = clampDiagnosticsReport({ kind: 'error', message: 'm'.repeat(DIAGNOSTICS_REPORT_MAX_CHARS * 2), stack: 's' });
  assert.equal(clamped.message.length, DIAGNOSTICS_REPORT_MAX_CHARS);
  assert.equal(clamped.stack, 's');
  assert.equal('url' in clamped, false);
}

// Wiring: the main process installs the log before anything else runs, and
// the preload exposes the three renderer entry points.
const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
assert.match(mainSource, /teeConsoleToDiagnostics\(diagnosticsLog\)/);
assert.match(mainSource, /installProcessCrashCapture\(diagnosticsLog, process/);
assert.match(mainSource, /installProcessGoneCapture\(diagnosticsLog, app\)/);
assert.match(mainSource, /installDiagnosticsIpc\(origin, diagnosticsLog\)/);
const preloadSource = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8');
for (const entry of ['report', 'logPath', 'openLogFolder']) {
  assert.match(preloadSource, new RegExp(`${entry}: `), `preload exposes diagnostics.${entry}`);
}
const rendererTypes = readFileSync(new URL('../src/desktop-api.d.ts', import.meta.url), 'utf8');
assert.match(rendererTypes, /diagnostics: DesktopDiagnosticsApi;/, 'renderer global type mirrors the preload');

console.log('diagnostics-log.verify: ok');
