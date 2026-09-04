// POST /api/measure-loudness — integrated loudness for a range of a local
// /media/uploads file, measured by ffmpeg's loudnorm filter.
//
// Measuring in the renderer meant fetching the whole file and decoding all of
// it into an AudioBuffer, which is why loudness work was restricted to audio
// clips: letting a video clip through would have decoded a multi-gigabyte
// container in the tab. ffmpeg decodes in a stream, reads any container, and
// implements the full ITU-R BS.1770 gating rather than the approximation the
// renderer could afford, so the measurement is both cheaper and more accurate.
//
// The range is the clip's own trimmed window. Measuring the whole source gives
// a ten-second quiet excerpt of a loud recording the recording's loudness, and
// therefore the wrong gain.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import { ffmpegBin } from '../media-binaries.ts';
import { ffmpegThreadArgs, spawnMediaProcess } from '../media-process.ts';

const MAX_JSON = 8 * 1024;
const STDERR_LIMIT = 64 * 1024;
/** Silence floor loudnorm reports for a range with no signal. */
const SILENCE_LUFS = -70;

/**
 * loudnorm decodes far faster than realtime, so a budget in multiples of the
 * measured range catches a stuck process without cutting off a long clip. The
 * floor covers short ranges, where process start dominates.
 */
function measureTimeoutMs(seconds: number): number {
  return Math.max(60_000, Math.ceil(seconds * 3) * 1_000);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, max = MAX_JSON): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** `/media/uploads/foo.mp4` → `foo.mp4` or null if unsafe. */
export function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const match = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!match) return null;
  return isSafeUploadName(match[1]) ? match[1] : null;
}

export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDb: number;
  loudnessRange: number;
  thresholdLufs: number;
}

/**
 * loudnorm writes its JSON summary to stderr after the ffmpeg log, and reports
 * an all-silent range as -inf rather than a number. Silence is a real answer
 * here — it becomes the maximum gain, clamped by gainForTarget — so it maps to
 * the BS.1770 silence floor instead of failing the request.
 */
export function parseLoudnormJson(stderr: string): LoudnessMeasurement | null {
  const start = stderr.lastIndexOf('{');
  if (start < 0) return null;
  const end = stderr.indexOf('}', start);
  if (end < 0) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const read = (key: string, floor: number): number => {
    const value = Number(parsed[key]);
    return Number.isFinite(value) ? value : floor;
  };
  if (!('input_i' in parsed)) return null;
  return {
    integratedLufs: read('input_i', SILENCE_LUFS),
    truePeakDb: read('input_tp', SILENCE_LUFS),
    loudnessRange: read('input_lra', 0),
    thresholdLufs: read('input_thresh', SILENCE_LUFS),
  };
}

function runLoudnorm(
  inputPath: string,
  startSeconds: number,
  durationSeconds: number | null,
): Promise<{ stderr: string; code: number | null }> {
  const timeoutMs = measureTimeoutMs(durationSeconds ?? 0);
  return new Promise((resolve, reject) => {
    const args = [
      ...ffmpegThreadArgs(),
      '-nostdin', '-hide_banner',
    ];
    // Input seeking: loudnorm only reads the decoded samples, so the cheaper
    // pre-input seek costs nothing in accuracy here.
    if (startSeconds > 0) args.push('-ss', startSeconds.toFixed(3));
    args.push('-i', inputPath);
    if (durationSeconds !== null) args.push('-t', durationSeconds.toFixed(3));
    args.push(
      '-map', '0:a:0',
      '-af', 'loudnorm=print_format=json',
      '-vn', '-sn', '-dn',
      '-f', 'null', '-',
    );
    const child = spawnMediaProcess(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      // The JSON summary is the last thing written, so keep the tail.
      if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT / 2);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stderr, code });
    });
  });
}

/** Whole-file measurement for a finished export; a missing audio stream is an answer, not a failure. */
export async function measureFileLoudness(inputPath: string): Promise<{ measurement: LoudnessMeasurement | null; noAudio: boolean; stderr: string }> {
  const { stderr } = await runLoudnorm(inputPath, 0, null);
  const measurement = parseLoudnormJson(stderr);
  const noAudio = !measurement && /Stream map .* matches no streams|does not contain any stream/i.test(stderr);
  return { measurement, noAudio, stderr };
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function measureLoudnessPlugin(): Plugin {
  return {
    name: 'openchatcut-measure-loudness',
    configureServer(server) {
      server.middlewares.use('/api/measure-loudness', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          const body = (await readJson(req)) as {
            src?: string;
            startSeconds?: number;
            durationSeconds?: number;
          };
          const src = String(body.src ?? '').trim();
          const name = uploadNameFromSrc(src);
          if (!name) {
            sendJson(res, 400, { error: 'src must be /media/uploads/<safe-name>' });
            return;
          }
          const inputPath = resolveUploadFile(name);
          if (!inputPath) {
            sendJson(res, 404, { error: `media not found: ${name}` });
            return;
          }
          const startSeconds = Math.max(0, Number(body.startSeconds ?? 0) || 0);
          const durationSeconds = positiveNumber(body.durationSeconds);

          const { stderr, code } = await runLoudnorm(inputPath, startSeconds, durationSeconds);
          const measurement = parseLoudnormJson(stderr);
          if (!measurement) {
            // ffmpeg reports a missing audio stream as a mapping failure, which
            // is not an error the caller can fix by retrying.
            const noAudio = /Stream map .* matches no streams|does not contain any stream/i.test(stderr);
            sendJson(res, noAudio ? 422 : 500, {
              ok: false,
              noAudio,
              error: noAudio
                ? `source has no audio track: ${name}`
                : `loudness measurement failed (ffmpeg exit ${code}): ${stderr.slice(-500)}`,
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            source: src,
            startSeconds,
            durationSeconds,
            ...measurement,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[measure-loudness] ${message}`);
          const status = /ENOENT|spawn ffmpeg/i.test(message) ? 503 : 500;
          sendJson(res, status, { error: message });
        }
      });
    },
  };
}
