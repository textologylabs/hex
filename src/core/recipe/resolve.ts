import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { HexConfig } from '../config/types.js';
import { type TemplateEntry, discoverTemplates } from '../discovery/index.js';
import type { ChildRef } from '../manifest/types.js';
import { type ComponentBundle, loadFromPath } from '../sources/file-source.js';
import { resolveGitSource } from '../sources/git-source.js';
import { validateContracts, versionSatisfies } from './contracts.js';

export class RecipeResolutionError extends Error {
  constructor(
    message: string,
    public readonly key: string,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = 'RecipeResolutionError';
  }
}

export type ChildResolution = {
  /** Composes-block key (kebab-case identifier on the recipe). */
  key: string;
  /** Original parsed reference from the recipe manifest. */
  ref: ChildRef;
  /** Loaded child bundle (component or recipe). */
  bundle: ComponentBundle;
  /**
   * When the child is itself a recipe, the recursively-resolved tree.
   * Absent for components. Tree-shaped — graph cycles are rejected at
   * resolution time.
   */
  resolved?: ResolvedRecipe;
};

export type ResolvedRecipe = {
  recipeBundle: ComponentBundle;
  children: Map<string, ChildResolution>;
};

export type ResolveRecipeOpts = {
  /** Source-roots config; required for bare-name resolution. */
  config: HexConfig;
  /** Forwarded to `resolveGitSource` and `discoverTemplates`. */
  cacheDir?: string;
  /** Override base directory for relative `file:` paths. Defaults to the recipe bundle's rootPath. */
  cwd?: string;
  /** When provided, non-fatal warnings (e.g. duplicate-name discovery clashes) are pushed here. */
  warnings?: string[];
};

/**
 * Walk a recipe's `composes:` block and resolve every child to a loaded
 * bundle. When a child is itself a recipe, recursively resolve its
 * composes — assembly is **tree-shaped**, never a graph: if a recipe
 * directly or transitively composes itself, resolution rejects with a
 * `RecipeResolutionError` whose message names the cycle chain.
 *
 * Discovery (for bare-name children) is invoked lazily, at most once
 * across the whole recursive walk; nested levels reuse the same
 * discovered template list.
 *
 * Failure to resolve any child throws a `RecipeResolutionError` naming
 * the failing key. Children are resolved sequentially in declaration
 * order, depth-first.
 */
export async function resolveRecipe(
  recipeBundle: ComponentBundle,
  opts: ResolveRecipeOpts,
): Promise<ResolvedRecipe> {
  if (recipeBundle.manifest.type !== 'recipe') {
    throw new Error(
      `resolveRecipe called on a ${recipeBundle.manifest.type} bundle (${recipeBundle.manifest.name})`,
    );
  }
  const ctx: ResolveCtx = { opts, discovered: null, pathStack: [] };
  const result = await resolveRecipeRec(recipeBundle, '<root>', ctx);
  validateContracts(result);
  return result;
}

type ResolveCtx = {
  opts: ResolveRecipeOpts;
  discovered: TemplateEntry[] | null;
  pathStack: Array<{ key: string; rootPath: string }>;
};

async function resolveRecipeRec(
  recipeBundle: ComponentBundle,
  enteringKey: string,
  ctx: ResolveCtx,
): Promise<ResolvedRecipe> {
  const composes = recipeBundle.manifest.composes;
  if (!composes || Object.keys(composes).length === 0) {
    return { recipeBundle, children: new Map() };
  }

  // Lazy discovery — at most once across the whole recursive walk. Re-evaluate
  // at each level so a deep bare-name ref still triggers discovery if no
  // shallower level needed it.
  if (
    ctx.discovered === null &&
    Object.values(composes).some((c) => c.kind === 'name' || c.kind === 'slot')
  ) {
    const result = await discoverTemplates(ctx.opts.config, { cacheDir: ctx.opts.cacheDir });
    ctx.discovered = result.templates;
    if (ctx.opts.warnings) ctx.opts.warnings.push(...result.warnings);
  }

  ctx.pathStack.push({ key: enteringKey, rootPath: recipeBundle.rootPath });
  try {
    const children = new Map<string, ChildResolution>();
    for (const [key, ref] of Object.entries(composes)) {
      let bundle: ComponentBundle;
      try {
        bundle = await loadChild(ref, recipeBundle, ctx.discovered, ctx.opts);
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        const detail = err instanceof Error ? err.message : String(err);
        throw new RecipeResolutionError(
          `failed to resolve child "${key}" (${describeRef(ref)}): ${detail}`,
          key,
          cause,
        );
      }

      let resolved: ResolvedRecipe | undefined;
      if (bundle.manifest.type === 'recipe') {
        const cycleAt = ctx.pathStack.findIndex((p) => p.rootPath === bundle.rootPath);
        if (cycleAt !== -1) {
          const chain = [...ctx.pathStack.slice(cycleAt).map((p) => p.key), key].join(' → ');
          throw new RecipeResolutionError(`cycle detected in recipe composes graph: ${chain}`, key);
        }
        resolved = await resolveRecipeRec(bundle, key, ctx);
      }

      children.set(key, { key, ref, bundle, resolved });
    }
    return { recipeBundle, children };
  } finally {
    ctx.pathStack.pop();
  }
}

async function loadChild(
  ref: ChildRef,
  recipeBundle: ComponentBundle,
  discovered: TemplateEntry[] | null,
  opts: ResolveRecipeOpts,
): Promise<ComponentBundle> {
  if (ref.kind === 'file') {
    const baseDir = opts.cwd ?? recipeBundle.rootPath;
    const resolvedPath = isAbsolute(ref.path) ? ref.path : resolvePath(baseDir, ref.path);
    return loadFromPath(resolvedPath);
  }
  if (ref.kind === 'git') {
    const result = await resolveGitSource(
      { url: ref.url, ref: ref.ref },
      { cacheDir: opts.cacheDir },
    );
    return loadFromPath(result.localPath);
  }
  if (ref.kind === 'slot') {
    if (!discovered) {
      throw new Error('discovered templates not loaded — internal resolver invariant violated');
    }
    const matches = discovered.filter(
      (t) =>
        t.type === 'component' &&
        t.kind === ref.componentKind &&
        versionSatisfies(t.version, ref.versionSpec),
    );
    if (matches.length === 0) {
      throw new Error(
        `no component with kind "${ref.componentKind}" matching version "${ref.versionSpec}" found in configured source roots`,
      );
    }
    if (matches.length > 1 && opts.warnings) {
      const names = matches.map((m) => `${m.name}@${m.version}`).join(', ');
      const picked = matches[0];
      opts.warnings.push(
        `ambiguous slot for kind "${ref.componentKind}" (version "${ref.versionSpec}"): ${matches.length} candidates [${names}] — picked ${picked?.name}@${picked?.version}`,
      );
    }
    const picked = matches[0];
    if (!picked) {
      throw new Error(
        'internal resolver invariant violated: matches non-empty but first is undefined',
      );
    }
    return loadFromPath(picked.rootPath);
  }
  // ref.kind === 'name'
  if (!discovered) {
    throw new Error('discovered templates not loaded — internal resolver invariant violated');
  }
  const match = discovered.find((t) => t.name === ref.name);
  if (!match) {
    throw new Error(
      `no template named "${ref.name}" found in configured source roots (version spec "${ref.versionSpec}" — version matching is M5.x)`,
    );
  }
  return loadFromPath(match.rootPath);
}

function describeRef(ref: ChildRef): string {
  if (ref.kind === 'file') return `file:${ref.path}`;
  if (ref.kind === 'git') return ref.ref ? `git+${ref.url}@${ref.ref}` : `git+${ref.url}`;
  if (ref.kind === 'slot') return `{ kind: ${ref.componentKind}, version: ${ref.versionSpec} }`;
  return `${ref.name}@${ref.versionSpec}`;
}
