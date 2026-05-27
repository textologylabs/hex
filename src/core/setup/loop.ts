import {
  type Checklist,
  type ChecklistTask,
  type TaskStatus,
  markTask,
} from '../checklist/index.js';
import type { Prompter } from '../prompts/types.js';

/** Action taken on a single task during the loop. */
export type SetupAction = 'marked-done' | 'marked-pending' | 'skipped' | 'quit';

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
};

const ACTION_MARK_DONE = 'Mark as done';
const ACTION_MARK_PENDING = 'Mark as undone (back to pending)';
const ACTION_SKIP = 'Skip for now';
const ACTION_QUIT = 'Quit (resume with: hex setup)';

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

    const choices =
      task.status === 'pending'
        ? [ACTION_MARK_DONE, ACTION_SKIP, ACTION_QUIT]
        : [ACTION_MARK_PENDING, ACTION_SKIP, ACTION_QUIT];

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

function renderTaskNote(
  prompter: Prompter,
  task: ChecklistTask,
  index: number,
  total: number,
): void {
  if (!prompter.note) return;
  const tick = task.status === 'done' ? '✓' : ' ';
  const header = `[${tick}] ${task.title}`;
  const body = task.detail ? `${header}\n\n${task.detail}` : header;
  prompter.note(body, `Setup task ${index + 1}/${total}`);
}
