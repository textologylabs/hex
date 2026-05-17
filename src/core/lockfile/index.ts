import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { z } from 'zod';
import { VERSION } from '../../brand/splash.js';
import type { ChildRef } from '../manifest/types.js';
import type { Answers } from '../prompts/types.js';
import type { ResolvedRecipe } from '../recipe/resolve.js';
import type { ComponentBundle } from '../sources/file-source.js';
import {
  LOCKFILE_SCHEMA_VERSION,
  type LockArtifact,
  type LockChild,
  type lockFileEntrySchema,
  lockfileSchema,
  type sourceSpecSchema,
} from './schema.js';

/**
 * The lockfile module (M10.1, M10.2) — `.hex/lockfile.yaml`, the file
 * that makes a generated app self-describing.
 *
 * In an *authored* component, `.hex/manifest.yaml` describes *how to
 * scaffold*. In a *generated* app, `.hex/lockfile.yaml` describes *what
 * was scaffolded* — same folder, mirrored roles (`idea.md`, "Component
 * repo layout"). M10.1 defined the schema; M10.2 (here) builds and
 * writes the file at the end of `hex new`; reading it back and verifying
 * integrity is M10.3.
 */

export { LOCKFILE_SCHEMA_VERSION, SHA256_RE, lockfileSchema } from './schema.js';
export type { LockArtifact, LockChild } from './schema.js';

/** How to re-fetch an artifact during an upgrade. */
export type SourceSpec = z.infer<typeof sourceSpecSchema>;

/** One rendered file and the sha256 of its bytes at generation time. */
export type LockFileEntry = z.infer<typeof lockFileEntrySchema>;

/** The whole `.hex/lockfile.yaml` document. */
export type Lockfile = z.infer<typeof lockfileSchema>;

/** Errors raised reading, writing, or validating a lockfile. */
export class LockfileError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'LockfileError';
  }
}

/** `.hex/` — the same folder name authored components use for their manifest. */
export const LOCKFILE_DIRNAME = '.hex';
export const LOCKFILE_FILENAME = 'lockfile.yaml';
export const LOCKFILE_REL_PATH = `${LOCKFILE_DIRNAME}/${LOCKFILE_FILENAME}`;

/**
 * Top-level directories never folded into the file-hash table. `.hex/`
 * holds Hex's own metadata (this lockfile, the M4 checklist) — hashing
 * it would make the table describe itself. `.git/` and `node_modules/`
 * are not part of the rendered artifact either.
 */
const SKIP_DIRS = new Set([LOCKFILE_DIRNAME, '.git', 'node_modules']);

/** Everything `buildLockfile` needs to describe a completed render. */
export type BuildLockfileInput = {
  /** The root bundle — the recipe, or a standalone component. */
  bundle: ComponentBundle;
  /** The resolved recipe tree; absent for a standalone component. */
  resolved?: ResolvedRecipe;
  /** The full answers tree the render consumed. */
  answers: Answers;
  /** The generated app's root directory — walked to fill `files`. */
  outputDir: string;
  /** Override the render timestamp (test injection). */
  now?: Date;
};

/**
 * Assemble a `Lockfile` describing a finished render: the root artifact,
 * its composed children recorded recursively (a nested recipe carries
 * its own descendants), the answers tree, and a per-file sha256 table
 * hashed from the rendered tree on disk — post-hooks, post-render, so
 * hook renames/deletes are reflected faithfully.
 */
export async function buildLockfile(input: BuildLockfileInput): Promise<Lockfile> {
  const { bundle, resolved, answers, outputDir } = input;

  return {
    schema_version: LOCKFILE_SCHEMA_VERSION,
    hex_version: VERSION,
    generated_at: (input.now ?? new Date()).toISOString(),
    root: artifactOf(bundle),
    children: resolved ? lockChildrenOf(resolved) : [],
    answers,
    files: await hashTree(outputDir),
  };
}

/**
 * Map a resolved recipe's children to `LockChild` records, recursing
 * into any child that is itself a recipe so the whole composition tree
 * is captured. A leaf (component) child carries no `children` key.
 */
function lockChildrenOf(resolved: ResolvedRecipe): LockChild[] {
  return [...resolved.children.values()].map((child) => {
    const nested = child.resolved ? lockChildrenOf(child.resolved) : [];
    return {
      ...artifactOf(child.bundle, child.ref),
      key: child.key,
      stub: child.ref.stub === true,
      ...(nested.length > 0 ? { children: nested } : {}),
    };
  });
}

/**
 * Write a lockfile to `<outputDir>/.hex/lockfile.yaml`, creating `.hex/`
 * if needed. Validates against the schema first, so a buggy caller can
 * never persist a malformed file.
 */
export async function writeLockfile(outputDir: string, lockfile: Lockfile): Promise<string> {
  const parsed = lockfileSchema.safeParse(lockfile);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new LockfileError(`refusing to write malformed lockfile:\n${issues}`);
  }

  const dir = join(outputDir, LOCKFILE_DIRNAME);
  await mkdir(dir, { recursive: true });
  const path = join(dir, LOCKFILE_FILENAME);
  await writeFile(path, stringifyYaml(parsed.data), 'utf8');
  return path;
}

/** A lockfile loaded from disk, with where it was found. */
export type LoadedLockfile = {
  /** Filesystem path to the `.hex/lockfile.yaml` file. */
  path: string;
  /** Directory holding the `.hex/` folder — the generated app root. */
  rootDir: string;
  lockfile: Lockfile;
};

/**
 * Walk upward from `startDir` looking for `.hex/lockfile.yaml`, stopping
 * at the filesystem root. Returns null if none is found.
 *
 * Same convention as `readChecklistUpward` — lets `hex doctor` (M10.4)
 * and the M11 upgrade engine work from any subdirectory of a generated
 * app, the way `git` / `npm` find their roots.
 */
export async function readLockfileUpward(startDir: string): Promise<LoadedLockfile | null> {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, LOCKFILE_DIRNAME, LOCKFILE_FILENAME);
    if (await isFile(candidate)) {
      return { path: candidate, rootDir: dir, lockfile: await readLockfileFile(candidate) };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The outcome of an integrity check. `modified` / `missing` / `added`
 * are POSIX-relative paths; `ok` is true only when all three are empty.
 */
export type LockfileIntegrity = {
  /** True when nothing has diverged from the lockfile's record. */
  ok: boolean;
  /** Recorded files whose current bytes differ from the lockfile. */
  modified: string[];
  /** Recorded files no longer present in the tree. */
  missing: string[];
  /** Files present in the tree but absent from the lockfile. */
  added: string[];
};

/**
 * Compare a generated app's current tree against a lockfile's recorded
 * hashes. **Never throws** — it returns the divergence so the caller
 * (M11's pristine reconstruction, `hex doctor`) decides whether to
 * merge, warn, or proceed.
 *
 * The walk excludes `.hex/`, `.git/`, and `node_modules/`, matching
 * `buildLockfile` exactly so the comparison stays apples-to-apples.
 */
export async function checkLockfileIntegrity(
  rootDir: string,
  lockfile: Lockfile,
): Promise<LockfileIntegrity> {
  const current = new Map((await hashTree(rootDir)).map((e) => [e.path, e.sha256]));
  const recorded = new Map(lockfile.files.map((e) => [e.path, e.sha256]));

  const modified: string[] = [];
  const missing: string[] = [];
  for (const [path, sha] of recorded) {
    const cur = current.get(path);
    if (cur === undefined) missing.push(path);
    else if (cur !== sha) modified.push(path);
  }
  const added: string[] = [];
  for (const path of current.keys()) {
    if (!recorded.has(path)) added.push(path);
  }
  modified.sort();
  missing.sort();
  added.sort();
  return {
    ok: modified.length === 0 && missing.length === 0 && added.length === 0,
    modified,
    missing,
    added,
  };
}

/** Read, version-check, and schema-validate a lockfile at a known path. */
async function readLockfileFile(path: string): Promise<Lockfile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new LockfileError(`cannot read lockfile: ${errMsg(err)}`, path);
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new LockfileError(`invalid YAML: ${errMsg(err)}`, path);
  }

  // Check the version *before* full schema validation: a future-version
  // file may use shapes this build's schema rejects, and a clear upgrade
  // hint beats a wall of schema issues.
  if (typeof data === 'object' && data !== null) {
    const version = (data as { schema_version?: unknown }).schema_version;
    if (typeof version === 'number' && version > LOCKFILE_SCHEMA_VERSION) {
      throw new LockfileError(
        `lockfile schema_version ${version} is newer than this build of Hex supports ` +
          `(max ${LOCKFILE_SCHEMA_VERSION}) — upgrade Hex to read it`,
        path,
      );
    }
  }

  const result = lockfileSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new LockfileError(`schema validation failed:\n${issues}`, path);
  }
  return result.data;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Identity + source spec of one artifact (the root, or a child via `ref`). */
function artifactOf(bundle: ComponentBundle, ref?: ChildRef): LockArtifact {
  return {
    name: bundle.manifest.name,
    version: bundle.manifest.version,
    type: bundle.manifest.type,
    source: sourceSpecFor(bundle, ref),
  };
}

/**
 * Derive the source spec — *how to re-fetch this artifact*.
 *
 * A `git:` child reference carries the upstream coordinate verbatim, so
 * it is recorded exactly. Everything else — `file:` references, bare
 * `name`/`slot` references resolved through discovery, and the root
 * bundle — is recorded as the resolved local path it was loaded from.
 */
function sourceSpecFor(bundle: ComponentBundle, ref?: ChildRef): SourceSpec {
  if (ref?.kind === 'git') {
    return ref.ref ? { kind: 'git', url: ref.url, ref: ref.ref } : { kind: 'git', url: ref.url };
  }
  return { kind: 'file', path: bundle.rootPath };
}

/**
 * Walk a rendered tree and hash every file, sorted by POSIX path —
 * skipping `.hex/`, `.git/`, and `node_modules/`. Exported so the
 * upgrade engine can recompute a lockfile's `files` table after a merge.
 */
export async function hashTree(outputDir: string): Promise<LockFileEntry[]> {
  const entries: LockFileEntry[] = [];
  await walk(outputDir, outputDir, entries);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

async function walk(dir: string, root: string, out: LockFileEntry[]): Promise<void> {
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      await walk(join(dir, dirent.name), root, out);
    } else if (dirent.isFile()) {
      const abs = join(dir, dirent.name);
      out.push({
        path: relative(root, abs).split(sep).join('/'),
        sha256: createHash('sha256')
          .update(await readFile(abs))
          .digest('hex'),
      });
    }
    // symlinks / special files are intentionally skipped
  }
}
