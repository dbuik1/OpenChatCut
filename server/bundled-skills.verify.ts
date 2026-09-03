// Runnable check: `npx tsx server/bundled-skills.verify.ts`.
// First-run materialisation of bundled skills that ship scripts/: a bundled
// skill's files live in the renderer bundle, but run_skill_script executes
// from the user skills root on disk, so a scripts-bearing skill has to be
// copied there once — without ever clobbering a directory the user owns.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bundledSkillsDir,
  materialiseBundledSkills,
  scriptBearingSkills,
} from './bundled-skills.ts';

const SKILL_MD = '---\nname: with-scripts\ndescription: Use when checking materialisation.\n---\n# Body\n';

async function writeFileAt(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text, 'utf8');
}

/** A bundled-skills source tree: one skill with scripts, one without. */
async function makeSource(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'occ-bundled-src-'));
  await writeFileAt(join(dir, 'with-scripts', 'SKILL.md'), SKILL_MD);
  await writeFileAt(join(dir, 'with-scripts', 'references', 'notes.md'), 'reference text');
  await writeFileAt(join(dir, 'with-scripts', 'scripts', 'run.mjs'), 'console.log(1);\n');
  await writeFileAt(join(dir, 'text-only', 'SKILL.md'), SKILL_MD.replace('with-scripts', 'text-only'));
  await writeFileAt(join(dir, 'text-only', 'references', 'notes.md'), 'reference text');
  // An empty scripts/ directory is not a script.
  await mkdir(join(dir, 'text-only', 'scripts'), { recursive: true });
  return dir;
}

const source = await makeSource();

assert.deepEqual(
  await scriptBearingSkills(source),
  ['with-scripts'],
  'only a skill with at least one file under scripts/ counts',
);

// 1. A scripts-bearing bundled skill materialises whole, and logs once.
{
  const root = await mkdtemp(join(tmpdir(), 'occ-skills-root-'));
  const logged: string[] = [];
  const installed = await materialiseBundledSkills({ sourceDir: source, root, log: (m) => logged.push(m) });
  assert.deepEqual(installed, ['with-scripts'], 'the scripts-bearing skill is installed');
  assert.equal(logged.length, 1, 'one log line per materialised slug');
  assert.ok(logged[0]!.includes('with-scripts'), 'the log names the slug');
  assert.equal(await readFile(join(root, 'with-scripts', 'SKILL.md'), 'utf8'), SKILL_MD);
  assert.ok(existsSync(join(root, 'with-scripts', 'references', 'notes.md')), 'references/ comes too');
  assert.ok(existsSync(join(root, 'with-scripts', 'scripts', 'run.mjs')), 'scripts/ comes too');

  // 2. A scriptless bundled skill is left in the bundle — no on-disk copy to drift.
  assert.ok(!existsSync(join(root, 'text-only')), 'a skill without scripts is not materialised');

  // 3. A second run is a no-op: nothing installed, nothing logged, no staging left over.
  const again = await materialiseBundledSkills({ sourceDir: source, root, log: (m) => logged.push(m) });
  assert.deepEqual(again, [], 'second run installs nothing');
  assert.equal(logged.length, 1, 'second run logs nothing');
  assert.deepEqual(
    (await readdir(root)).sort(),
    ['with-scripts'],
    'no staging directories survive a completed run',
  );
}

// 4. An existing user directory for the slug is never overwritten or merged into.
{
  const root = await mkdtemp(join(tmpdir(), 'occ-skills-root-'));
  const mine = join(root, 'with-scripts');
  await writeFileAt(join(mine, 'SKILL.md'), '---\nname: with-scripts\ndescription: Mine.\n---\n# Mine\n');
  const installed = await materialiseBundledSkills({ sourceDir: source, root });
  assert.deepEqual(installed, [], 'an existing directory is not a materialisation target');
  assert.ok((await readFile(join(mine, 'SKILL.md'), 'utf8')).includes('# Mine'), 'the user edit survives');
  assert.ok(!existsSync(join(mine, 'scripts')), 'the bundled copy is not merged in');
}

// 5. A write interrupted mid-copy is retried, not read as installed. The staging
//    directory is what a crash leaves behind; the slug directory only ever
//    appears by rename, so the presence check cannot see a half-written skill.
{
  const root = await mkdtemp(join(tmpdir(), 'occ-skills-root-'));
  const staging = join(root, '.materialising-with-scripts-deadbeef');
  await writeFileAt(join(staging, 'SKILL.md'), SKILL_MD);  // no references/, no scripts/
  const installed = await materialiseBundledSkills({ sourceDir: source, root });
  assert.deepEqual(installed, ['with-scripts'], 'the interrupted slug is materialised on the next run');
  assert.ok(existsSync(join(root, 'with-scripts', 'scripts', 'run.mjs')), 'the retry lands the whole skill');
  assert.deepEqual((await readdir(root)).sort(), ['with-scripts'], 'the stale staging directory is cleared');
}

// 6. The source directory resolves to the repo's bundled skills under tsx.
{
  const dir = bundledSkillsDir();
  assert.ok(existsSync(join(dir, 'transcription', 'SKILL.md')), `bundled skills not found at ${dir}`);
}

console.log('bundled-skills.check: ok (materialise / no-op / user wins / scriptless skipped / partial retried)');
