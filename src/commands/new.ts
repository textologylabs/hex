import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import * as clack from '@clack/prompts';
import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import { sym } from '../brand/glyphs.js';
import { splash } from '../brand/splash.js';
import {
  type CatalogueProvider,
  loadCatalogueProviders,
} from '../core/catalogue/catalogue-providers.js';
import {
  type Checklist,
  checklistFromTasks,
  countByStatus,
  writeChecklist,
} from '../core/checklist/index.js';
import { loadConfig } from '../core/config/load.js';
import type { HexConfig } from '../core/config/types.js';
import { trustSource } from '../core/config/write.js';
import { type TemplateEntry, discoverTemplates } from '../core/discovery/index.js';
import { buildLockfile, writeLockfile } from '../core/lockfile/index.js';
import type { SetupTask } from '../core/manifest/types.js';
import { AddressError, parseAddress } from '../core/marketplace/address.js';
import {
  CatalogueSourceError,
  resolveFromCatalogue,
} from '../core/marketplace/catalogue-source.js';
import { pickVersion } from '../core/marketplace/source.js';
import { AnswersFileError, loadAnswersFile } from '../core/prompts/answers-file.js';
import { createClackPrompter } from '../core/prompts/clack-prompter.js';
import { PromptError, runPrompts } from '../core/prompts/engine.js';
import { createNonInteractivePrompter } from '../core/prompts/non-interactive-prompter.js';
import { PromptCancelledError } from '../core/prompts/types.js';
import type { Answers, Prompter } from '../core/prompts/types.js';
import { runRecipePrompts } from '../core/recipe/prompts.js';
import { type RenderRecipeResult, renderRecipe } from '../core/recipe/render.js';
import { type ResolvedRecipe, resolveRecipe } from '../core/recipe/resolve.js';
import { aggregateRecipeSetup } from '../core/recipe/setup.js';
import { renderBundle } from '../core/render/engine.js';
import {
  type ExecutorPassResult,
  countActionableTasks,
  runExecutorPass,
} from '../core/setup/executor-pass.js';
import type { RitualOutcome } from '../core/setup/ritual.js';
import { SetupExecutorError, validateSetupTasksAllowlist } from '../core/setup/run.js';
import { type TrustPolicy, classifySource, resolveTrustPolicy } from '../core/setup/trust.js';
import { type ComponentBundle, loadFromPath } from '../core/sources/file-source.js';
import { captureBaseline } from '../core/upgrade/baseline.js';
import {
  defaultRitualEffects,
  makeInteractiveRunner,
  printSetupOutro,
  runSetupSession,
} from './setup.js';

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
  supplied?: Answers,
): Promise<NewContext> {
  if (bundle.manifest.type === 'recipe') {
    const warnings: string[] = [];
    const resolved = await resolveRecipe(bundle, { config, warnings });
    const answers = await runRecipePrompts(resolved, prompter, {}, supplied);
    return { warnings, answers, resolved };
  }
  const answers = await runPrompts(
    bundle.manifest.prompts ?? [],
    prompter,
    {},
    bundle.manifest.sections,
    supplied,
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
  opts: { force: boolean; prompter?: Prompter; trustLocal?: boolean },
): Promise<NewRenderSummary> {
  let summary: NewRenderSummary;
  if (ctx.resolved) {
    const result = await renderRecipe(ctx.resolved, outputDir, ctx.answers, {
      force: opts.force,
      prompter: opts.prompter,
      trustLocal: opts.trustLocal,
    });
    summary = {
      ...summariseRecipeRender(result),
      childCount: ctx.resolved.children.size,
      tasks: aggregateRecipeSetup(ctx.resolved),
      setupMessage: bundle.manifest.setup?.message,
    };
  } else {
    const result = await renderBundle(bundle, outputDir, ctx.answers, {
      force: opts.force,
      prompter: opts.prompter,
      trustLocal: opts.trustLocal,
    });
    summary = {
      written: result.written.length,
      renamed: result.renamed.length,
      deleted: result.deleted.length,
      childCount: 0,
      tasks: bundle.manifest.setup?.tasks ?? [],
      setupMessage: bundle.manifest.setup?.message,
    };
  }

  // M10.2: write `.hex/lockfile.yaml` — the generated app's
  // self-describing record. Hashed from the tree on disk, so the
  // file-hash table reflects the true post-hooks, post-render state.
  // Done for both archetypes; no `if (recipe)` branch.
  await writeLockfile(
    outputDir,
    await buildLockfile({ bundle, resolved: ctx.resolved, answers: ctx.answers, outputDir }),
  );

  // Capture `.hex/pristine/` — the tree exactly as the template rendered
  // it, before the user touches anything. `hex upgrade` merges against
  // this, so it never has to guess what the old template used to say.
  // Taken here, alongside the lockfile: post-hooks, pre-setup-ritual.
  await captureBaseline(outputDir);

  return summary;
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
    .option(
      '--answers <file>',
      'render non-interactively, taking every prompt answer from a YAML file (for CI / reproducible scaffolds)',
    )
    .option(
      '--trust-local',
      'run JS hooks unsandboxed for local FileSource components (dev workflow; ignored for git/marketplace sources)',
      false,
    )
    .action(
      async (
        templateArg: string | undefined,
        outputArg: string | undefined,
        opts: { force: boolean; setup: boolean; trustLocal: boolean; answers?: string },
      ) => {
        process.stdout.write(`${splash()}\n`);
        clack.intro(brand.honeyBold(' hex new '));

        // M15.17: `--answers <file>` renders non-interactively — every prompt
        // is resolved from the file (or its default), and the post-render
        // setup loop is left for `hex setup` rather than driven interactively.
        const answersMode = opts.answers !== undefined;
        if (answersMode && templateArg === undefined) {
          clack.log.error(
            '--answers requires a template argument — the interactive picker is unavailable in non-interactive mode',
          );
          clack.outro('aborted — pass a template path or name with --answers');
          process.exitCode = 1;
          return;
        }
        let supplied: Answers | undefined;
        if (opts.answers !== undefined) {
          try {
            supplied = await loadAnswersFile(opts.answers);
          } catch (err) {
            if (err instanceof AnswersFileError) {
              clack.log.error(err.message);
              clack.outro('aborted — could not read --answers file');
              process.exitCode = 1;
              return;
            }
            throw err;
          }
        }

        const bundle = await resolveTemplate(templateArg);
        const typeLabel = bundle.manifest.type === 'recipe' ? 'Recipe' : 'Template';
        clack.log.info(
          `${typeLabel}: ${brand.bold(bundle.manifest.name)} ${brand.dim(`@${bundle.manifest.version}`)}`,
        );

        const outputDir = await resolveOutputDir(outputArg);
        const config = await loadConfig();

        const prompter = answersMode ? createNonInteractivePrompter() : createClackPrompter();
        let ctx: NewContext;
        try {
          ctx = await collectNewAnswers(bundle, prompter, config, supplied);
        } catch (err) {
          if (answersMode && err instanceof PromptError) {
            clack.log.error(err.message);
            clack.outro('aborted — fix the --answers file and re-run');
            process.exitCode = 1;
            return;
          }
          throw err;
        }
        for (const w of ctx.warnings) clack.log.warn(w);

        if (opts.trustLocal) {
          clack.log.warn(
            `${brand.bold('--trust-local active')}: JS hooks from local FileSource components will run unsandboxed in this Node process. Git/marketplace components remain sandboxed.`,
          );
        }

        // M15.5: wrap the render-and-after phase so a mid-render crash exits
        // friendly (naming the partial output dir + a recovery hint) instead
        // of propagating raw to the top-level catch. A user cancel
        // (PromptCancelledError) is re-thrown to reach the clean cancel path.
        const spinner = clack.spinner();
        let rendered = false;
        try {
          spinner.start('rendering');
          const result = await executeNewRender(bundle, outputDir, ctx, {
            force: opts.force,
            prompter,
            trustLocal: opts.trustLocal,
          });
          const summaryTail =
            result.childCount > 0
              ? ` across ${result.childCount} child${result.childCount === 1 ? '' : 'ren'} + recipe root`
              : '';
          spinner.stop(`rendered ${result.written} files${summaryTail}`);
          rendered = true;

          if (result.renamed > 0 || result.deleted > 0) {
            clack.log.info(`hooks: ${result.renamed} renamed, ${result.deleted} deleted`);
          }

          const plan = planPostRender(result, {
            // Answers mode is non-interactive end-to-end: leave setup tasks
            // pending for `hex setup` rather than driving the loop.
            isTTY: Boolean(process.stdout.isTTY) && !answersMode,
            setup: opts.setup,
          });

          if (plan.kind === 'no-tasks') {
            clack.outro(brand.done(`done — ${outputDir}`));
            return;
          }

          // Write the initial checklist before doing anything else, so a hard
          // exit at this point still leaves the project in a recoverable state.
          await writeChecklist(outputDir, plan.initial);

          if (plan.setupMessage) {
            clack.note(plan.setupMessage, 'Post-scaffold setup');
          }

          // M14.7: validate `run:` commands before any execution path can fire.
          // Each bundle in the tree is checked against ITS OWN sourceKind: a
          // FileSource recipe composing a git component still subjects the
          // git child's `run:` declarations to strict allowlist, even when
          // the user passed `--trust-local`. The root's `--trust-local`
          // gate lifts only for FileSource bundles.
          const trustPolicy = resolveTrustPolicy(config);
          try {
            validateBundleAllowlistRecursive(
              bundle,
              ctx.resolved,
              opts.trustLocal,
              trustPolicy.allowlist,
            );
          } catch (err) {
            if (err instanceof SetupExecutorError) {
              clack.log.error(err.message);
              clack.outro(
                `setup task allowlist violation — files written but no commands will run. Inspect ${outputDir} or pass --trust-local for local templates.`,
              );
              return;
            }
            throw err;
          }

          if (!plan.interactive) {
            clack.outro(
              `${plan.pendingCount} setup tasks pending — run ${brand.bold('hex setup')} from ${outputDir}`,
            );
            return;
          }

          // M15.3: gate auto-execution of `run:`/`open:` tasks on source
          // trust. A local (file) source — or a remote source the user has
          // vouched for in `trust.sources` — auto-runs as before. An
          // untrusted remote source's tasks run code from a stranger, so we
          // ask the user how to proceed rather than executing silently.
          const runMode = await decideRunMode({
            bundle,
            templateArg,
            policy: trustPolicy,
            actionableCount: countActionableTasks(plan.initial),
          });
          if (runMode === 'skip') {
            clack.outro(
              `${plan.pendingCount} setup tasks pending — review the template, then run ${brand.bold('hex setup')} from ${outputDir}`,
            );
            return;
          }

          // M14.7: offer to auto-execute every actionable (`run:`/`open:`)
          // pending task. Successful runs are marked done atomically; failures
          // stay pending and drop into the interactive loop below.
          const afterPass = await maybeAutoExecutePass(
            outputDir,
            plan.initial,
            runMode === 'review',
          );

          // If the auto-pass cleared every pending task, don't drop into the
          // interactive review loop — it would re-interrogate already-done
          // tasks with a confusing "What now?" (Mark as undone / Skip / Quit,
          // no clean exit). Report completion and finish. The loop still runs
          // when manual (detail-only) or failed tasks remain pending.
          if (countByStatus(afterPass).pending === 0) {
            printSetupOutro({ checklist: afterPass, quit: false, steps: [] });
            return;
          }

          const setupResult = await runSetupSession(
            { rootDir: outputDir, checklist: afterPass },
            createClackPrompter(),
            { runTask: makeInteractiveRunner(outputDir) },
          );
          printSetupOutro(setupResult);
        } catch (err) {
          if (err instanceof PromptCancelledError) throw err;
          if (!rendered) spinner.stop('render failed');
          clack.log.error(
            `hex new failed ${rendered ? 'after rendering' : 'while rendering or running its hooks'}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          clack.outro(
            `A partial project may remain at ${outputDir} — inspect or delete it, then re-run. From inside it, \`hex doctor\` reports its state.`,
          );
          process.exitCode = 1;
          return;
        }
      },
    );
}

/**
 * The post-render decision: whether to run the interactive setup loop,
 * defer it with a follow-up hint, or do nothing because the template
 * shipped no setup tasks. Extracted as a pure function so the action
 * callback's branch logic is unit-testable without touching `clack`,
 * the TTY, or `process.stdout`.
 */
export type PostRenderPlan =
  | { kind: 'no-tasks' }
  | {
      kind: 'has-tasks';
      /** True iff we should drive the interactive setup loop. */
      interactive: boolean;
      /** The checklist to write at the end of the render. */
      initial: Checklist;
      /** Pending count, for the deferred-setup outro message. */
      pendingCount: number;
      setupMessage?: string;
    };

export function planPostRender(
  result: NewRenderSummary,
  env: { isTTY: boolean; setup: boolean },
): PostRenderPlan {
  if (result.tasks.length === 0) return { kind: 'no-tasks' };
  return {
    kind: 'has-tasks',
    interactive: env.isTTY && env.setup,
    initial: checklistFromTasks(result.tasks),
    pendingCount: result.tasks.length,
    ...(result.setupMessage !== undefined ? { setupMessage: result.setupMessage } : {}),
  };
}

/**
 * M14.7: offer to auto-execute every pending actionable task, then
 * return the resulting checklist. The interactive setup loop picks up
 * whatever is still pending. When nothing is actionable, or the user
 * declines the confirm prompt, the input checklist returns unchanged.
 *
 * Each task prints its declared action before running so the user
 * knows which command produced any spawned output the prompt is about
 * to occlude.
 */
/** Auto-run decision for a source: run normally, confirm each, or skip. */
export type RunMode = 'auto' | 'review' | 'skip';

/**
 * Decide how a template's actionable setup tasks should run (M15.3),
 * prompting only when the source is an untrusted remote one. A trusted
 * source (local, or remote in `trust.sources`) runs in `auto` mode with
 * no extra prompt. An untrusted remote source gets the trust / review /
 * skip choice; picking "trust" persists the source to config so the
 * prompt never recurs for it.
 */
async function decideRunMode(args: {
  bundle: ComponentBundle;
  templateArg?: string;
  policy: TrustPolicy;
  actionableCount: number;
}): Promise<RunMode> {
  if (args.actionableCount === 0) return 'auto';

  const trust = classifySource({
    sourceKind: args.bundle.sourceKind,
    identifier: sourceTrustIdentifier(args.bundle, args.templateArg),
    policy: args.policy,
  });
  if (trust.kind === 'trusted') return 'auto';

  clack.log.warn(
    `${brand.bold(trust.identifier)} is an ${brand.bold('untrusted remote source')} — its setup tasks run code on your machine.`,
  );
  const choice = await clack.select({
    message: 'How do you want to proceed?',
    options: [
      {
        value: 'trust',
        label: 'Trust this source & run its tasks',
        hint: 'remembers it in config',
      },
      { value: 'review', label: 'Review each command before it runs', hint: 'this run only' },
      { value: 'skip', label: 'Skip — leave tasks pending', hint: 'run later with hex setup' },
    ],
    initialValue: 'review',
  });
  if (clack.isCancel(choice) || choice === 'skip') return 'skip';
  if (choice === 'trust') {
    const { configPath } = await trustSource(trust.identifier);
    clack.log.success(`Trusted ${trust.identifier} ${brand.dim(`→ ${configPath}`)}`);
    return 'auto';
  }
  return 'review';
}

async function maybeAutoExecutePass(
  outputDir: string,
  initial: Checklist,
  reviewEach = false,
): Promise<Checklist> {
  const count = countActionableTasks(initial);
  if (count === 0) return initial;

  const confirm = await clack.confirm({
    message: `Run ${count} setup task${count === 1 ? '' : 's'} now?`,
    initialValue: true,
  });
  if (typeof confirm !== 'boolean' || !confirm) return initial;

  const result: ExecutorPassResult = await runExecutorPass(initial, {
    cwd: outputDir,
    ritualEffects: defaultRitualEffects,
    ...(reviewEach && { requireConfirm: true }),
    // narrate (in ritualEffects) prints the structured plan per task;
    // the per-task "running X" line that lived here in M14.7 would
    // duplicate that, so it's gone. Completion outcomes still surface
    // here as ✓ / ✗ summaries.
    onTaskComplete: (report) => {
      if (report.markedDone) {
        clack.log.success(`${sym.ok()} ${report.task.title}`);
        return;
      }
      const reason = describeFailure(report.outcome);
      clack.log.error(`${sym.err()} ${report.task.title}${reason ? ` — ${reason}` : ''}`);
    },
  });
  return result.checklist;
}

function describeFailure(outcome: RitualOutcome): string {
  if (outcome.kind === 'spawn-error') return outcome.message;
  if (outcome.kind === 'ran' || outcome.kind === 'opened-and-ran')
    return `exited ${outcome.exitCode}`;
  if (outcome.kind === 'declined') return 'skipped';
  return '';
}

/**
 * Walk a bundle (and its resolved recipe tree, when present) and
 * validate every level's `run:` declarations against the appropriate
 * allowlist gate. Each level uses ITS OWN `sourceKind`, so a recipe
 * mixing local + git children correctly applies strict allowlist to
 * the git children even under `--trust-local`.
 */
function validateBundleAllowlistRecursive(
  bundle: ComponentBundle,
  resolved: ResolvedRecipe | undefined,
  trustLocal: boolean,
  allowlist: readonly string[],
): void {
  validateSetupTasksAllowlist(bundle.manifest.setup?.tasks ?? [], {
    sourceKind: bundle.sourceKind,
    trustLocal,
    allowlist,
  });
  if (resolved) {
    for (const child of resolved.children.values()) {
      validateBundleAllowlistRecursive(child.bundle, child.resolved, trustLocal, allowlist);
    }
  }
}

/**
 * The identifier a remote source is matched against `trust.sources`
 * (M15.3). A catalogue-resolved bundle uses the catalogue repo URL (the
 * same value `hex hive add` writes); a bundle loaded directly from a git
 * argument uses that argument. `file` sources need no identifier.
 */
function sourceTrustIdentifier(bundle: ComponentBundle, templateArg?: string): string | undefined {
  if (bundle.catalogueSource) return bundle.catalogueSource.catalogueUrl;
  if (bundle.sourceKind === 'git') return templateArg;
  return undefined;
}

/**
 * Whether `arg` should be loaded as a filesystem path rather than resolved
 * as a template name / catalogue address. We deliberately do NOT treat "any
 * string containing a slash" as a path — a qualified catalogue address like
 * `acme/api` contains `/` but must fall through to catalogue resolution
 * (M15.4). A relative path with a separator is still caught when it actually
 * exists (`existsSync`); a non-existent slashed string isn't loadable as a
 * path anyway, so letting it fall through to discovery/catalogue gives the
 * right error. Leading `./`, `../`, `/`, `~`, and `isAbsolute` (covers
 * Windows `C:\…` / `C:/…`) remain explicit path signals.
 */
export function looksLikePath(arg: string): boolean {
  return (
    arg.startsWith('.') ||
    arg.startsWith('/') ||
    arg.startsWith('~') ||
    isAbsolute(arg) ||
    existsSync(arg)
  );
}

async function resolveTemplate(arg: string | undefined): Promise<ComponentBundle> {
  if (arg && looksLikePath(arg)) {
    return loadFromPath(arg, 'file');
  }

  const config = await loadConfig();
  const { templates, warnings } = await discoverTemplates(config);

  for (const w of warnings) clack.log.warn(w);

  if (arg) {
    // M13.4: if the arg parses as a catalogue address (`<ns>/<name>` or
    // a bare name with an `@<version>`), try the configured catalogue
    // sources before falling back to the discovered-templates list.
    const parsed = tryParseCatalogueAddress(arg);
    // A qualified (`<ns>/<name>`) address or any address with an `@`
    // version spec is unambiguously a catalogue address — try catalogues
    // first; a bare name (no `@`) falls through to discovery first.
    if (parsed && (parsed.marketplace !== null || arg.includes('@'))) {
      const fromCatalogue = await resolveTemplateFromCatalogues(config, parsed, arg);
      if (fromCatalogue) return fromCatalogue;
    }

    // Discovered local / git templates by bare name.
    const match = templates.find((t) => t.name === arg);
    if (match) return loadFromPath(match.rootPath, match.sourceKind);

    // Bare name with no version spec — try catalogues as a last resort
    // before failing.
    if (parsed && parsed.marketplace === null) {
      const fromCatalogue = await resolveTemplateFromCatalogues(config, parsed, arg);
      if (fromCatalogue) return fromCatalogue;
    }

    throw new NewCommandError(
      `no template named "${arg}" found in configured source roots or catalogues — try "hex list" to see what's available, or pass a path.`,
    );
  }

  if (templates.length === 0) {
    throw new NewCommandError(
      'no templates available — configure source roots in ~/.hex/config.yaml or pass a path.',
    );
  }

  const picked = await clack.select({
    message: 'Pick a template',
    options: templates.map((t) => ({
      value: { rootPath: t.rootPath, sourceKind: t.sourceKind },
      label: `${t.name} ${brand.dim(`@${t.version}`)}`,
      hint: hintFor(t),
    })),
  });
  if (clack.isCancel(picked)) throw new PromptCancelledError();

  const choice = picked as { rootPath: string; sourceKind: 'file' | 'git' };
  return loadFromPath(choice.rootPath, choice.sourceKind);
}

/**
 * Try parsing `arg` as a catalogue address (`<ns>/<name>(@<version>)?`
 * or `<name>(@<version>)?`). Returns `null` if the parser rejects it —
 * a malformed address shouldn't blow up the path / discovery fallback.
 */
export function tryParseCatalogueAddress(
  arg: string,
): { marketplace: string | null; name: string; version: string } | null {
  try {
    return parseAddress(arg);
  } catch (err) {
    if (err instanceof AddressError) return null;
    throw err;
  }
}

/**
 * Test-injectable opts for `resolveTemplateFromCatalogues`. Production
 * calls supply `clack.log.warn`; tests pass a buffer and a tmp `cacheDir`
 * so they're hermetic.
 */
export type CatalogueResolveOpts = {
  /** Forwarded to `loadCatalogueProviders` (cache root). */
  cacheDir?: string;
  /** Callback for non-fatal warnings (bad catalogue, broken package). */
  warn?: (message: string) => void;
};

/**
 * Resolve a parsed address against the configured catalogue sources.
 *
 * Qualified address (`<ns>/<name>`) — pin exactly the catalogue whose
 * namespace matches; an unknown namespace throws a clear error.
 *
 * Bare address — walk catalogue sources in declared order; the first one
 * whose `marketplace.yaml` lists a satisfying version of the package
 * wins. A catalogue that fails to load contributes a warning and is
 * skipped — one bad source must not sink resolution.
 *
 * Returns `null` only for the bare-name case when no catalogue lists the
 * package; the caller falls back to a `hex list`-style hint. A qualified
 * address with an unknown namespace or version always throws.
 */
export async function resolveTemplateFromCatalogues(
  config: HexConfig,
  parsed: { marketplace: string | null; name: string; version: string },
  raw: string,
  opts: CatalogueResolveOpts = {},
): Promise<ComponentBundle | null> {
  const warn = opts.warn ?? ((m: string) => clack.log.warn(m));
  const providerOpts: { cacheDir?: string } = {};
  if (opts.cacheDir !== undefined) providerOpts.cacheDir = opts.cacheDir;

  const { providers, warnings: providerWarnings } = await loadCatalogueProviders(
    config,
    providerOpts,
  );
  for (const w of providerWarnings) warn(w);
  if (providers.length === 0) return null;

  const selectedProviders = selectProvidersFor(parsed, providers, raw);

  for (const provider of selectedProviders) {
    const pkg = provider.loaded.yaml.packages.find((p) => p.name === parsed.name);
    if (!pkg) continue;
    const availableTags = pkg.versions.map((v) => v.tag);
    if (pickVersion(availableTags, parsed.version) === null) {
      // Qualified address — the user pinned a catalogue that doesn't
      // satisfy. Fail loudly so they don't waste time waiting for a
      // bare-name fallback that won't come.
      if (parsed.marketplace !== null) {
        throw new NewCommandError(
          `no version of "${provider.id}/${parsed.name}" satisfies "${parsed.version}" ` +
            `(available: ${availableTags.join(', ')})`,
        );
      }
      continue;
    }
    try {
      const resolveOpts: { cacheDir?: string } = {};
      if (opts.cacheDir !== undefined) resolveOpts.cacheDir = opts.cacheDir;
      const result = await resolveFromCatalogue(
        provider.loaded,
        parsed.name,
        parsed.version,
        resolveOpts,
      );
      // Record the *configured* ref (or absence thereof) — not the
      // resolved one, which is the literal `'HEAD'` when the user left
      // it blank and would mislead M11 upgrade re-resolution.
      result.bundle.catalogueSource = {
        catalogueUrl: provider.configSource.url,
        ...(provider.configSource.ref !== undefined
          ? { catalogueRef: provider.configSource.ref }
          : {}),
        namespace: provider.id,
        packageName: result.name,
      };
      return result.bundle;
    } catch (err) {
      if (err instanceof CatalogueSourceError && parsed.marketplace !== null) {
        throw new NewCommandError(err.message);
      }
      if (err instanceof CatalogueSourceError) {
        warn(`${provider.id}: ${err.message}`);
        continue;
      }
      throw err;
    }
  }

  if (parsed.marketplace !== null) {
    throw new NewCommandError(
      `catalogue "${parsed.marketplace}" does not list a package "${parsed.name}"`,
    );
  }
  return null;
}

function selectProvidersFor(
  parsed: { marketplace: string | null; name: string; version: string },
  providers: CatalogueProvider[],
  raw: string,
): CatalogueProvider[] {
  if (parsed.marketplace === null) return providers;
  const match = providers.find((p) => p.id === parsed.marketplace);
  if (!match) {
    const configured = providers.map((p) => p.id).join(', ') || '(none)';
    throw new NewCommandError(
      `catalogue namespace "${parsed.marketplace}" in "${raw}" is not configured ` +
        `(configured catalogues: ${configured})`,
    );
  }
  return [match];
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
