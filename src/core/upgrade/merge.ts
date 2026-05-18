import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { type IMergeOptions, merge } from 'node-diff3';

/**
 * 3-way merge with git-style conflict markers (M11.4) — `idea.md` §1,
 * "conflict UX, git-style markers".
 *
 * The upgrade engine reconstructs two pristine trees — `pristine_old`
 * (what `hex new` produced) and `pristine_new` (the target version) —
 * and this module computes their diff and replays it onto the user's
 * working tree with a per-file 3-way merge. A clean hunk applies
 * silently; a genuine conflict is written in place with the standard
 * `<<<<<<< ======= >>>>>>>` markers every editor and `git diff`
 * understand, so the user resolves it exactly as they would a rebase.
 */

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeError';
  }
}

/**
 * Directories never merged: `.hex/` is Hex's own metadata (lockfile,
 * checklist, upgrade state), and `.git/` / `node_modules/` are not part
 * of the rendered artifact.
 */
const SKIP_DIRS = new Set(['.hex', '.git', 'node_modules']);

export type ThreeWayLabels = {
  /** Marker label for the user's side. */
  ours: string;
  /** Marker label for the incoming template side. */
  theirs: string;
};

export type ThreeWayMergeResult = {
  /** True when the merge produced no conflict. */
  clean: boolean;
  /** Merged text — carries `<<<<<<< ======= >>>>>>>` markers when not clean. */
  content: string;
};

/**
 * 3-way merge of a single file's text: `base` is the common ancestor,
 * `ours` the user's current content, `theirs` the incoming version.
 * Conflicts come back inline with git's default-style markers.
 */
export function threeWayMerge(
  base: string,
  ours: string,
  theirs: string,
  labels: ThreeWayLabels = { ours: 'your changes', theirs: 'incoming' },
): ThreeWayMergeResult {
  // `merge(a, o, b)` — a = ours, o = base, b = theirs. `label` is honoured
  // at runtime but absent from `merge`'s typed options (only `mergeDiff3`
  // declares it); widen via the cast. `merge` keeps git's default marker
  // style — no `|||||||` base section.
  const opts: IMergeOptions & { label: { a: string; b: string } } = {
    stringSeparator: '\n',
    label: { a: labels.ours, b: labels.theirs },
  };
  const result = merge(ours, base, theirs, opts as IMergeOptions);
  return { clean: !result.conflict, content: result.result.join('\n') };
}

export type MergeTreesInput = {
  /** `pristine_old` — the tree as first generated. */
  pristineOld: string;
  /** `pristine_new` — the tree at the target version. */
  pristineNew: string;
  /** The user's working tree — merged into, in place. */
  userTree: string;
  /** Marker label for the incoming side (e.g. `hex 2.0.0`). */
  theirsLabel?: string;
  /**
   * Triage callback for an orphan (edited file the template removed).
   * Absent → keep every orphan, the M11.7 default.
   */
  onOrphan?: (rel: string) => Promise<OrphanDecision>;
};

/**
 * Decision for an orphan — a file the template removed but the user has
 * edited. `keep` leaves the user's copy in place (the M11.7 default);
 * `delete` removes it. `hex upgrade` supplies this only under
 * `--prompt-on-orphans`; otherwise every orphan is kept.
 */
export type OrphanDecision = 'keep' | 'delete';

export type MergeResult = {
  /** True when no file conflicted. */
  clean: boolean;
  /** Files newly written into the user tree. */
  added: string[];
  /** Files removed from the user tree. */
  deleted: string[];
  /**
   * Edited files the template removed, kept in place (M11.7). Not an
   * error — surfaced so the upgrade can warn and record them.
   */
  orphaned: string[];
  /** Files updated by a clean 3-way merge (or a clean take-theirs). */
  merged: string[];
  /** Files written with conflict markers — the user must resolve these. */
  conflicted: string[];
  /** Files the template did not change — left untouched. */
  unchanged: string[];
};

/**
 * Diff `pristine_old` against `pristine_new` and replay the change onto
 * the user's working tree, file by file:
 *
 * - **template changed a file** — 3-way merge it against the user's copy;
 *   if the user never touched it the new content lands cleanly.
 * - **template added a file** — write it; if the user already created
 *   one at that path, 3-way merge against an empty base.
 * - **template removed a file** — delete it when the user left it
 *   untouched; when they edited it, the file is an *orphan* — kept in
 *   place by default (M11.7) and surfaced in `result.orphaned`, unless
 *   an `onOrphan` callback elects to delete it.
 *
 * `.hex/`, `.git/`, and `node_modules/` are never touched. The merge is
 * applied in place; conflicted files carry markers and are listed in the
 * result so the caller can persist upgrade state and stop.
 */
export async function mergeTrees(input: MergeTreesInput): Promise<MergeResult> {
  const labels: ThreeWayLabels = {
    ours: 'your changes',
    theirs: input.theirsLabel ?? 'incoming',
  };
  const oldFiles = await collectFiles(input.pristineOld);
  const newFiles = await collectFiles(input.pristineNew);

  const result: MergeResult = {
    clean: true,
    added: [],
    deleted: [],
    orphaned: [],
    merged: [],
    conflicted: [],
    unchanged: [],
  };
  const decideOrphan = input.onOrphan ?? (async () => 'keep' as const);

  for (const rel of [...new Set([...oldFiles, ...newFiles])].sort()) {
    const oldContent = oldFiles.has(rel)
      ? await readFile(join(input.pristineOld, rel), 'utf8')
      : null;
    const newContent = newFiles.has(rel)
      ? await readFile(join(input.pristineNew, rel), 'utf8')
      : null;
    const userContent = await readMaybe(join(input.userTree, rel));

    if (oldContent !== null && newContent !== null) {
      await mergeChangedFile(
        input.userTree,
        rel,
        oldContent,
        newContent,
        userContent,
        labels,
        result,
      );
    } else if (newContent !== null) {
      await mergeAddedFile(input.userTree, rel, newContent, userContent, labels, result);
    } else if (oldContent !== null) {
      await mergeRemovedFile(input.userTree, rel, oldContent, userContent, decideOrphan, result);
    }
  }

  result.clean = result.conflicted.length === 0;
  return result;
}

/** A file present in both pristine trees — the template may have changed it. */
async function mergeChangedFile(
  userTree: string,
  rel: string,
  oldContent: string,
  newContent: string,
  userContent: string | null,
  labels: ThreeWayLabels,
  result: MergeResult,
): Promise<void> {
  if (oldContent === newContent) {
    result.unchanged.push(rel);
    return;
  }
  if (userContent === null) {
    // User deleted a file the template now updates — restore the new copy.
    await writeUserFile(userTree, rel, newContent);
    result.added.push(rel);
    return;
  }
  if (userContent === oldContent) {
    // User never edited it — take the new version cleanly.
    await writeUserFile(userTree, rel, newContent);
    result.merged.push(rel);
    return;
  }
  const { clean, content } = threeWayMerge(oldContent, userContent, newContent, labels);
  await writeUserFile(userTree, rel, content);
  (clean ? result.merged : result.conflicted).push(rel);
}

/** A file the template added — absent from `pristine_old`. */
async function mergeAddedFile(
  userTree: string,
  rel: string,
  newContent: string,
  userContent: string | null,
  labels: ThreeWayLabels,
  result: MergeResult,
): Promise<void> {
  if (userContent === null) {
    await writeUserFile(userTree, rel, newContent);
    result.added.push(rel);
    return;
  }
  if (userContent === newContent) {
    result.unchanged.push(rel);
    return;
  }
  // The user already created a file at this path — merge against an
  // empty base so divergent content surfaces as an add/add conflict.
  const { clean, content } = threeWayMerge('', userContent, newContent, labels);
  await writeUserFile(userTree, rel, content);
  (clean ? result.merged : result.conflicted).push(rel);
}

/** A file the template removed — present in `pristine_old`, gone from new. */
async function mergeRemovedFile(
  userTree: string,
  rel: string,
  oldContent: string,
  userContent: string | null,
  decideOrphan: (rel: string) => Promise<OrphanDecision>,
  result: MergeResult,
): Promise<void> {
  if (userContent === null) return;
  if (userContent === oldContent) {
    // User never touched it — remove it with the template.
    await rm(join(userTree, rel), { force: true });
    result.deleted.push(rel);
    return;
  }
  // The user edited a file the template removed — an orphan. Kept in
  // place by default; an `onOrphan` callback may elect to delete it.
  if ((await decideOrphan(rel)) === 'delete') {
    await rm(join(userTree, rel), { force: true });
    result.deleted.push(rel);
    return;
  }
  result.orphaned.push(rel);
}

/** Collect every file path under `dir`, relative + POSIX, skipping metadata dirs. */
async function collectFiles(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(current, entry.name));
      } else if (entry.isFile()) {
        out.add(relative(dir, join(current, entry.name)).split(sep).join('/'));
      }
    }
  }
  await walk(dir);
  return out;
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function writeUserFile(userTree: string, rel: string, content: string): Promise<void> {
  const abs = join(userTree, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}
