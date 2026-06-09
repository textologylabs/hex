import { describe, expect, it } from 'vitest';
import { type Checklist, checklistFromTasks, markTask } from '../../../src/core/checklist/index.js';
import type {
  ConfirmOpts,
  MultiSelectOpts,
  PasswordOpts,
  Prompter,
  SelectOpts,
  TextOpts,
} from '../../../src/core/prompts/types.js';
import { runSetupLoop } from '../../../src/core/setup/loop.js';

/**
 * Scripted prompter for the setup loop. Each call to `select` consumes
 * the next answer in `selectAnswers`. Other widgets are not used by the
 * loop and throw if called. `notes` records every `note()` call so tests
 * can assert on what the user saw.
 */
function scriptedPrompter(selectAnswers: string[]): {
  prompter: Prompter;
  notes: { title?: string; body: string }[];
  selectCalls: SelectOpts[];
} {
  let i = 0;
  const notes: { title?: string; body: string }[] = [];
  const selectCalls: SelectOpts[] = [];

  const prompter: Prompter = {
    text: (_opts: TextOpts) => {
      throw new Error('text() not used by setup loop');
    },
    confirm: (_opts: ConfirmOpts) => {
      throw new Error('confirm() not used by setup loop');
    },
    select: async (opts: SelectOpts) => {
      selectCalls.push(opts);
      const answer = selectAnswers[i++];
      if (answer === undefined) throw new Error(`scripted prompter ran out at index ${i - 1}`);
      if (!opts.choices.includes(answer)) {
        throw new Error(`scripted answer "${answer}" not in choices: ${opts.choices.join(', ')}`);
      }
      return answer;
    },
    multiselect: (_opts: MultiSelectOpts) => {
      throw new Error('multiselect() not used by setup loop');
    },
    password: (_opts: PasswordOpts) => {
      throw new Error('password() not used by setup loop');
    },
    note: (body, title) => {
      notes.push({ title, body });
    },
  };

  return { prompter, notes, selectCalls };
}

describe('runSetupLoop', () => {
  it('walks every task and marks all done when the user picks "Mark as done" each time', async () => {
    const initial = checklistFromTasks([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]);
    const { prompter, notes } = scriptedPrompter(['Mark as done', 'Mark as done']);

    const result = await runSetupLoop(initial, prompter);

    expect(result.quit).toBe(false);
    expect(result.checklist.tasks.every((t) => t.status === 'done')).toBe(true);
    expect(result.steps.map((s) => s.action)).toEqual(['marked-done', 'marked-done']);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.title).toBe('Setup task 1/2');
    expect(notes[1]?.title).toBe('Setup task 2/2');
  });

  it('leaves a task pending when the user picks "Skip for now"', async () => {
    const initial = checklistFromTasks([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]);
    const { prompter } = scriptedPrompter(['Skip for now', 'Mark as done']);

    const result = await runSetupLoop(initial, prompter);

    expect(result.checklist.tasks[0]?.status).toBe('pending');
    expect(result.checklist.tasks[1]?.status).toBe('done');
    expect(result.steps.map((s) => s.action)).toEqual(['skipped', 'marked-done']);
  });

  it('exits early on Quit and reports quit: true', async () => {
    const initial = checklistFromTasks([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]);
    const { prompter } = scriptedPrompter(['Mark as done', 'Quit (resume with: hex setup)']);

    const result = await runSetupLoop(initial, prompter);

    expect(result.quit).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]?.action).toBe('quit');
    expect(result.checklist.tasks[0]?.status).toBe('done');
    // Tasks beyond the quit point retain their original (pending) status.
    expect(result.checklist.tasks[1]?.status).toBe('pending');
    expect(result.checklist.tasks[2]?.status).toBe('pending');
  });

  it('offers a "Mark as undone" option on already-done tasks', async () => {
    const initial: Checklist = markTask(checklistFromTasks([{ id: 'a', title: 'A' }]), 'a', 'done');
    const { prompter, selectCalls } = scriptedPrompter(['Mark as undone (back to pending)']);

    const result = await runSetupLoop(initial, prompter);

    expect(result.checklist.tasks[0]?.status).toBe('pending');
    expect(result.steps[0]?.action).toBe('marked-pending');
    expect(selectCalls[0]?.choices).toContain('Mark as undone (back to pending)');
    expect(selectCalls[0]?.choices).not.toContain('Mark as done');
  });

  it('persists via onSave after every toggle, but not on skip', async () => {
    const initial = checklistFromTasks([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]);
    const saves: Checklist[] = [];
    const { prompter } = scriptedPrompter(['Mark as done', 'Skip for now', 'Mark as done']);

    await runSetupLoop(initial, prompter, {
      onSave: (c) => {
        saves.push(c);
      },
    });

    // Two toggles → two saves; the skip in the middle did not save.
    expect(saves).toHaveLength(2);
    expect(saves[0]?.tasks[0]?.status).toBe('done');
    expect(saves[0]?.tasks[2]?.status).toBe('pending');
    expect(saves[1]?.tasks[2]?.status).toBe('done');
  });

  it('returns immediately for an empty checklist', async () => {
    const { prompter } = scriptedPrompter([]);
    const result = await runSetupLoop({ tasks: [] }, prompter);
    expect(result).toEqual({ checklist: { tasks: [] }, quit: false, steps: [] });
  });

  it('renders task detail in the note when present, omits when absent', async () => {
    const initial = checklistFromTasks([
      { id: 'a', title: 'Install', detail: 'npm install' },
      { id: 'b', title: 'Push' },
    ]);
    const { prompter, notes } = scriptedPrompter(['Skip for now', 'Skip for now']);

    await runSetupLoop(initial, prompter);

    expect(notes[0]?.body).toContain('Install');
    expect(notes[0]?.body).toContain('npm install');
    expect(notes[1]?.body).toContain('Push');
    expect(notes[1]?.body).not.toContain('npm install');
  });

  it('shows ✓ in the note for already-done tasks', async () => {
    const initial: Checklist = markTask(checklistFromTasks([{ id: 'a', title: 'A' }]), 'a', 'done');
    const { prompter, notes } = scriptedPrompter(['Skip for now']);

    await runSetupLoop(initial, prompter);
    expect(notes[0]?.body).toContain('[✓]');
  });

  it('renders run: and open: lines in the task note for actionable tasks', async () => {
    const initial = checklistFromTasks([
      { id: 'a', title: 'Install', run: 'npm install', detail: 'manual fallback' },
      { id: 'b', title: 'Dashboard', open: 'https://example.test/' },
    ]);
    const { prompter, notes } = scriptedPrompter(['Skip for now', 'Skip for now']);

    await runSetupLoop(initial, prompter);

    expect(notes[0]?.body).toContain('run:');
    expect(notes[0]?.body).toContain('npm install');
    expect(notes[0]?.body).toContain('manual fallback');
    expect(notes[1]?.body).toContain('open:');
    expect(notes[1]?.body).toContain('https://example.test/');
  });

  describe('with runTask (M14.7)', () => {
    it('offers "Run now" for actionable pending tasks when a runner is supplied', async () => {
      const initial = checklistFromTasks([{ id: 'a', title: 'A', run: 'npm install' }]);
      const { prompter, selectCalls } = scriptedPrompter(['Run now']);
      const runTask = async () => ({ kind: 'ran' as const, exitCode: 0 });

      const result = await runSetupLoop(initial, prompter, { runTask });

      expect(selectCalls[0]?.choices[0]).toBe('Run now');
      expect(result.checklist.tasks[0]?.status).toBe('done');
      expect(result.steps[0]?.action).toBe('ran-succeeded');
    });

    it('offers "Open in browser" for open:-only tasks', async () => {
      const initial = checklistFromTasks([{ id: 'a', title: 'A', open: 'https://example.test/' }]);
      const { prompter, selectCalls } = scriptedPrompter(['Open in browser']);
      const runTask = async () => ({
        kind: 'opened' as const,
        url: 'https://example.test/',
      });

      const result = await runSetupLoop(initial, prompter, { runTask });
      expect(selectCalls[0]?.choices[0]).toBe('Open in browser');
      expect(result.checklist.tasks[0]?.status).toBe('done');
    });

    it('non-actionable tasks (detail-only) get the regular Mark/Skip/Quit choices even with a runner', async () => {
      const initial = checklistFromTasks([{ id: 'a', title: 'A', detail: 'manual' }]);
      const { prompter, selectCalls } = scriptedPrompter(['Mark as done']);
      const runTask = async () => ({ kind: 'no-action' as const });

      await runSetupLoop(initial, prompter, { runTask });
      expect(selectCalls[0]?.choices).not.toContain('Run now');
      expect(selectCalls[0]?.choices).not.toContain('Open in browser');
    });

    it('a failed run keeps the task pending and re-prompts the SAME task', async () => {
      const initial = checklistFromTasks([{ id: 'a', title: 'A', run: 'npm install' }]);
      const { prompter, selectCalls, notes } = scriptedPrompter([
        'Run now', // first time → fails
        'Skip for now', // user backs off after failure
      ]);
      let calls = 0;
      const runTask = async () => {
        calls++;
        return { kind: 'ran' as const, exitCode: 1 };
      };

      const result = await runSetupLoop(initial, prompter, { runTask });

      expect(calls).toBe(1);
      expect(result.checklist.tasks[0]?.status).toBe('pending');
      expect(result.steps.map((s) => s.action)).toEqual(['ran-failed', 'skipped']);
      // Two prompts against the same task (re-prompted after the failure).
      expect(selectCalls).toHaveLength(2);
      // The failure note surfaces the exit code.
      expect(notes.some((n) => n.body.includes('exited with code 1'))).toBe(true);
    });

    it('persists via onSave only when the run succeeds', async () => {
      const initial = checklistFromTasks([{ id: 'a', title: 'A', run: 'npm install' }]);
      const { prompter } = scriptedPrompter(['Run now']);
      const saves: Checklist[] = [];
      const runTask = async () => ({ kind: 'ran' as const, exitCode: 0 });

      await runSetupLoop(initial, prompter, {
        runTask,
        onSave: (c) => {
          saves.push(c);
        },
      });

      expect(saves).toHaveLength(1);
      expect(saves[0]?.tasks[0]?.status).toBe('done');
    });
  });
});
