#!/usr/bin/env node
// candidates.mjs — shortlist a speaker's likely verbal tics from a transcript.
//
// This is the cheap deterministic half of the skill: counting, not judging.
// It reduces a whole VOD transcript to a few dozen frequent short tokens with
// example contexts, so the model classifies a small list instead of reading
// the transcript. Nothing here decides what a filler is.
//
// Normalisation matches isFiller in src/transcript/edit.ts exactly —
// lowercase, then drop everything outside a-z and the CJK block — so a token
// shortlisted here is the same string clean_script will compare against.
//
// Constraints:
// - stdout carries JSON and nothing else; diagnostics go to stderr.
// - No dependencies beyond node builtins, and no network or filesystem
//   access outside the input file.
// - Word order and counts fully determine the output.
//
// Usage:
//   node scripts/candidates.mjs <transcript.json> [options]
//
// Input shapes accepted (the first one present wins):
//   {"words":    [{"text":"like","start":1200,"end":1350}, ...]}
//   {"phrases":  [{"text":"so like i was saying","start":1200}, ...]}
//   {"segments": [{"text":"...","start":1200}, ...]}
//   [ {"text":"..."} , ... ]   or   ["...", "..."]   or   "one long string"
// `start` may be named start, startMs, from, fromMs or fromSeconds; values in
// seconds are accepted when the key says so, otherwise milliseconds are
// assumed. Times are only used to label examples, never to select tokens.
// A phrase-level input attributes the phrase's start time to every token in
// it, which is close enough for a timestamp shown next to an example.

import { readFileSync } from 'node:fs';

const DEFAULTS = {
  minCount: 3,     // below this a repeat is coincidence, not a habit
  maxLen: 12,      // normalised length; tics are short words
  limit: 40,       // candidates returned
  examples: 3,     // contexts per candidate
  contextWords: 4, // words either side of an example
};

// The fixed list clean_script already strips (FILLER in src/transcript/edit.ts).
// These are counted and reported separately: proposing them again would be noise.
const BUILT_IN_FILLERS = new Set([
  'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'mmm',
  '嗯', '呃', '啊', '唔', '额',
]);

// Grammatical words a mechanical cut must never remove: articles, pronouns,
// prepositions, auxiliaries, negations, conjunctions that carry structure.
// Deliberately does NOT include like, so, just, right, okay, yeah, well,
// literally, basically, actually, honestly, dude, man — those are exactly the
// words that may or may not be tics for this speaker, which is the model's
// call, not this script's.
const STRUCTURAL = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'because', 'while',
  'i', 'im', 'ive', 'ill', 'me', 'my', 'mine', 'myself', 'we', 'our', 'us',
  'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its',
  'they', 'them', 'their', 'theirs', 'who', 'whom', 'whose', 'which', 'what',
  'when', 'where', 'why', 'how', 'this', 'that', 'these', 'those',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'have', 'has', 'had', 'can', 'could', 'will', 'would', 'shall', 'should',
  'may', 'might', 'must', 'not', 'no', 'dont', 'doesnt', 'didnt', 'cant',
  'wont', 'isnt', 'arent', 'wasnt', 'werent', 'aint',
  'in', 'on', 'at', 'to', 'of', 'for', 'from', 'with', 'without', 'into',
  'onto', 'over', 'under', 'up', 'down', 'out', 'off', 'about', 'through',
  'by', 'as', 'there', 'here', 'all', 'one', 'two', 'three', 'four', 'five',
]);

function usage() {
  return [
    'candidates.mjs <transcript.json> [options]',
    '',
    'Shortlists frequent short tokens as possible verbal tics and prints JSON on stdout.',
    '',
    'Options:',
    `  --min-count N      minimum occurrences (default ${DEFAULTS.minCount})`,
    `  --max-len N        maximum normalised token length (default ${DEFAULTS.maxLen})`,
    `  --limit N          candidates returned (default ${DEFAULTS.limit})`,
    `  --examples N       contexts per candidate (default ${DEFAULTS.examples})`,
    `  --context-words N  words either side of an example (default ${DEFAULTS.contextWords})`,
    '  --help             print this text',
  ].join('\n');
}

function parseArgs(argv) {
  const numeric = {
    '--min-count': 'minCount',
    '--max-len': 'maxLen',
    '--limit': 'limit',
    '--examples': 'examples',
    '--context-words': 'contextWords',
  };
  const options = { ...DEFAULTS };
  let input = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg in numeric) {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`${arg} needs a number, got "${raw}"`);
      options[numeric[arg]] = value;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    if (input !== null) throw new Error('only one transcript path is accepted');
    input = arg;
  }
  if (!input) throw new Error('a transcript JSON path is required');
  return { input, options };
}

/** isFiller's normalisation, kept identical so shortlisted tokens match clean_script. */
function normalise(text) {
  return String(text).toLowerCase().replace(/[^a-z一-鿿]/g, '');
}

function startMsOf(entry) {
  const pairs = [
    ['startMs', 1], ['fromMs', 1], ['start', 1], ['from', 1],
    ['startSeconds', 1000], ['fromSeconds', 1000],
  ];
  for (const [key, scale] of pairs) {
    const value = entry?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value * scale;
  }
  return null;
}

/** Flatten any accepted input shape into [{raw, norm, startMs}]. */
function tokenise(parsed) {
  const tokens = [];
  const pushText = (text, startMs) => {
    for (const raw of String(text).split(/\s+/)) {
      if (!raw) continue;
      const norm = normalise(raw);
      if (!norm) continue;
      tokens.push({ raw, norm, startMs });
    }
  };

  const entries = Array.isArray(parsed)
    ? parsed
    : parsed?.words ?? parsed?.phrases ?? parsed?.segments ?? null;

  if (typeof parsed === 'string') {
    pushText(parsed, null);
    return tokens;
  }
  if (!Array.isArray(entries)) {
    throw new Error('unrecognised transcript shape: expected words[], phrases[], segments[], an array, or a string');
  }
  for (const entry of entries) {
    if (typeof entry === 'string') {
      pushText(entry, null);
      continue;
    }
    const text = entry?.text ?? entry?.word ?? entry?.content;
    if (typeof text !== 'string') continue;
    pushText(text, startMsOf(entry));
  }
  return tokens;
}

function timestamp(ms) {
  if (ms === null || ms === undefined) return null;
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function contextAt(tokens, index, contextWords) {
  const from = Math.max(0, index - contextWords);
  const to = Math.min(tokens.length, index + contextWords + 1);
  const words = [];
  for (let i = from; i < to; i += 1) {
    words.push(i === index ? `[${tokens[i].raw}]` : tokens[i].raw);
  }
  return words.join(' ');
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stderr.write(`${usage()}\n`);
    return;
  }
  const { input, options } = parsed;

  let document;
  try {
    document = JSON.parse(readFileSync(input, 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${input} as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const tokens = tokenise(document);
  if (tokens.length === 0) throw new Error('no words found in the transcript');
  process.stderr.write(`${tokens.length} words read from ${input}\n`);

  const counts = new Map();      // norm -> {count, surfaces:Map, indices:[]}
  const builtIn = new Map();     // norm -> count
  for (let i = 0; i < tokens.length; i += 1) {
    const { norm, raw } = tokens[i];
    if (BUILT_IN_FILLERS.has(norm)) {
      builtIn.set(norm, (builtIn.get(norm) ?? 0) + 1);
      continue;
    }
    let record = counts.get(norm);
    if (!record) {
      record = { count: 0, surfaces: new Map(), indices: [] };
      counts.set(norm, record);
    }
    record.count += 1;
    record.surfaces.set(raw, (record.surfaces.get(raw) ?? 0) + 1);
    record.indices.push(i);
  }

  // Immediate repetition ("wait wait", "no no no") is a tic pattern in its own
  // right, so it is reported as evidence alongside the token it doubles.
  const repeats = new Map();
  for (let i = 1; i < tokens.length; i += 1) {
    const norm = tokens[i].norm;
    if (norm !== tokens[i - 1].norm) continue;
    let record = repeats.get(norm);
    if (!record) {
      record = { count: 0, indices: [] };
      repeats.set(norm, record);
    }
    record.count += 1;
    record.indices.push(i - 1);
  }

  // Spread the examples over the recording instead of taking the first few:
  // three contexts from one shouting match say less about a habit than three
  // from the start, middle and end.
  const spread = (indices, wanted) => {
    if (indices.length <= wanted) return indices;
    const picked = [];
    for (let k = 0; k < wanted; k += 1) {
      picked.push(indices[Math.floor((k * indices.length) / wanted)]);
    }
    return picked;
  };

  const perThousand = (count) => Math.round((count / tokens.length) * 100000) / 100;

  const candidates = [...counts.entries()]
    .filter(([norm, record]) => record.count >= options.minCount
      && norm.length <= options.maxLen
      && !STRUCTURAL.has(norm))
    // Frequency first; alphabetical tie-break keeps runs reproducible.
    .sort((a, b) => (b[1].count - a[1].count) || a[0].localeCompare(b[0]))
    .slice(0, options.limit)
    .map(([norm, record]) => {
      const repeat = repeats.get(norm);
      return {
        token: norm,
        count: record.count,
        per1000Words: perThousand(record.count),
        surfaceForms: [...record.surfaces.entries()]
          .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
          .slice(0, 3)
          .map(([surface]) => surface),
        immediateRepeats: repeat ? repeat.count : 0,
        examples: spread(record.indices, options.examples).map((index) => ({
          at: timestamp(tokens[index].startMs),
          context: contextAt(tokens, index, options.contextWords),
        })),
      };
    });

  const repeatOnly = [...repeats.entries()]
    .filter(([norm, record]) => record.count >= Math.max(2, Math.ceil(options.minCount / 2))
      && !STRUCTURAL.has(norm)
      && !BUILT_IN_FILLERS.has(norm))
    .sort((a, b) => (b[1].count - a[1].count) || a[0].localeCompare(b[0]))
    .slice(0, options.limit)
    .map(([norm, record]) => ({
      pattern: `${norm} ${norm}`,
      count: record.count,
      examples: spread(record.indices, options.examples).map((index) => ({
        at: timestamp(tokens[index].startMs),
        context: contextAt(tokens, index, options.contextWords),
      })),
    }));

  process.stderr.write(`${candidates.length} candidate token(s), ${repeatOnly.length} repetition pattern(s)\n`);

  process.stdout.write(`${JSON.stringify({
    version: 1,
    source: input,
    totals: {
      words: tokens.length,
      distinctTokens: counts.size,
      timestamps: tokens.some((t) => t.startMs !== null),
    },
    options,
    candidates,
    repetitions: repeatOnly,
    alreadyHandled: [...builtIn.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([token, count]) => ({ token, count })),
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
