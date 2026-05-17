import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type Lockfile,
  checkLockfileIntegrity,
  hashTree,
  readLockfileUpward,
  writeLockfile,
} from '../lockfile/index.js';
import { type MigrationStep, walkUpgradeChain } from './chain.js';
import { type MergeResult, mergeTrees } from './merge.js';
import { applyMigration } from './migration.js';
import {
  UPGRADE_STATE_SCHEMA_VERSION,
  clearUpgradeState,
  readUpgradeState,
  writeUpgradeState,
} from './state.js';

/**
 * The upgrade orchestrator (M11.5) — ties M11.1–M11.4 into the
 * `hex upgrade` flow.
 *
 * `runUpgrade` walks the version chain, renders + migrates each hop, and
 * 3-way merges the result onto the user's tree. A clean merge rewrites
 * the lockfile and finishes; a conflicting one writes `.hex/upgrade-state.yaml`
 * and stops. `continueUpgrade` finalises a paused upgrade once the user
 * has resolved the markers; `abortUpgrade` rolls the tree back from the
 * snapshot taken before the merge.
 *
 * *Where versions come from* and *how a version is rendered* arrive as an
 * injected `UpgradeEnvironment` — the orchestration stays agnostic to
 * file / git / marketplace sourcing, and the `hex upgrade` command wires
 * a concrete environment.
 */

export class UpgradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeError';
  }
}

/** Supplies the version list and per-version rendering for an upgrade. */
export type UpgradeEnvironment = {
  /** Every published version of the app's template, for the chain. */
  availableVersions: string[];
  /** Render a version's pristine tree (stored answers replayed); returns a temp path. */
  pristineFor: (version: string) => Promise<string>;
  /**
   * The `.hex/migrations/` directory shipped by version `to`, or null
   * when that version ships none. Absent entirely → no hop has migrations.
   */
  migrationsDirFor?: (toVersion: string) => Promise<string | null>;
};

export type RunUpgradeInput = {
  /** A directory at or below the generated app's root. */
  appRoot: string;
  /** The version to upgrade to. */
  target: string;
  environment: UpgradeEnvironment;
};

/** The result of an upgrade attempt. */
export type UpgradeOutcome =
  | { status: 'clean'; from: string; to: string; merge: MergeResult }
  | { status: 'conflict'; from: string; to: string; merge: MergeResult; conflicts: string[] };

const BACKUP_DIRNAME = 'upgrade-backup';
/** Directories left out of the merge, the snapshot, and the rollback sweep. */
const PROTECTED = new Set(['.hex', '.git', 'node_modules']);

/**
 * Run an upgrade end to end. Reconstructs `pristine_old`, walks the
 * chain to `pristine_new`, 3-way merges onto the working tree, and
 * either finalises (clean) or persists upgrade state (conflict).
 */
export async function runUpgrade(input: RunUpgradeInput): Promise<UpgradeOutcome> {
  const loaded = await readLockfileUpward(input.appRoot);
  if (!loaded) {
    throw new UpgradeError(`no .hex/lockfile.yaml found at or above ${input.appRoot}`);
  }
  const root = loaded.rootDir;
  if (await readUpgradeState(root)) {
    throw new UpgradeError(
      'an upgrade is already in progress — run `hex upgrade --continue` or `hex upgrade --abort`',
    );
  }
  const from = loaded.lockfile.root.version;

  // Snapshot the working tree first, so `--abort` can roll back exactly.
  await snapshotTree(root);

  // Files the user has edited since generation — `delete_if_unmodified`
  // migrations need this to decide whether to keep an edited copy.
  const integrity = await checkLockfileIntegrity(root, loaded.lockfile);
  const userModified = new Set(integrity.modified);

  const { pristineOld, pristineNew } = await walkUpgradeChain({
    from,
    to: input.target,
    available: input.environment.availableVersions,
    renderVersion: input.environment.pristineFor,
    runMigration: (step) => migrateHop(step, input.environment, userModified),
  });

  try {
    const merge = await mergeTrees({
      pristineOld,
      pristineNew,
      userTree: root,
      theirsLabel: `hex ${input.target}`,
    });

    if (merge.clean) {
      await finalizeLockfile(root, loaded.lockfile, input.target);
      await dropSnapshot(root);
      return { status: 'clean', from, to: input.target, merge };
    }

    await writeUpgradeState(root, {
      schema_version: UPGRADE_STATE_SCHEMA_VERSION,
      from,
      to: input.target,
      conflicts: merge.conflicted,
    });
    return { status: 'conflict', from, to: input.target, merge, conflicts: merge.conflicted };
  } finally {
    await rm(pristineOld, { recursive: true, force: true });
    await rm(pristineNew, { recursive: true, force: true });
  }
}

/** The result of finishing or discarding a paused upgrade. */
export type ResumeOutcome = { from: string; to: string };

/**
 * Finalise a paused upgrade. Refuses while any conflicted file still
 * carries conflict markers — the user must resolve them first. On
 * success it rewrites the lockfile at the new version and clears the
 * upgrade state + snapshot.
 */
export async function continueUpgrade(appRoot: string): Promise<ResumeOutcome> {
  const loaded = await readLockfileUpward(appRoot);
  if (!loaded) throw new UpgradeError(`no .hex/lockfile.yaml found at or above ${appRoot}`);
  const root = loaded.rootDir;

  const state = await readUpgradeState(root);
  if (!state) throw new UpgradeError('no upgrade in progress — nothing to continue');

  const unresolved: string[] = [];
  for (const rel of state.conflicts) {
    const content = await readFile(join(root, rel), 'utf8').catch(() => '');
    if (hasConflictMarkers(content)) unresolved.push(rel);
  }
  if (unresolved.length > 0) {
    const list = unresolved.map((f) => `  ${f}`).join('\n');
    throw new UpgradeError(
      `${unresolved.length} file(s) still have unresolved conflict markers:\n${list}`,
    );
  }

  await finalizeLockfile(root, loaded.lockfile, state.to);
  await clearUpgradeState(root);
  await dropSnapshot(root);
  return { from: state.from, to: state.to };
}

/**
 * Discard a paused upgrade: roll the working tree back to the snapshot
 * taken before the merge, then clear the upgrade state + snapshot.
 */
export async function abortUpgrade(appRoot: string): Promise<ResumeOutcome> {
  const loaded = await readLockfileUpward(appRoot);
  if (!loaded) throw new UpgradeError(`no .hex/lockfile.yaml found at or above ${appRoot}`);
  const root = loaded.rootDir;

  const state = await readUpgradeState(root);
  if (!state) throw new UpgradeError('no upgrade in progress — nothing to abort');

  await restoreSnapshot(root);
  await clearUpgradeState(root);
  await dropSnapshot(root);
  return { from: state.from, to: state.to };
}

/** Run one hop's migration against its pristine tree, if the version ships one. */
async function migrateHop(
  step: MigrationStep,
  env: UpgradeEnvironment,
  userModified: Set<string>,
): Promise<void> {
  if (!env.migrationsDirFor) return;
  const dir = await env.migrationsDirFor(step.to);
  if (!dir) return;
  await applyMigration(dir, step.from, step.to, {
    treeDir: step.toTree,
    isUserModified: (p) => userModified.has(p),
  });
}

/** Rewrite the lockfile at `toVersion`, re-hashing the merged tree. */
async function finalizeLockfile(
  root: string,
  lockfile: Lockfile,
  toVersion: string,
): Promise<void> {
  const updated: Lockfile = {
    ...lockfile,
    root: { ...lockfile.root, version: toVersion },
    files: await hashTree(root),
  };
  await writeLockfile(root, updated);
}

/** True when `content` carries git-style conflict markers. */
function hasConflictMarkers(content: string): boolean {
  return /^<{7} /m.test(content) || /^>{7} /m.test(content);
}

/**
 * Copy the working tree (minus protected dirs) into `.hex/upgrade-backup/`.
 * Copied file by file rather than via a single `cp` — the backup lives
 * under `.hex/`, and `cp` refuses a destination inside its own source.
 */
async function snapshotTree(root: string): Promise<void> {
  const backup = join(root, '.hex', BACKUP_DIRNAME);
  await rm(backup, { recursive: true, force: true });
  for (const rel of await collectTreeFiles(root)) {
    const dest = join(backup, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(root, rel), dest);
  }
}

/** Restore the working tree from the snapshot, dropping any merge changes. */
async function restoreSnapshot(root: string): Promise<void> {
  const backup = join(root, '.hex', BACKUP_DIRNAME);
  for (const entry of await readdir(root)) {
    if (PROTECTED.has(entry)) continue;
    await rm(join(root, entry), { recursive: true, force: true });
  }
  for (const rel of await collectTreeFiles(backup)) {
    const dest = join(root, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(backup, rel), dest);
  }
}

/** Relative file paths under `dir`, skipping the protected top-level dirs. */
async function collectTreeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (prefix === '' && PROTECTED.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(dir, '');
  return out;
}

async function dropSnapshot(root: string): Promise<void> {
  await rm(join(root, '.hex', BACKUP_DIRNAME), { recursive: true, force: true });
}
