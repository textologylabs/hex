import {
  type Checklist,
  type ChecklistTask,
  markTask,
  updateChecklist,
} from '../checklist/index.js';
import {
  type RitualEffects,
  type RitualOutcome,
  ritualOutcomeSucceeded,
  runRitualTask,
} from './ritual.js';
import { type RunEffects, defaultRunEffects } from './run.js';

/**
 * Auto-execute sweep (M14.7). Before the user reaches the interactive
 * `hex setup` loop, `hex new` offers to run every actionable
 * (`run:`/`open:`) pending task in declared order — successes get
 * marked done atomically, failures stay pending so the interactive
 * loop can pick them up. Pure-`detail:` tasks are passed over here
 * and surface in the interactive loop instead.
 */

export type ExecutorTaskReport = {
  task: ChecklistTask;
  outcome: RitualOutcome;
  /** Whether the outcome resulted in the task being marked done. */
  markedDone: boolean;
};

export type ExecutorPassResult = {
  checklist: Checklist;
  reports: ExecutorTaskReport[];
};

export type ExecutorPassOpts = {
  /** Working directory in which `run:` commands execute. */
  cwd: string;
  /** Injected executor effects (test seam). Defaults to real spawn + browser-open. */
  effects?: RunEffects;
  /**
   * Injected ritual effects (M14.11). When provided, every actionable
   * task is driven through the narrate → confirm → open → pause → run
   * ritual. Tests substitute scripted prompts; the CLI wires a
   * clack-based implementation. Omitting this falls back to a silent
   * auto-proceed (no narration, no confirm, no pause) for backwards
   * compatibility with the M14.7 unit tests.
   */
  ritualEffects?: RitualEffects;
  /**
   * "Review each" mode (M15.3) — confirm every `run:` task individually,
   * not just the batch. Set when auto-running an untrusted remote
   * source's tasks. Threaded into `runRitualTask`.
   */
  requireConfirm?: boolean;
  /** Generated-app root for the atomic checklist updates. Defaults to `cwd`. */
  rootDir?: string;
  /**
   * Optional progress hook fired before each task runs — production
   * wiring uses this to print "→ running task X" so the user knows
   * what the next interactive prompt belongs to.
   */
  onTaskStart?: (task: ChecklistTask) => void;
  /**
   * Optional progress hook fired after each task's outcome is known —
   * production wiring prints "✓ done" / "✗ exited 1" lines.
   */
  onTaskComplete?: (report: ExecutorTaskReport) => void;
};

/** True if the task carries an action the executor can run automatically. */
export function isActionable(task: ChecklistTask): boolean {
  return task.run !== undefined || task.open !== undefined;
}

/** Count pending actionable tasks — what the "Run N tasks?" prompt reports. */
export function countActionableTasks(checklist: Checklist): number {
  return checklist.tasks.filter((t) => t.status === 'pending' && isActionable(t)).length;
}

/**
 * Run every pending actionable task in order. Persists each success
 * via `updateChecklist` (atomic, lock-serialised — safe against a
 * concurrent `hex setup`) so a hard exit mid-pass loses no progress.
 * Returns the final in-memory checklist plus a per-task report for
 * the caller to render.
 */
export async function runExecutorPass(
  initial: Checklist,
  opts: ExecutorPassOpts,
): Promise<ExecutorPassResult> {
  const effects = opts.effects ?? defaultRunEffects;
  const ritualEffects = opts.ritualEffects ?? silentRitualEffects;
  const rootDir = opts.rootDir ?? opts.cwd;
  const reports: ExecutorTaskReport[] = [];
  let checklist = initial;

  const actionable = initial.tasks.filter((t) => t.status === 'pending' && isActionable(t));

  for (let i = 0; i < actionable.length; i++) {
    const task = actionable[i];
    if (!task) continue;
    opts.onTaskStart?.(task);
    const outcome = await runRitualTask(
      {
        id: task.id,
        title: task.title,
        ...(task.run !== undefined && { run: task.run }),
        ...(task.open !== undefined && { open: task.open }),
        ...(task.detail !== undefined && { detail: task.detail }),
      },
      {
        index: i + 1,
        total: actionable.length,
        cwd: opts.cwd,
        ritualEffects,
        runEffects: effects,
        ...(opts.requireConfirm && { requireConfirm: true }),
      },
    );
    const success = ritualOutcomeSucceeded(outcome);
    let markedDone = false;
    if (success) {
      checklist = await updateChecklist(rootDir, (c) => markTask(c, task.id, 'done'));
      markedDone = true;
    }
    const report: ExecutorTaskReport = {
      task: { ...task, status: success ? 'done' : 'pending' },
      outcome,
      markedDone,
    };
    reports.push(report);
    opts.onTaskComplete?.(report);
  }

  return { checklist, reports };
}

/**
 * Default ritual effects — silent auto-proceed. Used when the caller
 * doesn't inject anything, which is exactly the M14.7-era contract
 * (no narration, no confirm, no pause). The CLI layer always provides
 * its clack-based ritual effects in production; tests use scripted
 * implementations. This default keeps backwards compatibility for any
 * caller not yet upgraded.
 */
const silentRitualEffects: RitualEffects = {
  narrate: () => undefined,
  confirm: async () => true,
  awaitContinue: async () => undefined,
};
