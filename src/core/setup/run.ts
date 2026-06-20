import { type ChildProcess, spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { SetupTask } from '../manifest/types.js';

/**
 * Three-action setup-task executor (M14.7). Replaces the
 * "checklist-of-manual-things" UX with a runner that:
 *
 *   - Executes `task.run` via `spawn(stdio: 'inherit')` so interactive
 *     CLIs (`vercel link`) survive the handoff and the user sees their
 *     output in real time.
 *   - Hands `task.open` to the OS browser (`open` / `xdg-open` / `start`).
 *   - Leaves `task.detail`-only tasks alone — those stay in the
 *     interactive `hex setup` loop for the user to walk through.
 *
 * Effects are injected (`spawn`, `openUrl`) so tests can substitute
 * scripted commands and assert browser-open without actually launching
 * a browser. The real-world wiring is `defaultRunEffects` — node's
 * `child_process.spawn` plus the platform-appropriate browser-opener.
 */

/**
 * Allowlisted binaries permitted in `run:` declarations from
 * non-FileSource templates (git / catalogue / marketplace). FileSource
 * templates with `--trust-local` (M7.6) bypass this gate, mirroring
 * the JS-hook trust gradient. Everything else fails at load time with a
 * clear error naming the offending binary.
 *
 * Kept narrow on purpose: package managers, version-control,
 * deploy/release CLIs, and bare `node` cover essentially every
 * legitimate setup task a template could need. Anything more exotic is
 * either (a) really detail-prose, or (b) only ever run from a local
 * template under `--trust-local`.
 */
export const RUN_COMMAND_ALLOWLIST: readonly string[] = [
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'bun',
  'node',
  'git',
  'gh',
  'hex',
  'vercel',
];

export class SetupExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupExecutorError';
  }
}

/**
 * Tokenize a `run:` command string into `{ cmd, args }`. Supports
 * single- and double-quoted segments (so `git commit -m "initial
 * commit"` works) and backslash-escaping inside double quotes. No shell
 * expansion (no `$VAR`, no globs, no `&&` / `|`) — a template that
 * needs those should ship a script file and run `bash script.sh` under
 * `--trust-local`.
 */
export function parseRunCommand(spec: string): { cmd: string; args: string[] } {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (quote === null) {
      if (c === ' ' || c === '\t') {
        if (cur.length > 0) {
          tokens.push(cur);
          cur = '';
        }
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      cur += c;
      continue;
    }
    // Inside a quoted segment.
    if (c === quote) {
      quote = null;
      continue;
    }
    if (quote === '"' && c === '\\' && i + 1 < spec.length) {
      cur += spec[i + 1];
      i++;
      continue;
    }
    cur += c;
  }
  if (quote !== null) {
    throw new SetupExecutorError(`unterminated ${quote} quote in run command: "${spec}"`);
  }
  if (cur.length > 0) tokens.push(cur);
  if (tokens.length === 0) {
    throw new SetupExecutorError(`empty run command: "${spec}"`);
  }
  const [cmd, ...args] = tokens;
  return { cmd: cmd as string, args };
}

/**
 * Validate `tasks` against the allowlist (or skip the check when
 * `trustLocal` is true and the template is a FileSource). Throws on
 * the first offending binary so a malicious / careless `run: rm -rf /`
 * can never reach `spawn`. Called at load time — the user sees the
 * error before any setup pass begins.
 */
export type ValidateTasksOpts = {
  /** `'file'` for FileSource templates, `'git'` for everything else (git/catalogue/marketplace). */
  sourceKind: 'file' | 'git';
  /** When true AND `sourceKind === 'file'`, the allowlist is lifted. */
  trustLocal: boolean;
  /**
   * The effective allowlist (M15.3). Defaults to {@link RUN_COMMAND_ALLOWLIST};
   * callers pass the config-resolved list so an org can tighten (an empty
   * list rejects every `run:` task) or extend it.
   */
  allowlist?: readonly string[];
};

export function validateSetupTasksAllowlist(
  tasks: readonly SetupTask[],
  opts: ValidateTasksOpts,
): void {
  if (opts.sourceKind === 'file' && opts.trustLocal) return;
  const allowlist = opts.allowlist ?? RUN_COMMAND_ALLOWLIST;
  for (const task of tasks) {
    if (task.run === undefined) continue;
    const { cmd } = parseRunCommand(task.run);
    if (!allowlist.includes(cmd)) {
      const shown =
        allowlist.length > 0 ? allowlist.join(', ') : '(empty — all run: tasks blocked)';
      const tail =
        opts.sourceKind === 'file'
          ? 'Pass --trust-local to bypass for local FileSource templates.'
          : 'Add the binary to your config trust.allowlist, or run the task manually.';
      throw new SetupExecutorError(
        `setup task "${task.id}" wants to run "${cmd}" which isn't on the allowlist (${shown}). ${tail}`,
      );
    }
  }
}

/**
 * Effects the executor performs. Injected so tests can swap in a
 * scripted command runner and an in-memory browser-open recorder.
 */
export type RunEffects = {
  /**
   * Spawn a command. Receives the parsed cmd + args + cwd. The real
   * implementation uses `child_process.spawn(stdio: 'inherit')`;
   * tests substitute a scripted runner. Resolves with the exit code.
   */
  spawn(cmd: string, args: string[], cwd: string): Promise<number>;
  /**
   * Open a URL in the user's browser. The real implementation shells
   * out to `open` / `xdg-open` / `start` per platform; tests record
   * the URL without launching anything.
   */
  openUrl(url: string): Promise<void>;
};

function spawnInherit(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    child.on('error', (err) => {
      reject(err);
    });
    child.on('exit', (code) => {
      restoreParentTty();
      resolve(code ?? 1);
    });
  });
}

/**
 * Re-sync the parent's TTY state after an inherited-stdio child exits.
 *
 * An interactive child (e.g. `vercel link`) takes raw control of the shared
 * terminal. On its exit the parent's raw-mode bookkeeping can be left out of
 * sync with the actual termios state — so the next clack prompt's
 * `setRawMode(true)` becomes a no-op against a stale flag, the prompt never
 * truly enters raw mode, and its in-place re-render (cursor-up + erase) fails,
 * stacking a fresh frame on every keystroke. Forcing raw mode OFF here makes
 * the following prompt's enable a genuine cooked→raw transition, so its cursor
 * control lands. No-op off a TTY. (bug: ritual confirm stacking after spawns.)
 */
function restoreParentTty(): void {
  const { stdin } = process;
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(false);
  }
}

function openUrlOnHost(url: string): Promise<void> {
  // Platform-appropriate URL opener. The browser-launcher is fire-
  // and-forget — its exit code says nothing about whether the user
  // actually saw the page — so we resolve as soon as the launcher
  // process is reaped.
  //
  // Crucially we do NOT `detach`/`unref` the launcher: this Promise is
  // `await`ed (the ritual pauses for the user right after), and an
  // awaited Promise does not by itself keep Node's event loop alive.
  // Unref'ing the child handle removed the last ref, so the loop drained
  // and the whole `hex new` process exited 0 mid-ritual — before the
  // browser even opened's exit handler ran — silently skipping the
  // post-open "Continue" pause, the `run:` step, and any later tasks.
  // The launcher (`open`/`start`/`xdg-open`) exits immediately after
  // handing off to the browser, and the browser it spawns is already an
  // independent process, so a plain ref'd spawn is both correct and safe.
  const p = platform();
  const cmd = p === 'darwin' ? 'open' : p === 'win32' ? 'cmd' : 'xdg-open';
  const args = p === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: 'ignore' });
    } catch {
      // Launcher binary missing — surface a no-op rather than a hard
      // failure. The user can click the URL manually; they aren't
      // blocked.
      resolve();
      return;
    }
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}

/** Production effects — real spawn + real platform browser opener. */
export const defaultRunEffects: RunEffects = {
  spawn: spawnInherit,
  openUrl: openUrlOnHost,
};

/** One executor pass over a single task. */
export type TaskRunOutcome =
  | { kind: 'no-action' }
  | { kind: 'opened'; url: string }
  | { kind: 'ran'; exitCode: number }
  | { kind: 'opened-and-ran'; url: string; exitCode: number }
  | { kind: 'spawn-error'; message: string };

/**
 * Run one task's three-action contract:
 *   1. If `open` is set, fire the browser opener.
 *   2. If `run` is set, spawn the command and report the exit code.
 *   3. If neither is set, return `no-action` so the caller (the
 *      interactive picker) renders the `detail:` prose instead.
 *
 * Never throws on a non-zero exit — that's "task failed, try again",
 * not a crash. Only an actual spawn failure (missing binary, OS error)
 * surfaces as `spawn-error`.
 */
export async function runSetupTask(
  task: SetupTask,
  cwd: string,
  effects: RunEffects = defaultRunEffects,
): Promise<TaskRunOutcome> {
  if (task.open !== undefined) {
    await effects.openUrl(task.open);
    if (task.run === undefined) return { kind: 'opened', url: task.open };
    try {
      const exitCode = await runOneSpawn(task.run, cwd, effects);
      return { kind: 'opened-and-ran', url: task.open, exitCode };
    } catch (err) {
      return { kind: 'spawn-error', message: err instanceof Error ? err.message : String(err) };
    }
  }
  if (task.run !== undefined) {
    try {
      const exitCode = await runOneSpawn(task.run, cwd, effects);
      return { kind: 'ran', exitCode };
    } catch (err) {
      return { kind: 'spawn-error', message: err instanceof Error ? err.message : String(err) };
    }
  }
  return { kind: 'no-action' };
}

async function runOneSpawn(spec: string, cwd: string, effects: RunEffects): Promise<number> {
  const { cmd, args } = parseRunCommand(spec);
  return effects.spawn(cmd, args, cwd);
}

/** Whether the outcome counts as "task completed successfully". */
export function outcomeSucceeded(outcome: TaskRunOutcome): boolean {
  if (outcome.kind === 'ran' || outcome.kind === 'opened-and-ran') return outcome.exitCode === 0;
  if (outcome.kind === 'opened') return true;
  return false;
}
