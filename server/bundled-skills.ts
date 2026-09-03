// Bundled skills that ship executable scripts have to reach the disk.
// src/agent/skills/<slug>/ is raw-imported into the renderer bundle by
// plugin-skills.ts, so load_skill can read every file — but run_skill_script
// (server/plugins/skill-exec.ts) execFiles inside skillDirFor(root, slug)
// under the user skills root, and a string in a JS bundle is not a directory.
// A bundled skill carrying scripts/ was therefore readable and unrunnable.
// This module copies such a skill into the user skills root once.
//
// Node-only by construction: it lives in server/, imports node:fs, and is
// reached only through the server plugins, which the browser build never
// imports — there is no filesystem there and nothing to materialise.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { skillDirFor, skillFilesRoot } from './skills-files.ts';

/** Prefix of the staging directory a materialisation renames into place. */
const STAGING_PREFIX = '.materialising-';

/**
 * Where the bundled skill sources sit: the repo directory under tsx/vite, and
 * the extraResources copy in a packaged desktop build. Mirrors whisperCliBin.
 */
export function bundledSkillsDir(): string {
  const candidates = [
    join(import.meta.dirname, '..', 'src', 'agent', 'skills'),
    join(process.resourcesPath ?? '', 'bundled-skills'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

async function containsFile(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return false;
  }
  return entries.some((entry) => entry.isFile());
}

/**
 * Bundled slugs that ship at least one file under scripts/. A skill without
 * scripts already works as read-only text through load_skill; copying it to
 * disk would only create a second copy that can drift from the bundle.
 */
export async function scriptBearingSkills(sourceDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await containsFile(join(sourceDir, entry.name, 'scripts'))) slugs.push(entry.name);
  }
  return slugs.sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Leftovers from a run that died mid-copy. Their slug directory was never created. */
async function clearStagingDirs(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX)) {
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

export interface MaterialiseOptions {
  readonly sourceDir: string;
  readonly root: string;
  readonly log?: (message: string) => void;
}

/**
 * Install every scripts-bearing bundled skill whose directory is absent from
 * the user skills root, whole (SKILL.md + references/ + scripts/).
 *
 * An existing directory for the slug is NEVER overwritten or merged into: the
 * user's own edits to a skill win over the bundled copy, and a missing
 * directory is the only trigger for writing one.
 *
 * The copy lands in a staging directory that is renamed into place, so an
 * interrupted run leaves either nothing or a complete skill — never a
 * half-populated directory that the presence check would then read as
 * installed and refuse to retry.
 *
 * Returns the slugs materialised by this call.
 */
export async function materialiseBundledSkills(options: MaterialiseOptions): Promise<string[]> {
  const { sourceDir, root, log } = options;
  const slugs = await scriptBearingSkills(sourceDir);
  if (slugs.length === 0) return [];
  await mkdir(root, { recursive: true });
  await clearStagingDirs(root);
  const installed: string[] = [];
  for (const slug of slugs) {
    const target = skillDirFor(root, slug);
    if (!target || await exists(target)) continue;
    const staging = join(root, `${STAGING_PREFIX}${slug}-${randomBytes(6).toString('hex')}`);
    try {
      await cp(join(sourceDir, slug), staging, { recursive: true });
      await rename(staging, target);
    } catch {
      // A concurrent starter can win the rename; either way the directory the
      // user ends up with is one complete skill.
      await rm(staging, { recursive: true, force: true });
      continue;
    }
    installed.push(slug);
    log?.(`[skills] installed bundled skill "${slug}" into ${root}`);
  }
  return installed;
}

let pending: Promise<string[]> | null = null;

/**
 * Once-per-process materialisation into the configured skills root
 * (OPENCHATCUT_SKILLS_DIR, else ~/.openchatcut/skills). Silent unless it
 * installs something, and never rejects — a skills root that cannot be
 * written is not a reason to fail server startup or a tool call.
 */
export function ensureBundledSkillsMaterialised(
  log?: (message: string) => void,
): Promise<string[]> {
  pending ??= materialiseBundledSkills({
    sourceDir: bundledSkillsDir(),
    root: skillFilesRoot(),
    log,
  }).catch((error: unknown) => {
    log?.(`[skills] bundled skill materialisation failed: ${
      error instanceof Error ? error.message : String(error)}`);
    return [];
  });
  return pending;
}

/** Test seam: drop the memoised run so a verify can exercise a fresh process. */
export function resetBundledSkillsMaterialisation(): void {
  pending = null;
}
