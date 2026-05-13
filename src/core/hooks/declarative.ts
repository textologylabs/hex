import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ignore from 'ignore';
import type { PostRenderHook } from '../manifest/types.js';
import { evalWhen } from '../prompts/expr.js';
import type { Answers } from '../prompts/types.js';

export class HookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookError';
  }
}

export type HookResult = {
  renamed: Array<{ from: string; to: string }>;
  deleted: string[];
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export type RunHooksOptions = {
  /** When true, rename hooks may overwrite an existing target. */
  force?: boolean;
};

/**
 * Run declarative post-render hooks against an output tree.
 *
 * Hooks operate on paths relative to the output directory and run in the
 * order declared. The caller passes the list of files emitted by the
 * render step so glob-based deletes can be evaluated against the live
 * tree without re-walking the filesystem.
 *
 * Each hook's `when:` expression is evaluated against the same answers
 * tree the prompts and include rules saw. Hooks with a falsy `when:` are
 * silently skipped.
 *
 * `force` is propagated from the render call: when true, rename hooks
 * may replace an existing target rather than erroring out.
 */
export async function runPostRenderHooks(
  outputPath: string,
  hooks: PostRenderHook[],
  answers: Answers,
  writtenFiles: string[],
  opts: RunHooksOptions = {},
): Promise<HookResult> {
  const live = new Set(writtenFiles);
  const result: HookResult = { renamed: [], deleted: [] };
  const force = opts.force ?? false;

  for (const hook of hooks) {
    if ('rename' in hook) {
      await applyRename(hook.rename, outputPath, answers, live, result, force);
    } else if ('delete' in hook) {
      await applyDelete(hook.delete, outputPath, answers, live, result);
    }
    // JS hooks ({ js: ... }) are handled by the sandbox pipeline (M7.4),
    // not by the declarative runner — skip them here.
  }

  return result;
}

async function applyRename(
  rule: { from: string; to: string; when?: string },
  outputPath: string,
  answers: Answers,
  live: Set<string>,
  result: HookResult,
  force: boolean,
): Promise<void> {
  if (rule.when && !evalWhen(rule.when, answers)) return;
  const fromAbs = join(outputPath, rule.from);
  const toAbs = join(outputPath, rule.to);
  if (!(await pathExists(fromAbs))) {
    throw new HookError(`rename: source not found in output tree: ${rule.from}`);
  }
  if (await pathExists(toAbs)) {
    if (!force) {
      throw new HookError(`rename: target already exists: ${rule.to}`);
    }
    await rm(toAbs, { force: true, recursive: true });
  }
  await mkdir(dirname(toAbs), { recursive: true });
  await rename(fromAbs, toAbs);
  live.delete(rule.from);
  live.add(rule.to);
  result.renamed.push({ from: rule.from, to: rule.to });
}

async function applyDelete(
  rule: ({ path: string } | { glob: string }) & { when?: string },
  outputPath: string,
  answers: Answers,
  live: Set<string>,
  result: HookResult,
): Promise<void> {
  if (rule.when && !evalWhen(rule.when, answers)) return;

  if ('path' in rule) {
    const abs = join(outputPath, rule.path);
    if (!(await pathExists(abs))) {
      throw new HookError(`delete: target not found in output tree: ${rule.path}`);
    }
    await rm(abs, { force: true, recursive: true });
    live.delete(rule.path);
    result.deleted.push(rule.path);
    await pruneEmptyAncestors(outputPath, rule.path);
    return;
  }

  const matcher = ignore().add(rule.glob);
  const matches = [...live].filter((f) => matcher.ignores(f));
  for (const m of matches) {
    await rm(join(outputPath, m), { force: true });
    live.delete(m);
    result.deleted.push(m);
  }
  // After all glob matches have been removed, sweep any now-empty
  // ancestor directories. Walking deepest-first means we remove
  // children before their parents, so a fully-gutted subtree
  // collapses cleanly back to the first non-empty ancestor.
  for (const m of matches) {
    await pruneEmptyAncestors(outputPath, m);
  }
}

/**
 * Walk up from `relativePath`'s directory and remove any directory
 * that is now empty, stopping at the output root or the first
 * non-empty ancestor. Errors (missing dirs, races) are swallowed —
 * the caller has already done the destructive work; pruning is
 * best-effort cleanup.
 */
async function pruneEmptyAncestors(outputPath: string, relativePath: string): Promise<void> {
  let rel = dirname(relativePath);
  while (rel && rel !== '.' && rel !== '/') {
    const abs = join(outputPath, rel);
    try {
      const entries = await readdir(abs);
      if (entries.length > 0) return;
      await rmdir(abs);
    } catch {
      return;
    }
    rel = dirname(rel);
  }
}
