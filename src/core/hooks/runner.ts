import type { JsHook } from '../manifest/types.js';
import { runPrompts } from '../prompts/engine.js';
import { evalWhen } from '../prompts/expr.js';
import type { Answers, Prompter } from '../prompts/types.js';
import { ProjectFs } from './project-fs.js';
import { createSandbox } from './sandbox.js';

export type RecipeContext = {
  name: string;
  version: string;
};

export type HookLog = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

/**
 * Throwing a HookExecutionError aborts the surrounding render with a
 * message that names the lifecycle and the hook filename, so authoring
 * mistakes show up at the boundary the author thinks in terms of
 * (`pre_render hook "prep.js"`) rather than as a stack trace from the
 * sandbox.
 */
export class HookExecutionError extends Error {
  constructor(
    message: string,
    readonly lifecycle: 'pre_render' | 'post_render',
    readonly hookFilename: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HookExecutionError';
  }
}

export type RunJsHooksOptions = {
  /** Recipe metadata for the surrounding render, if any. */
  recipe?: RecipeContext;
  /** Override the default log sink (which goes to console). */
  log?: HookLog;
  /**
   * Prompter for hook-defined prompts (M7.5). Required if any hook in
   * the list declares a `prompts:` block; omitting it makes a hook with
   * prompts fail clearly with a runtime error rather than silently
   * skipping the prompts.
   */
  prompter?: Prompter;
};

/**
 * Resolve a hook's namespace key. Explicit `hook.name` wins; otherwise
 * the filename minus `.js` is used. The schema constrains explicit
 * names to a safe shape; derived names inherit the filename validation
 * from M7.3 (alphanumeric + `_`, `.`, `-`, ending in `.js`).
 */
function hookNamespace(hook: JsHook): string {
  if (hook.name) return hook.name;
  return hook.js.replace(/\.js$/, '');
}

const defaultLog: HookLog = {
  info(msg) {
    console.log(msg);
  },
  warn(msg) {
    console.warn(msg);
  },
  error(msg) {
    console.error(msg);
  },
};

/**
 * Execute the JS hooks for a single lifecycle moment.
 *
 * Creates a fresh sandbox per call, installs the four context surfaces
 * (`answers`, `project`, `recipe`, `log`), evaluates each eligible hook's
 * source in sequence, and disposes the sandbox before returning. Hooks
 * whose `when:` expression evaluates falsy are skipped without sandbox
 * setup costs.
 *
 * Hook-defined prompts (M7.5): if a hook declares `prompts:`, those
 * prompts fire just before the hook's body runs. Answers land at
 * `answers.hooks.<name>.*` (shared read for the hook script, isolated
 * write to the hook's namespace). The returned `Answers` reflect the
 * merged state so the caller can thread it through to the next phase.
 *
 * A throwing hook aborts the lifecycle (the remaining hooks at the same
 * lifecycle do NOT run) and surfaces as a {@link HookExecutionError}.
 * The caller (`renderBundle`) catches nothing — the error propagates out
 * to abort the render, which is exactly what pre_render needs to
 * short-circuit.
 */
export async function runJsHooks(
  lifecycle: 'pre_render' | 'post_render',
  hooks: JsHook[],
  sources: Record<string, string>,
  outputPath: string,
  answers: Answers,
  opts: RunJsHooksOptions = {},
): Promise<Answers> {
  let live: Answers = answers;
  const eligible = hooks.filter((h) => !h.when || evalWhen(h.when, live));
  if (eligible.length === 0) return live;

  const sandbox = await createSandbox();
  try {
    sandbox.installProjectFs(new ProjectFs(outputPath));
    sandbox.installGlobal('recipe', opts.recipe ?? null);
    const log = opts.log ?? defaultLog;
    sandbox.installHostObject('log', {
      info: (msg) => {
        log.info(String(msg ?? ''));
        return undefined;
      },
      warn: (msg) => {
        log.warn(String(msg ?? ''));
        return undefined;
      },
      error: (msg) => {
        log.error(String(msg ?? ''));
        return undefined;
      },
    });

    for (const hook of eligible) {
      const source = sources[hook.js];
      if (source === undefined) {
        throw new HookExecutionError(
          `${lifecycle} hook "${hook.js}" has no source loaded — bundle loader missed it`,
          lifecycle,
          hook.js,
        );
      }

      if (hook.prompts && hook.prompts.length > 0) {
        if (!opts.prompter) {
          throw new HookExecutionError(
            `${lifecycle} hook "${hook.js}" declares prompts but no prompter is configured`,
            lifecycle,
            hook.js,
          );
        }
        const ns = hookNamespace(hook);
        const namespaced = await runPrompts(hook.prompts, opts.prompter, {});
        live = mergeHookAnswers(live, ns, namespaced);
      }

      sandbox.installGlobal('answers', live);

      try {
        sandbox.runScript(source, hook.js);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new HookExecutionError(
          `${lifecycle} hook "${hook.js}" failed: ${detail}`,
          lifecycle,
          hook.js,
          { cause: err },
        );
      }
    }
  } finally {
    sandbox.dispose();
  }
  return live;
}

/**
 * Return a new answers object with the hook's prompt answers merged at
 * `answers.hooks.<ns>`. Existing entries under that namespace are
 * replaced wholesale — hook prompts fire once per render, so any prior
 * answers at that key are stale.
 */
function mergeHookAnswers(answers: Answers, ns: string, hookAnswers: Answers): Answers {
  const prevHooks = answers.hooks;
  const hooks: Record<string, Answers> =
    prevHooks && typeof prevHooks === 'object' && !Array.isArray(prevHooks)
      ? { ...(prevHooks as Record<string, Answers>) }
      : {};
  hooks[ns] = hookAnswers;
  return { ...answers, hooks };
}
