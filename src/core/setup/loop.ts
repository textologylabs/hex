import {
  type Checklist,
  type ChecklistTask,
  type TaskStatus,
  markTask,
} from '../checklist/index.js';
import type { Prompter } from '../prompts/types.js';
import { isActionable } from './executor-pass.js';
import { type TaskRunOutcome, outcomeSucceeded } from './run.js';

/** Action taken on a single task during the loop. */
export type SetupAction =
  | 'marked-done'
  | 'marked-pending'
  | 'skipped'
  | 'quit'
  | 'ran-succeeded'
  | 'ran-failed';

/** The change a single toggle applied — handed to `onSave` for a merge-safe persist. */
export type ChecklistChange = { taskId: string; status: TaskStatus };

export type SetupStep = {
  task: ChecklistTask;
  action: SetupAction;
};

export type SetupResult = {
  /** Final checklist — what should be persisted on disk. */
  checklist: Checklist;
  /** True if the user picked "Quit" mid-loop. */
  quit: boolean;
  /** Per-task record. Length equals tasks visited (≤ checklist.tasks.length). */
  steps: SetupStep[];
};

export type SetupOpts = {
  /**
   * Persist callback fired after every status change. The loop saves on
   * each toggle so a hard quit (Ctrl-C) cannot lose progress. `change`
   * identifies the single toggle so a caller can apply it as a
   * merge-safe update (see `updateChecklist`) rather than overwriting
   * the whole file and clobbering a concurrent peer's toggles.
   */
  onSave?: (checklist: Checklist, change: ChecklistChange) => Promise<void> | void;
  /**
   * M14.7: optional task runner. When provided, the picker grows
   * additional choices for pending tasks declaring `run:` and/or
   * `open:` — "Run now" for `run:`, "Open in browser" for `open:`-only.
   * A combined `run:`+`open:` task still gets one "Run now" choice
   * (the executor's contract: open fires first, then run).
   * A successful outcome marks the task done; a failure leaves it
   * pending and surfaces the message via `prompter.note`.
   */
  runTask?: (task: ChecklistTask) => Promise<TaskRunOutcome>;
};

const ACTION_MARK_DONE = 'Mark as done';
const ACTION_MARK_PENDING = 'Mark as undone (back to pending)';
const ACTION_SKIP = 'Skip for now';
const ACTION_QUIT = 'Quit (resume with: hex setup)';
const ACTION_RUN_NOW = 'Run now';
const ACTION_OPEN_IN_BROWSER = 'Open in browser';

/**
 * Walk every task once, regardless of status. For each task:
 *   - Render a note with the task's title + detail and current status.
 *   - Prompt with [toggle, skip, quit].
 *   - Toggle flips the status; skip leaves it; quit ends the loop.
 *
 * State is persisted via `opts.onSave` after every toggle, so even a hard
 * exit (Ctrl-C, terminal close) preserves progress to the moment of the
 * last decision.
 *
 * Pure with respect to stdout: rendering goes through the Prompter's
 * optional `note()` method, which test prompters can capture or omit.
 */
export async function runSetupLoop(
  initial: Checklist,
  prompter: Prompter,
  opts: SetupOpts = {},
): Promise<SetupResult> {
  let checklist = initial;
  const steps: SetupStep[] = [];

  for (let i = 0; i < checklist.tasks.length; i++) {
    const task = checklist.tasks[i];
    if (!task) break;

    renderTaskNote(prompter, task, i, checklist.tasks.length);

    const choices = choicesForTask(task, opts.runTask !== undefined);

    const choice = await prompter.select({
      message: 'What now?',
      choices,
      default: choices[0],
    });

    if (choice === ACTION_QUIT) {
      steps.push({ task, action: 'quit' });
      return { checklist, quit: true, steps };
    }

    if (choice === ACTION_SKIP) {
      steps.push({ task, action: 'skipped' });
      continue;
    }

    if (choice === ACTION_RUN_NOW || choice === ACTION_OPEN_IN_BROWSER) {
      // The runner contract: a single call handles open-and-run for
      // tasks declaring both (open fires first). Success marks the task
      // done atomically; failure leaves it pending with the outcome
      // surfaced via the prompter so the user can decide to retry or
      // skip on the next iteration.
      if (!opts.runTask) {
        // Defensive: the choice would not have been offered without a
        // runner. Skip rather than crash.
        steps.push({ task, action: 'skipped' });
        continue;
      }
      const outcome = await opts.runTask(task);
      if (outcomeSucceeded(outcome)) {
        checklist = markTask(checklist, task.id, 'done');
        if (opts.onSave) await opts.onSave(checklist, { taskId: task.id, status: 'done' });
        steps.push({ task: { ...task, status: 'done' }, action: 'ran-succeeded' });
        // Re-prompt the same task: success → still let user move on
        // by hitting Enter on the (now sole) action option. Stepping
        // forward feels more natural than staying on a done task.
        continue;
      }
      renderRunOutcome(prompter, outcome);
      steps.push({ task, action: 'ran-failed' });
      // On a failure, stay on the same task so the user can retry,
      // open the URL again, mark manually, skip, or quit.
      i--;
      continue;
    }

    // Toggle — flip the status, persist, record.
    const newStatus = task.status === 'pending' ? 'done' : 'pending';
    checklist = markTask(checklist, task.id, newStatus);
    if (opts.onSave) await opts.onSave(checklist, { taskId: task.id, status: newStatus });
    steps.push({
      task: { ...task, status: newStatus },
      action: newStatus === 'done' ? 'marked-done' : 'marked-pending',
    });
  }

  return { checklist, quit: false, steps };
}

function choicesForTask(task: ChecklistTask, hasRunner: boolean): string[] {
  if (task.status !== 'pending') {
    return [ACTION_MARK_PENDING, ACTION_SKIP, ACTION_QUIT];
  }
  const base = [ACTION_MARK_DONE, ACTION_SKIP, ACTION_QUIT];
  if (!hasRunner || !isActionable(task)) return base;
  // Actionable + runner present: lead with the executor choice.
  // For a `run:` task (with or without `open:`) the single combined
  // "Run now" entry covers both — runSetupTask fires `open:` first
  // when present, then `run:`. An `open:`-only task gets the dedicated
  // "Open in browser" wording.
  const action = task.run !== undefined ? ACTION_RUN_NOW : ACTION_OPEN_IN_BROWSER;
  return [action, ...base];
}

function renderRunOutcome(prompter: Prompter, outcome: TaskRunOutcome): void {
  if (!prompter.note) return;
  if (outcome.kind === 'spawn-error') {
    prompter.note(`Could not start the command:\n${outcome.message}`, 'Task failed');
    return;
  }
  if (outcome.kind === 'ran' || outcome.kind === 'opened-and-ran') {
    if (outcome.exitCode === 0) return;
    prompter.note(`Command exited with code ${outcome.exitCode}.`, 'Task failed');
  }
}

function renderTaskNote(
  prompter: Prompter,
  task: ChecklistTask,
  index: number,
  total: number,
): void {
  if (!prompter.note) return;
  const tick = task.status === 'done' ? '✓' : ' ';
  const header = `[${tick}] ${task.title}`;
  const lines = [header];
  if (task.run !== undefined) lines.push('', `run:  ${task.run}`);
  if (task.open !== undefined) lines.push('', `open: ${task.open}`);
  if (task.detail !== undefined) lines.push('', task.detail);
  prompter.note(lines.join('\n'), `Setup task ${index + 1}/${total}`);
}
