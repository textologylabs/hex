import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { z } from 'zod';
import { VERSION } from '../../brand/splash.js';
import type { ChildRef } from '../manifest/types.js';
import type { Cicd, Deploy } from '../manifest/types.js';
import type { Answers } from '../prompts/types.js';
import type { ResolvedRecipe } from '../recipe/resolve.js';
import { looksBinary } from '../render/engine.js';
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

  const deploy: Deploy | undefined = bundle.manifest.deploy;
  const cicd: Cicd | undefined = bundle.manifest.cicd;

  return {
    schema_version: LOCKFILE_SCHEMA_VERSION,
    hex_version: VERSION,
    generated_at: (input.now ?? new Date()).toISOString(),
    root: artifactOf(bundle),
    children: resolved ? lockChildrenOf(resolved) : [],
    answers,
    files: await hashTree(outputDir),
    ...(deploy ? { deploy } : {}),
    ...(cicd ? { cicd } : {}),
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
 * The outcome of an integrity check. All lists are POSIX-relative
 * paths; `ok` is true only when `modified`/`missing`/`added` are empty
 * (`eolOnly` divergence is tolerated — see below).
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
  /**
   * A5b: recorded files whose ONLY divergence is line endings (a CRLF
   * checkout of an LF render — the Windows default). Detected only when
   * a `referenceTree` is supplied; excluded from `modified` and from
   * the `ok` verdict, because a line-ending flip is the checkout's
   * doing, not an edit.
   */
  eolOnly: string[];
};

/**
 * Compare a generated app's current tree against a lockfile's recorded
 * hashes. **Never throws** — it returns the divergence so the caller
 * (M11's pristine reconstruction, `hex doctor`) decides whether to
 * merge, warn, or proceed.
 *
 * The walk excludes `.hex/`, `.git/`, and `node_modules/`, matching
 * `buildLockfile` exactly so the comparison stays apples-to-apples.
 *
 * `opts.referenceTree` — a directory holding the template-side BYTES
 * the lockfile's hashes were built from (adopt: the shadow render;
 * doctor/upgrade: `.hex/pristine/`). When given, each raw-hash mismatch
 * is re-examined: both sides read, binaries skipped, and files equal
 * after `\r\n`→`\n` normalisation are demoted to `eolOnly`. Without it,
 * behaviour is byte-identical to the raw comparison.
 */
export async function checkLockfileIntegrity(
  rootDir: string,
  lockfile: Lockfile,
  opts: { referenceTree?: string } = {},
): Promise<LockfileIntegrity> {
  const current = new Map((await hashTree(rootDir)).map((e) => [e.path, e.sha256]));
  const recorded = new Map(lockfile.files.map((e) => [e.path, e.sha256]));

  let modified: string[] = [];
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

  const eolOnly: string[] = [];
  if (opts.referenceTree !== undefined && modified.length > 0) {
    const stillModified: string[] = [];
    for (const path of modified) {
      if (await differsOnlyByEol(join(rootDir, path), join(opts.referenceTree, path))) {
        eolOnly.push(path);
      } else {
        stillModified.push(path);
      }
    }
    modified = stillModified;
  }

  modified.sort();
  missing.sort();
  added.sort();
  eolOnly.sort();
  return {
    ok: modified.length === 0 && missing.length === 0 && added.length === 0,
    modified,
    missing,
    added,
    eolOnly,
  };
}

/**
 * True when two files hold identical bytes after `\r\n`→`\n`
 * normalisation — and are genuinely text (binaries are never
 * normalised; a `0D 0A` byte pair in a PNG is data, not a newline).
 * Any read failure (e.g. the reference lacks the file) means "no".
 */
async function differsOnlyByEol(filePath: string, referencePath: string): Promise<boolean> {
  let a: Buffer;
  let b: Buffer;
  try {
    a = await readFile(filePath);
    b = await readFile(referencePath);
  } catch {
    return false;
  }
  if (looksBinary(a) || looksBinary(b)) return false;
  return normaliseEol(a).equals(normaliseEol(b));
}

/** Drop every `\r` that immediately precedes a `\n`. */
function normaliseEol(buf: Buffer): Buffer {
  if (!buf.includes(0x0d)) return buf;
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[n++] = buf[i] as number;
  }
  return out.subarray(0, n);
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
 * it is recorded exactly. A bundle that was resolved through a catalogue
 * (M13.4) carries its catalogue coordinate in `bundle.catalogueSource`
 * and is recorded as a `kind: 'catalogue'` spec — the underlying
 * package's git URL stays in the catalogue's `marketplace.yaml` rather
 * than being copied into every lockfile. Everything else — `file:`
 * references, bare `name`/`slot` references resolved through discovery,
 * and the root bundle without a catalogue marker — is recorded as the
 * resolved local path it was loaded from.
 */
function sourceSpecFor(bundle: ComponentBundle, ref?: ChildRef): SourceSpec {
  if (ref?.kind === 'git') {
    return ref.ref ? { kind: 'git', url: ref.url, ref: ref.ref } : { kind: 'git', url: ref.url };
  }
  if (bundle.catalogueSource) {
    const cs = bundle.catalogueSource;
    return {
      kind: 'catalogue',
      catalogue_url: cs.catalogueUrl,
      namespace: cs.namespace,
      name: cs.packageName,
      ...(cs.catalogueRef !== undefined ? { catalogue_ref: cs.catalogueRef } : {}),
    };
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

/**
 * A5b: `hashTree` variant for CROSS-TREE COMPARISON ONLY — text files
 * are `\r\n`→`\n` normalised before hashing so trees that differ only
 * by checkout line endings hash identically. NEVER persist these
 * digests: the lockfile's contract is "sha256 of the bytes as Hex
 * rendered them", and this deliberately isn't that.
 */
export async function hashTreeForComparison(outputDir: string): Promise<LockFileEntry[]> {
  const entries: LockFileEntry[] = [];
  await walk(outputDir, outputDir, entries, (buf) => (looksBinary(buf) ? buf : normaliseEol(buf)));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

async function walk(
  dir: string,
  root: string,
  out: LockFileEntry[],
  transform?: (buf: Buffer) => Buffer,
): Promise<void> {
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      await walk(join(dir, dirent.name), root, out, transform);
    } else if (dirent.isFile()) {
      const abs = join(dir, dirent.name);
      const raw = await readFile(abs);
      out.push({
        path: relative(root, abs).split(sep).join('/'),
        sha256: createHash('sha256')
          .update(transform ? transform(raw) : raw)
          .digest('hex'),
      });
    }
    // symlinks / special files are intentionally skipped
  }
}
