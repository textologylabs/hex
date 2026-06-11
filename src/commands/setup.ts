import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as clack from '@clack/prompts';
import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import {
  CHECKLIST_REL_PATH,
  type Checklist,
  type LoadedChecklist,
  countByStatus,
  markTask,
  readChecklistUpward,
  updateChecklist,
  writeChecklist,
} from '../core/checklist/index.js';
import type { ChecklistTask } from '../core/checklist/index.js';
import { createClackPrompter } from '../core/prompts/clack-prompter.js';
import type { Prompter } from '../core/prompts/types.js';
import { type SetupResult, runSetupLoop } from '../core/setup/loop.js';
import { type RitualEffects, type RitualOutcome, runRitualTask } from '../core/setup/ritual.js';
import { type RunEffects, defaultRunEffects } from '../core/setup/run.js';

export class SetupCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupCommandError';
  }
}

export type SetupSession = {
  /** Generated-app root containing `.hex/checklist.yaml`. */
  rootDir: string;
  checklist: Checklist;
};

/**
 * Drive the interactive setup loop against a session, persisting the
 * checklist to disk after every toggle. Pure data layer — emits no
 * stdout itself; rendering happens through the prompter.
 *
 * M14.7: `runTask` enables the "Run now" / "Open in browser" picker
 * choices for actionable tasks. Omit it for unit-test sessions that
 * shouldn't exercise the executor.
 */
export async function runSetupSession(
  session: SetupSession,
  prompter: Prompter,
  opts: { runTask?: (task: ChecklistTask) => Promise<RitualOutcome> } = {},
): Promise<SetupResult> {
  const checklistPath = join(session.rootDir, CHECKLIST_REL_PATH);
  return runSetupLoop(session.checklist, prompter, {
    onSave: async (current, change) => {
      // First toggle in a session whose checklist hasn't reached disk
      // yet (the prod flow has `hex new` create it, but tests can
      // skip that step) — write our in-memory state through.
      // Subsequent toggles apply just the diff under a lock so a
      // concurrent peer's toggles aren't clobbered by last-writer-wins.
      if (!existsSync(checklistPath)) {
        await writeChecklist(session.rootDir, current);
        return;
      }
      await updateChecklist(session.rootDir, (c) => markTask(c, change.taskId, change.status));
    },
    ...(opts.runTask !== undefined && { runTask: opts.runTask }),
  });
}

/**
 * Build a `runTask` closure that the interactive loop calls when the
 * user picks "Run now" / "Open in browser". Routes each invocation
 * through the M14.11 ritual (narrate → confirm-if-open → open → pause
 * → run) so the picker behaviour matches the auto-execute pass — a
 * user never gets a surprise browser pop.
 */
export function makeInteractiveRunner(
  cwd: string,
  effects: RunEffects = defaultRunEffects,
  ritualEffects: RitualEffects = defaultRitualEffects,
): (task: ChecklistTask) => Promise<RitualOutcome> {
  return (task) =>
    runRitualTask(
      {
        id: task.id,
        title: task.title,
        ...(task.run !== undefined && { run: task.run }),
        ...(task.open !== undefined && { open: task.open }),
        ...(task.detail !== undefined && { detail: task.detail }),
      },
      {
        // Picker-driven runs are one-off — index/total aren't meaningful
        // outside the auto-pass. The narration header still renders
        // sensibly (`Setup task 1/1`).
        index: 1,
        total: 1,
        cwd,
        ritualEffects,
        runEffects: effects,
      },
    );
}

/**
 * Production ritual effects — clack-based prompts. Each task's plan is
 * rendered as a `clack.note` panel; the confirm + awaitContinue are
 * yes/no prompts that the user just hits Enter through in the happy
 * path. Cancel / Esc on either prompt returns false (declines the
 * task — it stays pending so the user can try again later).
 */
export const defaultRitualEffects: RitualEffects = {
  narrate(task, index, total, plan) {
    clack.note(plan, ` Setup task ${index}/${total}: ${task.title} `);
  },
  async confirm(_task) {
    const ok = await clack.confirm({
      message: 'Proceed?',
      initialValue: true,
    });
    return ok === true;
  },
  async awaitContinue(_task) {
    await clack.confirm({
      message: 'Done in the browser? Continue',
      initialValue: true,
    });
    // Whatever the user picked (yes/no/cancel), we don't gate further on
    // their answer — the only purpose of this prompt is to PAUSE until
    // they've finished their browser work. The subsequent `run:` (if
    // any) will surface its own success/failure independently.
  },
};

export function registerSetup(program: Command): void {
  program
    .command('setup')
    .description('walk through outstanding setup tasks for the current project')
    .action(async () => {
      await runSetupCommand(process.cwd(), defaultSetupCommandEffects);
    });
}

/**
 * Side effects the `hex setup` command performs, abstracted so the
 * action callback's branch logic is testable end-to-end without
 * touching the real process or the real clack prompter.
 */
export type SetupCommandEffects = {
  stderr: { write(s: string): void };
  setExitCode: (code: number) => void;
  printIntro: (loaded: LoadedChecklist) => void;
  printOutro: (result: SetupResult) => void;
  prompterFactory: () => Prompter;
};

/** Production effects — the action callback wires this. */
export const defaultSetupCommandEffects: SetupCommandEffects = {
  stderr: process.stderr,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  printIntro: printSetupIntro,
  printOutro: printSetupOutro,
  prompterFactory: createClackPrompter,
};

/**
 * The `hex setup` action's full flow with side effects injected. Two
 * branches: a missing checklist exits with code 1 and a user-facing
 * stderr message; otherwise the interactive setup session runs.
 */
export async function runSetupCommand(cwd: string, effects: SetupCommandEffects): Promise<void> {
  const loaded = await readChecklistUpward(cwd);
  if (!loaded) {
    effects.stderr.write(
      `${brand.error('No .hex/checklist.yaml found in the current directory or any ancestor.')}\n`,
    );
    effects.setExitCode(1);
    return;
  }

  effects.printIntro(loaded);

  const result = await runSetupSession(
    { rootDir: loaded.rootDir, checklist: loaded.checklist },
    effects.prompterFactory(),
    { runTask: makeInteractiveRunner(loaded.rootDir) },
  );

  effects.printOutro(result);
}

export function printSetupIntro(loaded: LoadedChecklist): void {
  clack.intro(brand.honeyBold(' hex setup '));
  const counts = countByStatus(loaded.checklist);
  clack.log.info(`${counts.pending} pending, ${counts.done} done`);
}

export function printSetupOutro(result: SetupResult): void {
  const counts = countByStatus(result.checklist);
  if (counts.pending === 0) {
    clack.outro(brand.done('all setup tasks complete ✓'));
    return;
  }
  if (result.quit) {
    clack.outro(`${counts.pending} pending — resume with ${brand.bold('hex setup')}`);
    return;
  }
  clack.outro(`${counts.pending} still pending — resume with ${brand.bold('hex setup')}`);
}
