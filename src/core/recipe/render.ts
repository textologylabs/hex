import { isAbsolute, resolve } from 'node:path';
import type { Answers } from '../prompts/types.js';
import {
  RenderError,
  type RenderOptions,
  type RenderResult,
  ensureWriteableTarget,
  renderBundle,
} from '../render/engine.js';
import type { ResolvedRecipe } from './resolve.js';

export type ChildRenderResult = RenderResult & {
  /** Path relative to the recipe's outputPath where this child rendered. */
  subdir: string;
  /** Absolute path of the child's render target. */
  outputPath: string;
};

export type RenderRecipeResult = {
  /** Absolute path of the recipe's outputPath. */
  outputPath: string;
  /** Per-child results keyed by composes-block key (declaration order). */
  children: Map<string, ChildRenderResult>;
};

/**
 * Render every child of a resolved recipe into its own subdirectory of
 * `outputPath`. Default subdir is the composes-block key; the user can
 * override at prompt time by emitting a recipe-level prompt named
 * `<key>_dir` whose answer becomes the subdir (single segment or
 * multi-segment, but never escaping the recipe outputPath).
 *
 * Each child's manifest-level `include:` rules and `post_render` hooks
 * apply only to that child's subtree — they are forwarded to
 * `renderBundle` with the child's own outputPath, so any path the child
 * names is implicitly scoped to its subtree.
 *
 * Recipe root rendering (orchestration files at outputPath itself) is
 * NOT done here — that lands in M5.5 once recipe templates have a place
 * to live in the manifest layout.
 *
 * The child render scope is `{ ...answers, ...answers[key] }`:
 *   - recipe-level keys flat at root (so child templates can reference
 *     `{{ project_name }}` etc.)
 *   - sibling namespaces still nested at `answers.<sibling_key>` (so a
 *     child can read `{{ api.port }}`)
 *   - the child's own prompt answers flat at root (overriding any
 *     recipe-level keys with the same name)
 */
export async function renderRecipe(
  resolved: ResolvedRecipe,
  outputPath: string,
  answers: Answers,
  opts: RenderOptions = {},
): Promise<RenderRecipeResult> {
  const absOut = isAbsolute(outputPath) ? outputPath : resolve(process.cwd(), outputPath);
  await ensureWriteableTarget(absOut, opts.force ?? false);

  const childResults = new Map<string, ChildRenderResult>();
  const usedSubdirs = new Map<string, string>();

  for (const [key, child] of resolved.children) {
    const subdir = resolveChildSubdir(key, answers);
    const previousKey = usedSubdirs.get(subdir);
    if (previousKey !== undefined) {
      throw new RenderError(
        `child "${key}" resolved to subdir "${subdir}" which is already used by child "${previousKey}"`,
      );
    }
    usedSubdirs.set(subdir, key);

    const childOut = resolve(absOut, subdir);
    const childScope = buildChildScope(answers, key);
    const result = await renderBundle(child.bundle, childOut, childScope, opts);
    childResults.set(key, { ...result, subdir, outputPath: childOut });
  }

  return { outputPath: absOut, children: childResults };
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
