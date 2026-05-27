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
import { createClackPrompter } from '../core/prompts/clack-prompter.js';
import type { Prompter } from '../core/prompts/types.js';
import { type SetupResult, runSetupLoop } from '../core/setup/loop.js';

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
 */
export async function runSetupSession(
  session: SetupSession,
  prompter: Prompter,
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
  });
}

export function registerSetup(program: Command): void {
  program
    .command('setup')
    .description('walk through outstanding setup tasks for the current project')
    .action(async () => {
      await runSetupCommand();
    });
}

async function runSetupCommand(): Promise<void> {
  const loaded = await readChecklistUpward(process.cwd());
  if (!loaded) {
    process.stderr.write(
      `${brand.error('No .hex/checklist.yaml found in the current directory or any ancestor.')}\n`,
    );
    process.exitCode = 1;
    return;
  }

  printSetupIntro(loaded);

  const result = await runSetupSession(
    { rootDir: loaded.rootDir, checklist: loaded.checklist },
    createClackPrompter(),
  );

  printSetupOutro(result);
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
