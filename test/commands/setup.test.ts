import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type SetupCommandEffects,
  runSetupCommand,
  runSetupSession,
} from '../../src/commands/setup.js';
import {
  checklistFromTasks,
  readChecklistUpward,
  writeChecklist,
} from '../../src/core/checklist/index.js';
import type {
  ConfirmOpts,
  MultiSelectOpts,
  PasswordOpts,
  Prompter,
  SelectOpts,
  TextOpts,
} from '../../src/core/prompts/types.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-setup-cmd-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function scriptedPrompter(answers: string[]): Prompter {
  let i = 0;
  return {
    text: (_o: TextOpts) => {
      throw new Error('text() not used');
    },
    confirm: (_o: ConfirmOpts) => {
      throw new Error('confirm() not used');
    },
    select: async (opts: SelectOpts) => {
      const a = answers[i++];
      if (a === undefined) throw new Error(`scripted prompter ran out at ${i - 1}`);
      if (!opts.choices.includes(a)) {
        throw new Error(`answer "${a}" not in choices: ${opts.choices.join(', ')}`);
      }
      return a;
    },
    multiselect: (_o: MultiSelectOpts) => {
      throw new Error('multiselect() not used');
    },
    password: (_o: PasswordOpts) => {
      throw new Error('password() not used');
    },
    note: () => {},
  };
}

describe('runSetupSession', () => {
  it('persists each toggle to .hex/checklist.yaml', async () => {
    const initial = checklistFromTasks([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]);
    const prompter = scriptedPrompter(['Mark as done', 'Mark as done']);

    const result = await runSetupSession({ rootDir: work, checklist: initial }, prompter);

    expect(result.checklist.tasks.every((t) => t.status === 'done')).toBe(true);

    const onDisk = await readFile(join(work, '.hex', 'checklist.yaml'), 'utf8');
    expect(onDisk).toContain('id: a');
    expect(onDisk).toContain('status: done');
    expect(onDisk).toContain('id: b');
  });

  it('preserves disk state when the user quits mid-loop', async () => {
    const initial = checklistFromTasks([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]);
    const prompter = scriptedPrompter(['Mark as done', 'Quit (resume with: hex setup)']);

    const result = await runSetupSession({ rootDir: work, checklist: initial }, prompter);

    expect(result.quit).toBe(true);

    const loaded = await readChecklistUpward(work);
    expect(loaded?.checklist.tasks[0]?.status).toBe('done');
    expect(loaded?.checklist.tasks[1]?.status).toBe('pending');
    expect(loaded?.checklist.tasks[2]?.status).toBe('pending');
  });

  it('does not write the file when the user only skips (no toggles)', async () => {
    const initial = checklistFromTasks([{ id: 'a', title: 'A' }]);
    const prompter = scriptedPrompter(['Skip for now']);

    const result = await runSetupSession({ rootDir: work, checklist: initial }, prompter);

    expect(result.checklist).toEqual(initial);
    // No .hex/ directory was created — onSave never fired.
    const loaded = await readChecklistUpward(work);
    expect(loaded).toBeNull();
  });
});

describe('runSetupCommand', () => {
  /** Build a SetupCommandEffects whose side effects are captured. */
  function captureEffects(prompter?: Prompter): {
    effects: SetupCommandEffects;
    stderr: string[];
    exitCodes: number[];
    introCount: number;
    outroCount: number;
  } {
    const stderr: string[] = [];
    const exitCodes: number[] = [];
    let introCount = 0;
    let outroCount = 0;
    const effects: SetupCommandEffects = {
      stderr: {
        write(s: string) {
          stderr.push(s);
        },
      },
      setExitCode: (code) => exitCodes.push(code),
      printIntro: () => {
        introCount++;
      },
      printOutro: () => {
        outroCount++;
      },
      prompterFactory: () => {
        if (!prompter) throw new Error('prompterFactory should not be called');
        return prompter;
      },
    };
    return {
      effects,
      stderr,
      exitCodes,
      get introCount() {
        return introCount;
      },
      get outroCount() {
        return outroCount;
      },
    };
  }

  it('errors with exit code 1 when no checklist is found in cwd or any ancestor', async () => {
    const cap = captureEffects();
    await runSetupCommand(work, cap.effects);

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/no \.hex\/checklist\.yaml/i);
    expect(cap.introCount).toBe(0);
    expect(cap.outroCount).toBe(0);
  });

  it('drives the setup session when a checklist exists', async () => {
    await writeChecklist(
      work,
      checklistFromTasks([
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ]),
    );
    const cap = captureEffects(scriptedPrompter(['Mark as done', 'Mark as done']));
    await runSetupCommand(work, cap.effects);

    expect(cap.exitCodes).toEqual([]);
    expect(cap.stderr).toEqual([]);
    expect(cap.introCount).toBe(1);
    expect(cap.outroCount).toBe(1);

    const loaded = await readChecklistUpward(work);
    expect(loaded?.checklist.tasks.every((t) => t.status === 'done')).toBe(true);
  });
});
