import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { type HookResult, runPostRenderHooks } from '../hooks/declarative.js';
import { type HookLog, type RecipeContext, runJsHooks } from '../hooks/runner.js';
import type { JsHook } from '../manifest/types.js';
import type { Answers, Prompter } from '../prompts/types.js';
import type { ComponentBundle } from '../sources/file-source.js';
import { shouldInclude } from './include-rules.js';
import { renderText } from './templating.js';
import { walkTemplate } from './walk.js';

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

export type RenderOptions = {
  /** Overwrite a non-empty existing output directory. */
  force?: boolean;
  /**
   * Skip the empty-directory safety check on `outputPath`. Used by the
   * recipe-root render — `renderRecipe` already validated the outer
   * directory before children populated it, so the recipe's own
   * `renderBundle` call must not re-check and reject it.
   */
  skipWriteableCheck?: boolean;
  /**
   * Extra gitignore-style patterns appended to `.hexignore`. The recipe
   * render uses this to skip into child subdirs (so the recipe's own
   * template tree can't accidentally rewrite child output).
   */
  extraIgnorePatterns?: string[];
  /**
   * Recipe metadata forwarded to JS hooks as the `recipe` global. Set
   * by `renderRecipe` when calling `renderBundle` on a child; left
   * undefined for standalone component renders.
   */
  recipe?: RecipeContext;
  /**
   * Override the JS-hook log sink. Defaults to console.{log,warn,error}.
   * Tests inject a capturing sink here.
   */
  hookLog?: HookLog;
  /**
   * Prompter forwarded to JS hooks that declare `prompts:` (M7.5).
   * Required when any such hook is reachable; omitted otherwise.
   */
  prompter?: Prompter;
  /**
   * Trust-local opt-out (M7.6). When true AND the bundle's
   * `sourceKind` is `'file'`, JS hooks for this bundle run unsandboxed
   * in the host Node process. Bundles with `sourceKind === 'git'`
   * ignore the flag and stay sandboxed.
   */
  trustLocal?: boolean;
  /**
   * Stub mode for this bundle (M8.4). When true and the manifest
   * declares `stub.fixtures`, that fixtures directory is rendered into
   * `<output>/fixtures/`. Set per-child by `renderRecipe` from the
   * recipe's `stub: true` slot decision; absent for non-stub renders.
   */
  stubEnabled?: boolean;
};

const BINARY_SAMPLE_BYTES = 8192;

function looksBinary(buf: Buffer): boolean {
  const end = Math.min(BINARY_SAMPLE_BYTES, buf.length);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function ensureWriteableTarget(outputPath: string, force: boolean): Promise<void> {
  try {
    const s = await stat(outputPath);
    if (!s.isDirectory()) {
      throw new RenderError(`output path exists and is not a directory: ${outputPath}`);
    }
    const entries = await readdir(outputPath);
    if (entries.length > 0 && !force) {
      throw new RenderError(
        `output directory is non-empty: ${outputPath} (pass --force to overwrite)`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (err instanceof RenderError) throw err;
    throw new RenderError(
      `cannot inspect output directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function safeJoin(outputPath: string, rendered: string): string {
  // Normalise away any rendered '..' / leading '/' so authors can't
  // escape the output directory through templated paths.
  const target = resolve(outputPath, rendered);
  const root = resolve(outputPath) + sep;
  if (!target.startsWith(root) && target !== resolve(outputPath)) {
    throw new RenderError(`rendered path escapes the output directory: ${rendered}`);
  }
  return target;
}

/**
 * Render a component bundle into an output directory, given the user's
 * answers. The bundle's `.hex/` is skipped, `.hexignore` is honoured, and
 * each remaining file's path + contents are rendered through Nunjucks
 * (binary files are copied verbatim).
 *
 * If a rendered path comes out empty (e.g. all path segments were guarded
 * by `{% if %}` blocks), the file is skipped. The recommended way to
 * conditionally emit a whole file is the manifest's `include:` rules,
 * not `{% if %}` wrapping a filename.
 */
export type RenderResult = {
  written: string[];
} & HookResult;

export async function renderBundle(
  bundle: ComponentBundle,
  outputPath: string,
  answers: Answers,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  const absOut = isAbsolute(outputPath) ? outputPath : resolve(process.cwd(), outputPath);
  if (!opts.skipWriteableCheck) {
    await ensureWriteableTarget(absOut, opts.force ?? false);
  }

  // `live` tracks answers across the lifecycle. Hook-defined prompts
  // (M7.5) augment it with `answers.hooks.<name>.*` entries that need
  // to be visible to subsequent phases (walk, declarative hooks,
  // post_render JS hooks).
  let live: Answers = answers;

  // Trust-local only fires for FileSource bundles — git/marketplace
  // bundles always sandbox, no matter what the CLI passed. M7.6 trust
  // gradient is the bundle's, not the user's.
  const trustLocalEffective = opts.trustLocal === true && bundle.sourceKind === 'file';

  // Pre-render JS hooks need the output dir to exist so the project FS
  // facade can write into it. mkdir is idempotent — the recipe-root
  // render path may already have populated it via children, which is
  // fine.
  const preRenderJsHooks = (bundle.manifest.hooks?.pre_render ?? []) as JsHook[];
  if (preRenderJsHooks.length > 0) {
    await mkdir(absOut, { recursive: true });
    live = await runJsHooks('pre_render', preRenderJsHooks, bundle.jsHookSources, absOut, live, {
      recipe: opts.recipe,
      log: opts.hookLog,
      prompter: opts.prompter,
      trustLocal: trustLocalEffective,
    });
  }

  const includeRules = bundle.manifest.include ?? [];
  const written: string[] = [];

  // A stubbable component's `stub.fixtures` directory is excluded from
  // the normal walk unconditionally — it is emitted (into a fixed
  // `fixtures/` subtree) only via the stub-mode path below, never as a
  // plain template file.
  const fixturesDir = bundle.manifest.stub?.fixtures;
  const ignorePatterns = [...(opts.extraIgnorePatterns ?? [])];
  if (fixturesDir) {
    ignorePatterns.push(`${fixturesDir.replace(/\/+$/, '')}/`);
  }

  for await (const file of walkTemplate(bundle.rootPath, {
    extraIgnorePatterns: ignorePatterns,
  })) {
    if (!shouldInclude(file.relativePath, includeRules, live)) continue;

    const renderedRel = renderText(file.relativePath, live).trim();
    if (renderedRel.length === 0) continue;

    const targetPath = safeJoin(absOut, renderedRel);
    const data = await readFile(file.absolutePath);

    await mkdir(dirname(targetPath), { recursive: true });

    if (looksBinary(data)) {
      await writeFile(targetPath, data);
    } else {
      const rendered = renderText(data.toString('utf8'), live);
      await writeFile(targetPath, rendered, 'utf8');
    }

    written.push(renderedRel);
  }

  // M8.4: stub fixtures render after the main walk (so they are part of
  // the tree the declarative + post_render hooks observe) but only when
  // this bundle renders in stub mode.
  if (opts.stubEnabled && fixturesDir) {
    written.push(...(await renderFixtures(bundle.rootPath, fixturesDir, absOut, live)));
  }

  const postRenderHooks = bundle.manifest.hooks?.post_render ?? [];
  const hookResult = await runPostRenderHooks(absOut, postRenderHooks, live, written, {
    force: opts.force ?? false,
  });

  // JS hooks run AFTER the declarative pass so they observe the
  // final shape of the tree (post-rename, post-delete).
  const postRenderJsHooks = postRenderHooks.filter((h): h is JsHook => 'js' in h);
  if (postRenderJsHooks.length > 0) {
    live = await runJsHooks('post_render', postRenderJsHooks, bundle.jsHookSources, absOut, live, {
      recipe: opts.recipe,
      log: opts.hookLog,
      prompter: opts.prompter,
      trustLocal: trustLocalEffective,
    });
  }

  return { written, ...hookResult };
}

/**
 * Render a stubbable component's `stub.fixtures` directory into
 * `<output>/fixtures/` (M8.4).
 *
 * Fixtures pass through the same Nunjucks engine as scaffolding files —
 * both path segments and text contents — so seed data can reference
 * recipe answers. Binary fixture files are copied verbatim. The target
 * directory name is always `fixtures/`, regardless of what the manifest
 * named the source.
 *
 * Returns the list of emitted paths (each prefixed `fixtures/`) so the
 * caller can fold them into the render result.
 */
async function renderFixtures(
  bundleRoot: string,
  fixturesRel: string,
  absOut: string,
  answers: Answers,
): Promise<string[]> {
  const srcRoot = resolve(bundleRoot, fixturesRel);
  const bundleAbs = resolve(bundleRoot);
  if (srcRoot !== bundleAbs && !srcRoot.startsWith(bundleAbs + sep)) {
    throw new RenderError(`stub fixtures path escapes the component: ${fixturesRel}`);
  }

  let srcStat: Awaited<ReturnType<typeof stat>>;
  try {
    srcStat = await stat(srcRoot);
  } catch {
    throw new RenderError(
      `stub fixtures directory declared in manifest but not found: ${fixturesRel}`,
    );
  }
  if (!srcStat.isDirectory()) {
    throw new RenderError(`stub fixtures path is not a directory: ${fixturesRel}`);
  }

  const fixturesOut = join(absOut, 'fixtures');
  const written: string[] = [];

  for await (const file of walkTemplate(srcRoot, {})) {
    const renderedRel = renderText(file.relativePath, answers).trim();
    if (renderedRel.length === 0) continue;

    const targetPath = safeJoin(fixturesOut, renderedRel);
    const data = await readFile(file.absolutePath);

    await mkdir(dirname(targetPath), { recursive: true });

    if (looksBinary(data)) {
      await writeFile(targetPath, data);
    } else {
      await writeFile(targetPath, renderText(data.toString('utf8'), answers), 'utf8');
    }

    written.push(join('fixtures', renderedRel));
  }

  return written;
}
