import type { SetupTask } from '../manifest/types.js';
import { type RunEffects, type TaskRunOutcome, parseRunCommand } from './run.js';

/**
 * Hand-off ritual for actionable setup tasks (M14.11). Replaces the
 * M14.7 fire-everything-immediately model with a proper narrate →
 * confirm → open → pause → run sequence:
 *
 *   1. **Narrate** — render a structured plan describing what Hex is
 *      about to do and what the user needs to do, BEFORE any side
 *      effect fires. The browser should never surprise the user.
 *   2. **Confirm** — for `open:`-bearing tasks, ask "Proceed? (Y/n)"
 *      so the browser pop is on the user's clock, not Hex's.
 *   3. **Open** — fire the browser via `runEffects.openUrl`.
 *   4. **Await continue** — pause with "Press Enter when ready to
 *      continue" so the user can finish their browser work before
 *      Hex moves on.
 *   5. **Run** — spawn the `run:` command via `runEffects.spawn`.
 *
 * Pure `run:`-only tasks skip the confirm + await steps (the batch's
 * "Run N tasks now?" already collected consent). Pure `detail:` tasks
 * are not actionable and never reach the ritual.
 *
 * Side effects are split across two effects bags — `RitualEffects`
 * (narrate, confirm, awaitContinue — the human-facing prompts) and
 * `RunEffects` (spawn, openUrl — the mechanical side effects from
 * M14.7). Tests inject scripted implementations of both; production
 * wiring uses clack-based prompts paired with the real spawn / OS
 * browser opener.
 */

/**
 * Side effects the ritual performs that involve a human at the
 * terminal. Tests substitute these with scripted implementations.
 */
export type RitualEffects = {
  /**
   * Render the plan for `task`. Production wiring uses `clack.note`;
   * tests typically record the call. Returning a Promise is allowed —
   * the orchestrator awaits it before moving on.
   */
  narrate(task: SetupTask, index: number, total: number, plan: string): Promise<void> | void;
  /**
   * Ask the user to confirm before a destructive / disorienting
   * action (browser pop). Default-yes; a cancel/decline returns false.
   * Only fires for `open:`-bearing tasks.
   */
  confirm(task: SetupTask): Promise<boolean>;
  /**
   * Pause for the user to return from the browser. Resolves once the
   * user signals they're done (hits Enter, or otherwise).
   * Only fires after an `open:` succeeds.
   */
  awaitContinue(task: SetupTask): Promise<void>;
};

/**
 * Generate the human-facing plan for a task — the body of the
 * narration. Pure: composes from `run:` / `open:` / `detail:` fields
 * in the natural sequence the executor will perform them.
 *
 * For an `open:` + `run:` task, the plan reads as:
 *   1. Hex will open <url> in your browser
 *   2. <detail text — what the user does in between>
 *   3. Hex will run: <cmd>
 *
 * For an `open:`-only task: just steps 1 + 2 (no run).
 * For a `run:`-only task: a single line — the global "Run N tasks
 * now?" was already the consent + plan-at-a-glance.
 */
export function formatPlan(task: SetupTask): string {
  const lines: string[] = [];
  let step = 1;

  if (task.open !== undefined) {
    lines.push(`  ${step++}. Hex will open ${task.open} in your browser`);
  }

  if (task.detail !== undefined) {
    const detailLines = task.detail.trimEnd().split('\n');
    const head = detailLines[0] ?? '';
    lines.push(`  ${step++}. ${head}`);
    for (let i = 1; i < detailLines.length; i++) {
      const line = detailLines[i] ?? '';
      lines.push(`     ${line}`);
    }
  }

  if (task.run !== undefined) {
    lines.push(`  ${step++}. Hex will run: ${task.run}`);
  }

  if (task.open !== undefined) {
    lines.push('');
    lines.push('  Control returns to this terminal after the browser.');
  }

  return lines.join('\n');
}

/**
 * Outcome of a ritual pass for one task. Extends `TaskRunOutcome` with
 * `declined` — the user said N at the confirm prompt. `declined` is
 * not a failure; the task stays pending so the interactive loop can
 * pick it up later.
 */
export type RitualOutcome = TaskRunOutcome | { kind: 'declined' };

/**
 * True when the outcome should be recorded as the task succeeding —
 * i.e. it should be marked done. Mirrors `outcomeSucceeded` from M14.7
 * but covers the M14.11 `declined` case (false — keep pending).
 */
export function ritualOutcomeSucceeded(outcome: RitualOutcome): boolean {
  if (outcome.kind === 'declined') return false;
  if (outcome.kind === 'ran' || outcome.kind === 'opened-and-ran') return outcome.exitCode === 0;
  if (outcome.kind === 'opened') return true;
  return false;
}

export type RunRitualTaskOpts = {
  /** 1-based task position used in the narration header. */
  index: number;
  /** Total tasks the orchestrator is walking. */
  total: number;
  /** Working directory for the `run:` spawn. */
  cwd: string;
  ritualEffects: RitualEffects;
  runEffects: RunEffects;
};

/**
 * Drive one task through the full ritual. Returns the outcome the
 * orchestrator should record. Never throws on a non-zero exit or a
 * declined confirm — only an actual OS spawn failure (missing binary,
 * etc.) surfaces as `spawn-error`.
 */
export async function runRitualTask(
  task: SetupTask,
  opts: RunRitualTaskOpts,
): Promise<RitualOutcome> {
  const { index, total, cwd, ritualEffects, runEffects } = opts;

  await ritualEffects.narrate(task, index, total, formatPlan(task));

  // Open-bearing tasks consent before the browser pops. `run:`-only
  // tasks were already authorised by the batch-level prompt.
  if (task.open !== undefined) {
    const ok = await ritualEffects.confirm(task);
    if (!ok) return { kind: 'declined' };
    await runEffects.openUrl(task.open);
    await ritualEffects.awaitContinue(task);
  }

  if (task.run !== undefined) {
    try {
      const { cmd, args } = parseRunCommand(task.run);
      const exitCode = await runEffects.spawn(cmd, args, cwd);
      if (task.open !== undefined) {
        return { kind: 'opened-and-ran', url: task.open, exitCode };
      }
      return { kind: 'ran', exitCode };
    } catch (err) {
      return { kind: 'spawn-error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  if (task.open !== undefined) {
    return { kind: 'opened', url: task.open };
  }

  return { kind: 'no-action' };
}
