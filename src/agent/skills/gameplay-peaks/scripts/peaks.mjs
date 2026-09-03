#!/usr/bin/env node
// peaks.mjs — rank loud moments in a recording by audio energy alone.
//
// Method: one ffmpeg pass decodes the file to mono 8 kHz signed 16-bit PCM on
// stdout; this script computes short-window RMS in JavaScript and finds
// sustained excursions above a rolling baseline.
//
// Why raw PCM rather than ffmpeg's own `ebur128` or `astats` metering: those
// print human-readable text whose layout, field names and number formatting
// vary between ffmpeg builds and locales, so parsing them is fragile across
// the several ffmpeg binaries this script may end up using. Raw PCM has no
// such ambiguity, 8 kHz is ample for a loudness envelope (speech and game
// impacts both carry plenty of energy below 4 kHz), and it keeps the window,
// hop and baseline entirely under this script's control, which is what makes
// the output reproducible.
//
// Constraints this script is written to:
// - stdout carries JSON and nothing else; every diagnostic goes to stderr.
// - The result depends only on the input file and the options, never on
//   machine load, wall-clock time or floating-point accumulation order.
// - run_skill_script passes only PATH and HOME in the environment, so the
//   ffmpeg path is resolved from the options, the environment when present,
//   PATH, and a set of known install locations derived from the working
//   directory (see resolveFfmpeg).
//
// Usage:
//   node scripts/peaks.mjs <media-path> [options]
//
// Options (all have defaults; see --help):
//   --window-ms, --hop-ms, --baseline-s, --threshold-db, --min-duration-ms,
//   --bridge-ms, --min-gap-ms, --pad-ms, --floor-db, --max, --ffmpeg

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const DEFAULTS = {
  windowMs: 100,        // RMS window; long enough to ignore individual waveform cycles
  hopMs: 50,            // envelope resolution
  baselineS: 30,        // rolling baseline span; a whole round of gameplay, not a whole VOD
  thresholdDb: 6,       // dB above baseline that counts as an excursion
  minDurationMs: 700,   // shorter bursts are clicks, gunshots, UI blips
  bridgeMs: 400,        // dips this short do not end an excursion
  minGapMs: 3000,       // peaks closer than this are merged into one moment
  padMs: 0,             // symmetric padding added to reported boundaries
  floorDb: -50,         // absolute gate: never report anything below this level
  max: 20,              // number of ranked candidates returned
};

const SAMPLE_RATE = 8000;

function usage() {
  return [
    'peaks.mjs <media-path> [options]',
    '',
    'Ranks loud moments by audio energy and prints JSON on stdout.',
    '',
    'Options:',
    `  --window-ms N        RMS window length (default ${DEFAULTS.windowMs})`,
    `  --hop-ms N           envelope step (default ${DEFAULTS.hopMs})`,
    `  --baseline-s N       rolling baseline span in seconds (default ${DEFAULTS.baselineS})`,
    `  --threshold-db N     dB above baseline required (default ${DEFAULTS.thresholdDb})`,
    `  --min-duration-ms N  minimum sustained length (default ${DEFAULTS.minDurationMs})`,
    `  --bridge-ms N        dip tolerated inside one excursion (default ${DEFAULTS.bridgeMs})`,
    `  --min-gap-ms N       merge peaks closer than this (default ${DEFAULTS.minGapMs})`,
    `  --pad-ms N           padding added to each reported range (default ${DEFAULTS.padMs})`,
    `  --floor-db N         absolute dBFS gate (default ${DEFAULTS.floorDb})`,
    `  --max N              candidates returned (default ${DEFAULTS.max})`,
    '  --ffmpeg PATH        ffmpeg binary to use',
    '  --help               print this text',
  ].join('\n');
}

function parseArgs(argv) {
  const numeric = {
    '--window-ms': 'windowMs',
    '--hop-ms': 'hopMs',
    '--baseline-s': 'baselineS',
    '--threshold-db': 'thresholdDb',
    '--min-duration-ms': 'minDurationMs',
    '--bridge-ms': 'bridgeMs',
    '--min-gap-ms': 'minGapMs',
    '--pad-ms': 'padMs',
    '--floor-db': 'floorDb',
    '--max': 'max',
  };
  const options = { ...DEFAULTS };
  let source = null;
  let ffmpegOverride = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--ffmpeg') {
      ffmpegOverride = argv[++i];
      continue;
    }
    if (arg in numeric) {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`${arg} needs a number, got "${raw}"`);
      options[numeric[arg]] = value;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    if (source !== null) throw new Error('only one media path is accepted');
    source = arg;
  }
  if (!source) throw new Error('a media path is required');
  if (options.hopMs <= 0 || options.windowMs <= 0) throw new Error('window and hop must be positive');
  if (options.max <= 0) throw new Error('--max must be positive');
  return { source, options, ffmpegOverride };
}

/**
 * Locate an ffmpeg binary.
 *
 * Order: explicit --ffmpeg, an ffmpeg-path.txt dropped next to this skill,
 * the OpenChatCut/ffmpeg environment overrides (present when the script is
 * run from a terminal, absent under run_skill_script), plain "ffmpeg" from
 * PATH, then the binary the desktop app ships. The app's install tree is
 * found relative to the user profile, which is recovered from the working
 * directory: run_skill_script locks cwd to
 * %USERPROFILE%\.openchatcut\skills\<slug>, so three levels up is the profile.
 */
function ffmpegCandidates(override) {
  const candidates = [];
  const push = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  // An explicitly chosen binary is the only candidate: falling back to a
  // different ffmpeg after the user named one would hide the mistake.
  if (override) return [override];

  const pinned = join(process.cwd(), 'ffmpeg-path.txt');
  if (existsSync(pinned)) {
    try {
      const text = readFileSync(pinned, 'utf8').trim();
      if (text) return [text];
    } catch {
      // An unreadable pin file is skipped in favour of the search below.
    }
  }

  push(process.env.OPENCHATCUT_FFMPEG);
  push(process.env.FFMPEG_PATH);
  push('ffmpeg');

  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const relative = [
    join('resources', 'app', 'node_modules', 'ffmpeg-static', exe),
    join('resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', exe),
    join('resources', 'node_modules', 'ffmpeg-static', exe),
  ];
  const roots = [];
  const profile = resolve(process.cwd(), '..', '..', '..');
  if (process.platform === 'win32') {
    roots.push(join(profile, 'AppData', 'Local', 'Programs', 'OpenChatCut'));
    roots.push(join('C:\\', 'Program Files', 'OpenChatCut'));
    roots.push(join('C:\\', 'Program Files (x86)', 'OpenChatCut'));
  } else if (process.platform === 'darwin') {
    roots.push('/Applications/OpenChatCut.app/Contents');
    roots.push(join(profile, 'Applications', 'OpenChatCut.app', 'Contents'));
  } else {
    roots.push('/opt/OpenChatCut');
    roots.push('/usr/lib/openchatcut');
  }
  for (const root of roots) {
    for (const rel of relative) push(join(root, rel));
  }
  return candidates;
}

function probeFfmpeg(binary) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(binary, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      done(false);
      return;
    }
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

async function resolveFfmpeg(override) {
  const candidates = ffmpegCandidates(override);
  for (const candidate of candidates) {
    const looksLikePath = candidate.includes('/') || candidate.includes('\\');
    if (looksLikePath && isAbsolute(candidate) && !existsSync(candidate)) continue;
    // eslint-disable-next-line no-await-in-loop -- candidates are tried in order, cheaply.
    if (await probeFfmpeg(candidate)) return candidate;
  }
  throw new Error(
    `no usable ffmpeg found. Tried: ${candidates.join(', ')}. `
    + 'Pass --ffmpeg <path>, or write the path into ffmpeg-path.txt in the skill directory.',
  );
}

/** Decode the file to mono 8 kHz PCM and return it as one Int16Array. */
function decodePcm(ffmpeg, source) {
  return new Promise((done, fail) => {
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', source,
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 's16le',
      '-',
    ];
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on('error', (error) => fail(new Error(`could not run ffmpeg: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || 'no diagnostics';
        const noAudio = /does not contain any stream|Output file .* does not contain/i.test(detail);
        fail(new Error(noAudio
          ? `ffmpeg found no audio track in ${source}: ${detail}`
          : `ffmpeg exited ${code}: ${detail}`));
        return;
      }
      if (bytes < 2) {
        fail(new Error('ffmpeg produced no audio — does this file have an audio track?'));
        return;
      }
      const buffer = Buffer.concat(chunks, bytes);
      const usable = buffer.length - (buffer.length % 2);
      done(new Int16Array(buffer.buffer, buffer.byteOffset, usable / 2));
    });
  });
}

/** Short-window RMS in dBFS, one value every hop. */
function envelope(samples, windowMs, hopMs) {
  const windowLength = Math.max(1, Math.round((windowMs / 1000) * SAMPLE_RATE));
  const hopLength = Math.max(1, Math.round((hopMs / 1000) * SAMPLE_RATE));
  const count = Math.max(1, Math.floor((samples.length - windowLength) / hopLength) + 1);
  const levels = new Float64Array(count);
  const silentDb = -120;
  for (let i = 0; i < count; i += 1) {
    const from = i * hopLength;
    const to = Math.min(from + windowLength, samples.length);
    let sum = 0;
    for (let s = from; s < to; s += 1) {
      const v = samples[s] / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    levels[i] = rms > 0 ? Math.max(silentDb, 20 * Math.log10(rms)) : silentDb;
  }
  return levels;
}

/**
 * Rolling baseline: the median level of the surrounding window. The median
 * ignores the loud moments themselves, so a burst never raises the bar it is
 * measured against. It is recomputed on a coarse grid and held between grid
 * points; at 20 hops (1 s at defaults) the baseline cannot move fast enough
 * for that to matter, and it keeps a two-hour VOD to a few seconds of work.
 */
function rollingBaseline(levels, hopMs, baselineS) {
  const span = Math.max(1, Math.round((baselineS * 1000) / hopMs));
  const half = Math.floor(span / 2);
  const stride = Math.max(1, Math.round(1000 / hopMs));
  const baseline = new Float64Array(levels.length);
  const scratch = new Float64Array(span + 1);
  let held = 0;
  for (let i = 0; i < levels.length; i += 1) {
    if (i % stride === 0) {
      const from = Math.max(0, i - half);
      const to = Math.min(levels.length, i + half + 1);
      const n = to - from;
      for (let k = 0; k < n; k += 1) scratch[k] = levels[from + k];
      const slice = scratch.subarray(0, n);
      slice.sort();
      held = n % 2 === 1 ? slice[(n - 1) / 2] : (slice[n / 2 - 1] + slice[n / 2]) / 2;
    }
    baseline[i] = held;
  }
  return baseline;
}

/** Contiguous runs above threshold, allowing dips no longer than bridgeMs. */
function excursions(levels, baseline, options) {
  const { hopMs, thresholdDb, floorDb, bridgeMs } = options;
  const bridgeHops = Math.max(0, Math.round(bridgeMs / hopMs));
  const runs = [];
  let start = -1;
  let lastHot = -1;
  for (let i = 0; i < levels.length; i += 1) {
    const hot = levels[i] >= floorDb && levels[i] - baseline[i] >= thresholdDb;
    if (hot) {
      if (start < 0) start = i;
      lastHot = i;
      continue;
    }
    if (start >= 0 && i - lastHot > bridgeHops) {
      runs.push([start, lastHot]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, lastHot]);
  return runs;
}

function summarise(levels, baseline, from, to) {
  let peakDb = -Infinity;
  let peakIndex = from;
  let excessSum = 0;
  let baselineSum = 0;
  for (let i = from; i <= to; i += 1) {
    if (levels[i] > peakDb) {
      peakDb = levels[i];
      peakIndex = i;
    }
    excessSum += levels[i] - baseline[i];
    baselineSum += baseline[i];
  }
  const n = to - from + 1;
  return {
    peakDb,
    peakIndex,
    meanExcessDb: excessSum / n,
    peakExcessDb: peakDb - baseline[peakIndex],
    baselineDb: baselineSum / n,
  };
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function detect(levels, baseline, options) {
  const { hopMs, minDurationMs, minGapMs, padMs, max } = options;
  const runs = excursions(levels, baseline, options);

  // Merge runs whose gap is under minGapMs, then drop anything too short to
  // be a moment rather than a transient.
  const merged = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && (run[0] - previous[1]) * hopMs < minGapMs) {
      previous[1] = run[1];
      continue;
    }
    merged.push([run[0], run[1]]);
  }

  const kept = [];
  for (const [from, to] of merged) {
    const durationMs = (to - from + 1) * hopMs;
    if (durationMs < minDurationMs) continue;
    const stats = summarise(levels, baseline, from, to);
    kept.push({ from, to, durationMs, ...stats });
  }

  // Score: how far above the baseline the moment sits (peak and sustained
  // energy weighted together) with a mild bonus for length, mapped to 0..1.
  // The mapping is fixed so scores are comparable between runs of the same
  // source, not calibrated against the loudest moment found.
  const scored = kept.map((candidate) => {
    const loudness = 0.6 * Math.min(1, candidate.peakExcessDb / 24)
      + 0.4 * Math.min(1, candidate.meanExcessDb / 15);
    const sustain = Math.min(1, candidate.durationMs / 4000);
    const score = round(Math.min(1, 0.8 * loudness + 0.2 * sustain), 3);
    const start = Math.max(0, (candidate.from * hopMs - padMs) / 1000);
    const end = (candidate.to * hopMs + options.windowMs + padMs) / 1000;
    return {
      start: round(start, 2),
      end: round(end, 2),
      score,
      reason: `${round(candidate.peakExcessDb, 1)} dB above a ${round(candidate.baselineDb, 1)} dBFS baseline, `
        + `sustained ${round(candidate.durationMs / 1000, 2)} s (mean +${round(candidate.meanExcessDb, 1)} dB)`,
      peakAt: round((candidate.peakIndex * hopMs + options.windowMs / 2) / 1000, 2),
      peakDb: round(candidate.peakDb, 1),
      baselineDb: round(candidate.baselineDb, 1),
      durationSeconds: round(candidate.durationMs / 1000, 2),
    };
  });

  // Rank by score, breaking ties by position so the output is stable.
  scored.sort((a, b) => (b.score - a.score) || (a.start - b.start));
  return scored.slice(0, max);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stderr.write(`${usage()}\n`);
    return;
  }
  const { source, options, ffmpegOverride } = parsed;
  const ffmpeg = await resolveFfmpeg(ffmpegOverride);
  process.stderr.write(`ffmpeg: ${ffmpeg}\n`);

  const samples = await decodePcm(ffmpeg, source);
  const durationSeconds = samples.length / SAMPLE_RATE;
  process.stderr.write(`decoded ${round(durationSeconds, 2)} s of audio at ${SAMPLE_RATE} Hz mono\n`);

  const levels = envelope(samples, options.windowMs, options.hopMs);
  const baseline = rollingBaseline(levels, options.hopMs, options.baselineS);
  const peaks = detect(levels, baseline, options);
  process.stderr.write(`found ${peaks.length} candidate moment(s)\n`);

  process.stdout.write(`${JSON.stringify({
    version: 1,
    source,
    durationSeconds: round(durationSeconds, 2),
    sampleRate: SAMPLE_RATE,
    options,
    peaks,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
