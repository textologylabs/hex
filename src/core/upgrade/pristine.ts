import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LockChild, Lockfile, SourceSpec } from '../lockfile/index.js';
import type { ChildRef } from '../manifest/types.js';
import { renderRecipe } from '../recipe/render.js';
import type { ChildResolution, ResolvedRecipe } from '../recipe/resolve.js';
import { renderBundle } from '../render/engine.js';
import { type ComponentBundle, loadFromPath } from '../sources/file-source.js';
import { resolveGitSource } from '../sources/git-source.js';

/**
 * Pristine reconstruction (M11.1) — renders a lockfile back into a tree
 * (`idea.md` §1, "pristine-tree model").
 *
 * Given a lockfile, `reconstructPristine` re-fetches every locked
 * artifact from its recorded source, replays the stored answers through
 * the render engine, and writes the result into a temp directory.
 *
 * This is faithful *only* while each recorded source still holds the
 * version the lockfile names — true for `git:`/`catalogue:` specs, which
 * pin a ref, and for a `file:` path nobody has updated. It is therefore
 * how `pristine_new` is rendered (the caller supplies the target
 * template), and the **fallback** for `pristine_old` in apps generated
 * before Hex stored a baseline. The merge base otherwise comes from
 * `.hex/pristine/` — see `baseline.ts`, which explains why re-rendering
 * the base was not safe.
 *
 * The reconstruction deliberately does **not** re-resolve the recipe's
 * `composes:` block — that would pick up whatever versions discovery
 * sees *today*. It rebuilds the tree from the lockfile's recorded
 * children, so the output reproduces the historical render byte-for-byte
 * regardless of what has since been published. `checkLockfileIntegrity`
 * against the result returns clean when reconstruction is faithful.
 */

export class PristineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PristineError';
  }
}

export type ReconstructOptions = {
  /** Cache directory for git-source fetches. Forwarded to `resolveGitSource`. */
  cacheDir?: string;
  /**
   * Directory to render into. Must be empty / nonexistent. When omitted,
   * a fresh `mkdtemp` directory is created and returned.
   */
  targetDir?: string;
};

/**
 * Reconstruct `pristine_old` from a lockfile and return the path to the
 * rendered tree. Handles both archetypes — a standalone component and a
 * recipe with a (possibly nested) child tree — with no `if (recipe)`
 * branch leaking past the one dispatch below.
 */
export async function reconstructPristine(
  lockfile: Lockfile,
  opts: ReconstructOptions = {},
): Promise<string> {
  const target = opts.targetDir ?? (await mkdtemp(join(tmpdir(), 'hex-pristine-')));
  const rootBundle = await fetchBundle(lockfile.root.source, opts);

  if (lockfile.children.length === 0) {
    await renderBundle(rootBundle, target, lockfile.answers, { force: true });
    return target;
  }

  const resolved = await reconstructResolved(rootBundle, lockfile.children, opts);
  await renderRecipe(resolved, target, lockfile.answers, { force: true });
  return target;
}

/**
 * Rebuild a `ResolvedRecipe` from the lockfile's recorded children —
 * fetching each artifact from its locked source and recursing into
 * nested recipes. The synthesized `ChildRef` carries only what
 * `renderRecipe` reads back: the `stub` flag.
 */
async function reconstructResolved(
  recipeBundle: ComponentBundle,
  lockChildren: LockChild[],
  opts: ReconstructOptions,
): Promise<ResolvedRecipe> {
  const children = new Map<string, ChildResolution>();
  for (const child of lockChildren) {
    const bundle = await fetchBundle(child.source, opts);
    const resolution: ChildResolution = {
      key: child.key,
      ref: synthRef(bundle, child.stub),
      bundle,
    };
    if (child.children && child.children.length > 0) {
      resolution.resolved = await reconstructResolved(bundle, child.children, opts);
    }
    children.set(child.key, resolution);
  }
  return { recipeBundle, children };
}

/**
 * Synthesize the `ChildRef` `renderRecipe` needs. Resolution already
 * happened (it is encoded in the lockfile), so the only field the render
 * path reads is `stub`; `kind`/`path` are filled for type-completeness.
 */
function synthRef(bundle: ComponentBundle, stub: boolean): ChildRef {
  return { kind: 'file', path: bundle.rootPath, stub };
}

/** Fetch and load a bundle from a recorded source spec. */
async function fetchBundle(source: SourceSpec, opts: ReconstructOptions): Promise<ComponentBundle> {
  if (source.kind === 'file') {
    return loadFromPath(source.path, 'file');
  }
  if (source.kind === 'git') {
    const resolved = await resolveGitSource(
      { url: source.url, ref: source.ref },
      { cacheDir: opts.cacheDir },
    );
    return loadFromPath(resolved.localPath, 'git');
  }
  // Marketplace artifacts are not yet wired into `hex new`'s resolver,
  // so no lockfile written today records one. Fail loudly rather than
  // reconstruct something subtly wrong.
  throw new PristineError(
    `cannot reconstruct marketplace source "${source.name}" — not yet supported`,
  );
}
