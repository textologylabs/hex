import { existsSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import * as clack from '@clack/prompts';
import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import { splash } from '../brand/splash.js';
import { checklistFromTasks, writeChecklist } from '../core/checklist/index.js';
import { loadConfig } from '../core/config/load.js';
import type { HexConfig } from '../core/config/types.js';
import { type TemplateEntry, discoverTemplates } from '../core/discovery/index.js';
import type { SetupTask } from '../core/manifest/types.js';
import { createClackPrompter } from '../core/prompts/clack-prompter.js';
import { runPrompts } from '../core/prompts/engine.js';
import { PromptCancelledError } from '../core/prompts/types.js';
import type { Answers, Prompter } from '../core/prompts/types.js';
import { runRecipePrompts } from '../core/recipe/prompts.js';
import { type RenderRecipeResult, renderRecipe } from '../core/recipe/render.js';
import { type ResolvedRecipe, resolveRecipe } from '../core/recipe/resolve.js';
import { aggregateRecipeSetup } from '../core/recipe/setup.js';
import { renderBundle } from '../core/render/engine.js';
import { type ComponentBundle, loadFromPath } from '../core/sources/file-source.js';
import { printSetupOutro, runSetupSession } from './setup.js';

export class NewCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewCommandError';
  }
}

/**
 * Answers + (recipe-only) resolution state collected from the user. The
 * CLI's spinner wraps `executeNewRender` — keeping the prompt phase out of
 * the spinned span so clack prompts can render cleanly.
 */
export type NewContext = {
  warnings: string[];
  answers: Answers;
  /** Present iff the bundle is a recipe. */
  resolved?: ResolvedRecipe;
};

export type NewRenderSummary = {
  written: number;
  renamed: number;
  deleted: number;
  /** 0 for components, N for recipes (immediate children only). */
  childCount: number;
  tasks: SetupTask[];
  setupMessage?: string;
};

/**
 * Run prompts (recipe-level then per-child for recipes, flat for
 * components) and produce the context needed by `executeNewRender`.
 * Extracted so the CLI can split prompts (interactive) from render
 * (spinnable) and so tests can drive it with a scripted prompter.
 */
export async function collectNewAnswers(
  bundle: ComponentBundle,
  prompter: Prompter,
  config: HexConfig,
): Promise<NewContext> {
  if (bundle.manifest.type === 'recipe') {
    const warnings: string[] = [];
    const resolved = await resolveRecipe(bundle, { config, warnings });
    const answers = await runRecipePrompts(resolved, prompter);
    return { warnings, answers, resolved };
  }
  const answers = await runPrompts(
    bundle.manifest.prompts ?? [],
    prompter,
    {},
    bundle.manifest.sections,
  );
  return { warnings: [], answers };
}

/**
 * Render `bundle` into `outputDir` and aggregate the post-render
 * surfacing (file counts, setup tasks, setup message). For recipes the
 * task list is aggregated across the whole tree via
 * `aggregateRecipeSetup`; for components it is the manifest's own
 * `setup.tasks` unchanged.
 */
export async function executeNewRender(
  bundle: ComponentBundle,
  outputDir: string,
  ctx: NewContext,
  opts: { force: boolean; prompter?: Prompter },
): Promise<NewRenderSummary> {
  if (ctx.resolved) {
    const result = await renderRecipe(ctx.resolved, outputDir, ctx.answers, {
      force: opts.force,
      prompter: opts.prompter,
    });
    const counts = summariseRecipeRender(result);
    return {
      ...counts,
      childCount: ctx.resolved.children.size,
      tasks: aggregateRecipeSetup(ctx.resolved),
      setupMessage: bundle.manifest.setup?.message,
    };
  }
  const result = await renderBundle(bundle, outputDir, ctx.answers, {
    force: opts.force,
    prompter: opts.prompter,
  });
  return {
    written: result.written.length,
    renamed: result.renamed.length,
    deleted: result.deleted.length,
    childCount: 0,
    tasks: bundle.manifest.setup?.tasks ?? [],
    setupMessage: bundle.manifest.setup?.message,
  };
}

type RenderCounts = { written: number; renamed: number; deleted: number };

function summariseRecipeRender(result: RenderRecipeResult): RenderCounts {
  const counts: RenderCounts = { written: 0, renamed: 0, deleted: 0 };
  accumulate(counts, result.recipe);
  for (const child of result.children.values()) {
    if (child.nestedRecipe) {
      // Nested recipe — the spread on `child` aliases the nested recipe's
      // own root render only; descend so deeper children are counted too.
      const nested = summariseRecipeRender(child.nestedRecipe);
      counts.written += nested.written;
      counts.renamed += nested.renamed;
      counts.deleted += nested.deleted;
    } else {
      accumulate(counts, child);
    }
  }
  return counts;
}

function accumulate(
  counts: RenderCounts,
  r: { written: string[]; renamed: unknown[]; deleted: string[] },
): void {
  counts.written += r.written.length;
  counts.renamed += r.renamed.length;
  counts.deleted += r.deleted.length;
}

export function registerNew(program: Command): void {
  program
    .command('new')
    .description('render a template into a new directory')
    .argument('[template]', 'template path or registered name (omit to pick interactively)')
    .argument('[output]', 'path where the generated project will be written')
    .option('-f, --force', 'overwrite a non-empty output directory', false)
    .option('--no-setup', 'skip the post-render interactive setup loop')
    .action(
      async (
        templateArg: string | undefined,
        outputArg: string | undefined,
        opts: { force: boolean; setup: boolean },
      ) => {
        process.stdout.write(`${splash()}\n`);
        clack.intro(brand.honeyBold(' hex new '));

        const bundle = await resolveTemplate(templateArg);
        const typeLabel = bundle.manifest.type === 'recipe' ? 'Recipe' : 'Template';
        clack.log.info(
          `${typeLabel}: ${brand.bold(bundle.manifest.name)} ${brand.dim(`@${bundle.manifest.version}`)}`,
        );

        const outputDir = await resolveOutputDir(outputArg);
        const config = await loadConfig();

        const prompter = createClackPrompter();
        const ctx = await collectNewAnswers(bundle, prompter, config);
        for (const w of ctx.warnings) clack.log.warn(w);

        const spinner = clack.spinner();
        spinner.start('rendering');
        const result = await executeNewRender(bundle, outputDir, ctx, {
          force: opts.force,
          prompter,
        });
        const summaryTail =
          result.childCount > 0
            ? ` across ${result.childCount} child${result.childCount === 1 ? '' : 'ren'} + recipe root`
            : '';
        spinner.stop(`rendered ${result.written} files${summaryTail}`);

        if (result.renamed > 0 || result.deleted > 0) {
          clack.log.info(`hooks: ${result.renamed} renamed, ${result.deleted} deleted`);
        }

        if (result.tasks.length === 0) {
          clack.outro(brand.done(`done — ${outputDir}`));
          return;
        }

        // Write the initial checklist before doing anything else, so a hard
        // exit at this point still leaves the project in a recoverable state.
        const initial = checklistFromTasks(result.tasks);
        await writeChecklist(outputDir, initial);

        if (result.setupMessage) {
          clack.note(result.setupMessage, 'Post-scaffold setup');
        }

        const interactive = process.stdout.isTTY && opts.setup;
        if (!interactive) {
          clack.outro(
            `${result.tasks.length} setup tasks pending — run ${brand.bold('hex setup')} from ${outputDir}`,
          );
          return;
        }

        const setupResult = await runSetupSession(
          { rootDir: outputDir, checklist: initial },
          createClackPrompter(),
        );
        printSetupOutro(setupResult);
      },
    );
}

function looksLikePath(arg: string): boolean {
  return (
    arg.startsWith('.') ||
    arg.startsWith('/') ||
    arg.startsWith('~') ||
    isAbsolute(arg) ||
    arg.includes(sep) ||
    arg.includes('/') ||
    existsSync(arg)
  );
}

async function resolveTemplate(arg: string | undefined): Promise<ComponentBundle> {
  if (arg && looksLikePath(arg)) {
    return loadFromPath(arg);
  }

  const config = await loadConfig();
  const { templates, warnings } = await discoverTemplates(config);

  for (const w of warnings) clack.log.warn(w);

  if (arg) {
    const match = templates.find((t) => t.name === arg);
    if (!match) {
      throw new NewCommandError(
        `no template named "${arg}" found in configured source roots — try "hex list" to see what's available, or pass a path.`,
      );
    }
    return loadFromPath(match.rootPath);
  }

  if (templates.length === 0) {
    throw new NewCommandError(
      'no templates available — configure source roots in ~/.hex/config.yaml or pass a path.',
    );
  }

  const picked = await clack.select({
    message: 'Pick a template',
    options: templates.map((t) => ({
      value: t.rootPath,
      label: `${t.name} ${brand.dim(`@${t.version}`)}`,
      hint: hintFor(t),
    })),
  });
  if (clack.isCancel(picked)) throw new PromptCancelledError();

  return loadFromPath(picked as string);
}

function hintFor(t: TemplateEntry): string {
  const parts: string[] = [];
  if (t.kind) parts.push(t.kind);
  parts.push(t.rootPath);
  return parts.join(' — ');
}

async function resolveOutputDir(arg: string | undefined): Promise<string> {
  if (arg) return arg;
  const result = await clack.text({
    message: 'Output directory',
    placeholder: './my-app',
    validate: (v) => (v && v.length > 0 ? undefined : 'output directory is required'),
  });
  if (clack.isCancel(result)) throw new PromptCancelledError();
  return result as string;
}
