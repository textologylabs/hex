import { isAbsolute, resolve } from 'node:path';
import type { Answers } from '../prompts/types.js';
import {
  RenderError,
  type RenderOptions,
  type RenderResult,
  ensureWriteableTarget,
  renderBundle,
} from '../render/engine.js';
import { renderText } from '../render/templating.js';
import { collectStubServices, engineSymbolPrefix } from '../stub/services.js';
import type { ResolvedRecipe } from './resolve.js';

export type ChildRenderResult = RenderResult & {
  /** Path relative to the recipe's outputPath where this child rendered. */
  subdir: string;
  /** Absolute path of the child's render target. */
  outputPath: string;
  /**
   * When the child is itself a recipe, the full nested render result.
   * The flat `written/renamed/deleted` fields are aliased to the nested
   * recipe-root's own RenderResult (matching how component children
   * surface their immediate render output).
   */
  nestedRecipe?: RenderRecipeResult;
};

export type RenderRecipeResult = {
  /** Absolute path of the recipe's outputPath. */
  outputPath: string;
  /** Per-child results keyed by composes-block key (declaration order). */
  children: Map<string, ChildRenderResult>;
  /** Files emitted by the recipe's own template tree (orchestration files). */
  recipe: RenderResult;
};

/**
 * Render a resolved recipe into `outputPath`. Children are rendered first,
 * each into its own subdirectory of `outputPath`; then the recipe's own
 * template tree is rendered into `outputPath` itself (orchestration files
 * — root README, root package.json, docker-compose.yml, etc.).
 *
 * Default child subdir is the composes-block key; the user can override
 * at prompt time by emitting a recipe-level prompt named `<key>_dir`
 * whose answer becomes the subdir (single segment or multi-segment, but
 * never escaping the recipe outputPath).
 *
 * Each child's manifest-level `include:` rules and `post_render` hooks
 * apply only to that child's subtree — they are forwarded to
 * `renderBundle` with the child's own outputPath, so any path the child
 * names is implicitly scoped to its subtree.
 *
 * The recipe-root render runs AFTER every child so the recipe's templates
 * can reference any child's answers. To prevent the recipe's own template
 * tree from accidentally writing into a child's subtree, the walk over
 * the recipe root skips paths that match a rendered child's subdir.
 *
 * The child render scope is `{ ...answers, ...answers[key] }`:
 *   - recipe-level keys flat at root (so child templates can reference
 *     `{{ project_name }}` etc.)
 *   - sibling namespaces still nested at `answers.<sibling_key>` (so a
 *     child can read `{{ api.port }}`)
 *   - the child's own prompt answers flat at root (overriding any
 *     recipe-level keys with the same name)
 *
 * The recipe-root render uses `answers` verbatim, so the recipe's
 * templates see recipe-level prompts at root and every child namespace
 * at `answers.<key>.*`.
 */
export async function renderRecipe(
  resolved: ResolvedRecipe,
  outputPath: string,
  answers: Answers,
  opts: RenderOptions = {},
): Promise<RenderRecipeResult> {
  const absOut = isAbsolute(outputPath) ? outputPath : resolve(process.cwd(), outputPath);
  await ensureWriteableTarget(absOut, opts.force ?? false);

  // Recipe metadata threaded into every child's hook context (and the
  // recipe-root's own hooks). `opts.recipe` is only set when this
  // recipe is itself nested inside an outer recipe — in that case we
  // *keep* the outermost recipe in the context so hooks can reach the
  // top-level identity, not the immediate parent recipe.
  const recipeMeta = opts.recipe ?? {
    name: resolved.recipeBundle.manifest.name,
    version: resolved.recipeBundle.manifest.version,
  };
  const childOpts: RenderOptions = { ...opts, recipe: recipeMeta };

  const childResults = new Map<string, ChildRenderResult>();
  const usedSubdirs = new Map<string, string>();

  // M6.4: pre-pass — evaluate every component child's `provides` map (when it
  // is the symbol→expression form) in that child's own scope, building a flat
  // `provided` map made available to ALL siblings (and the recipe root) under
  // `provided.<symbol>`. Provides expressions intentionally do NOT see other
  // children's `provided` — keeps the resolution order single-pass.
  const provided = collectProvided(resolved, answers);

  // M8.3: dedup out-of-process stub engines across stubbed children into
  // one shared service each. Coordinates land in `provided.*` (so any
  // child consuming a stub can reach `provided.STUB_WIREMOCK_HOST`);
  // the full list lands as `stub_services` so the recipe-root
  // `docker-compose.yml` template can `{% for %}` over it — emitting one
  // service block per engine, dedup falling out of the deduped list.
  const stubServices = collectStubServices(resolved);
  for (const svc of stubServices) {
    const prefix = engineSymbolPrefix(svc.engine);
    provided[`${prefix}_HOST`] = svc.host;
    provided[`${prefix}_PORT`] = String(svc.port);
  }
  const answersWithProvided: Answers = { ...answers, provided, stub_services: stubServices };

  for (const [key, child] of resolved.children) {
    const subdir = resolveChildSubdir(key, answersWithProvided);
    const previousKey = usedSubdirs.get(subdir);
    if (previousKey !== undefined) {
      throw new RenderError(
        `child "${key}" resolved to subdir "${subdir}" which is already used by child "${previousKey}"`,
      );
    }
    usedSubdirs.set(subdir, key);

    const childOut = resolve(absOut, subdir);
    const childScope = buildChildScope(answersWithProvided, key);
    // M8.2: surface the recipe's per-slot stub decision as a well-known
    // `stub_enabled` answer so the child's `include:` rules and Nunjucks
    // templates can branch on `{% if stub_enabled %}`. Always set (false
    // when not stubbed) so `not stub_enabled` reads cleanly too.
    childScope.stub_enabled = child.ref.stub === true;

    if (child.resolved) {
      // Recipe child — recursively render the nested recipe tree into the
      // child's subdir. The nested recipe's own children + recipe root all
      // land within childOut. Surface nested basics on the flat fields and
      // the full tree on `nestedRecipe`.
      const nested = await renderRecipe(child.resolved, childOut, childScope, childOpts);
      childResults.set(key, {
        ...nested.recipe,
        subdir,
        outputPath: childOut,
        nestedRecipe: nested,
      });
      continue;
    }

    // M8.4: a component child rendered in stub mode emits its
    // `stub.fixtures` directory into `<childOut>/fixtures/`.
    const result = await renderBundle(child.bundle, childOut, childScope, {
      ...childOpts,
      stubEnabled: child.ref.stub === true,
    });
    childResults.set(key, { ...result, subdir, outputPath: childOut });
  }

  const childSubdirIgnorePatterns = [...usedSubdirs.keys()].map((sub) => `${sub}/`);
  const recipeResult = await renderBundle(resolved.recipeBundle, absOut, answersWithProvided, {
    ...childOpts,
    skipWriteableCheck: true,
    extraIgnorePatterns: [...(opts.extraIgnorePatterns ?? []), ...childSubdirIgnorePatterns],
  });

  return { outputPath: absOut, children: childResults, recipe: recipeResult };
}

/**
 * Walk the recipe's immediate component children, evaluating each one's
 * provides expressions in its own scope. Returns the flat `provided` map.
 *
 * Recipe children contribute nothing here — they have no provides at this
 * level (M6.1 enforces). Their internal children will produce their own
 * `provided` map at their own recipe level.
 *
 * Bare-array `provides` declarations (M6.1 form) contribute symbol entries
 * with empty-string values: the contract is declared but no sibling-visible
 * value is produced. Consumers reading `provided.X` see "" — same as any
 * undefined Nunjucks value.
 */
function collectProvided(resolved: ResolvedRecipe, answers: Answers): Record<string, string> {
  const provided: Record<string, string> = {};
  for (const [key, child] of resolved.children) {
    const m = child.bundle.manifest;
    if (m.type !== 'component' || !m.provides) continue;
    const childScope = buildChildScope(answers, key);
    if (Array.isArray(m.provides)) {
      for (const symbol of m.provides) {
        provided[symbol] = '';
      }
      continue;
    }
    for (const [symbol, expression] of Object.entries(m.provides)) {
      provided[symbol] = renderText(expression, childScope);
    }
  }
  return provided;
}

function buildChildScope(answers: Answers, key: string): Answers {
  const ownNamespace = answers[key];
  if (ownNamespace && typeof ownNamespace === 'object' && !Array.isArray(ownNamespace)) {
    return { ...answers, ...(ownNamespace as Answers) };
  }
  return { ...answers };
}

const FORBIDDEN_SEGMENT = new Set(['', '.', '..']);

function resolveChildSubdir(key: string, answers: Answers): string {
  const overrideKey = `${key}_dir`;
  const override = answers[overrideKey];
  const candidate =
    typeof override === 'string' && override.trim().length > 0 ? override.trim() : key;

  validateSubdir(key, candidate);
  return candidate;
}

function validateSubdir(key: string, value: string): void {
  if (value.includes('\\')) {
    throw new RenderError(
      `child "${key}" subdir "${value}" must not contain backslashes — use forward slashes`,
    );
  }
  if (value.startsWith('/')) {
    throw new RenderError(`child "${key}" subdir "${value}" must not be absolute`);
  }
  // Reject Windows-style drive prefixes (`C:/foo`) defensively.
  if (/^[a-zA-Z]:/.test(value)) {
    throw new RenderError(`child "${key}" subdir "${value}" must not be absolute`);
  }
  for (const segment of value.split('/')) {
    if (FORBIDDEN_SEGMENT.has(segment)) {
      throw new RenderError(
        `child "${key}" subdir "${value}" contains a forbidden path segment ("${segment}")`,
      );
    }
  }
}
