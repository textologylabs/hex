import { existsSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTreeInto } from './tree.js';

/**
 * The pristine baseline — `.hex/pristine/`, a verbatim copy of the tree
 * as the template rendered it at the app's locked version.
 *
 * `hex upgrade` 3-way merges `base = pristine_old` against
 * `theirs = pristine_new`. The base used to be *reconstructed* on the
 * fly: re-render the template found at the path the lockfile recorded.
 * That silently assumed the path still held the locked version's
 * content, and nothing enforced it:
 *
 *   - Update the template in place (`git pull`) and the base re-renders
 *     from the *new* version. base == theirs, so every template change
 *     looks like it is already applied and is dropped — the upgrade
 *     reports success and changes nothing.
 *   - Keep versions in side-by-side directories and the lockfile's
 *     source is never advanced past the *original* template, so from the
 *     second upgrade on the base is the wrong version — manufacturing
 *     conflicts in files nobody touched.
 *
 * Storing the tree removes the guess: the base is what Hex actually
 * wrote, not what it hopes the template still says. `hex new` captures
 * it, every successful upgrade refreshes it, and it is meant to be
 * committed alongside the lockfile so a fresh clone can upgrade too.
 *
 * A staging directory (`.hex/pristine.next/`) holds the target version's
 * tree while an upgrade is in flight, so a run that pauses on conflicts
 * can still finish (`--continue`) or roll back (`--abort`) long after the
 * temp trees are gone.
 */

export const BASELINE_DIRNAME = 'pristine';
export const BASELINE_STAGING_DIRNAME = 'pristine.next';
export const BASELINE_REL_PATH = `.hex/${BASELINE_DIRNAME}`;

const baselineDir = (root: string): string => join(root, '.hex', BASELINE_DIRNAME);
const stagingDir = (root: string): string => join(root, '.hex', BASELINE_STAGING_DIRNAME);

/** True when the app carries a stored baseline. */
export function hasBaseline(root: string): boolean {
  return existsSync(baselineDir(root));
}

/**
 * Record `tree` as the app's pristine baseline, replacing any existing
 * one. Defaults to the app root itself — at the end of `hex new` the
 * working tree *is* the pristine tree.
 */
export async function captureBaseline(root: string, tree: string = root): Promise<void> {
  const dir = baselineDir(root);
  await rm(dir, { recursive: true, force: true });
  await copyTreeInto(tree, dir);
}

/** Hold the target version's pristine tree, pending a successful finish. */
export async function stageBaseline(root: string, tree: string): Promise<void> {
  const dir = stagingDir(root);
  await rm(dir, { recursive: true, force: true });
  await copyTreeInto(tree, dir);
}

/** Promote the staged tree — the upgrade landed. No-op when nothing is staged. */
export async function commitBaseline(root: string): Promise<void> {
  const staged = stagingDir(root);
  if (!existsSync(staged)) return;
  const dir = baselineDir(root);
  await rm(dir, { recursive: true, force: true });
  await rename(staged, dir);
}

/** Drop the staged tree — the upgrade was aborted. */
export async function discardBaseline(root: string): Promise<void> {
  await rm(stagingDir(root), { recursive: true, force: true });
}

/**
 * Copy the baseline into a fresh temp directory and return its path, or
 * null when the app has none (generated before Hex stored one).
 *
 * Always a copy: the upgrade engine mutates the trees it is handed —
 * migrations rewrite them — and deletes them when it finishes. It must
 * never be pointed at the stored baseline itself.
 */
export async function materializeBaseline(root: string): Promise<string | null> {
  if (!hasBaseline(root)) return null;
  const target = await mkdtemp(join(tmpdir(), 'hex-baseline-'));
  await copyTreeInto(baselineDir(root), target);
  return target;
}
