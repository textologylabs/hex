import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  CHECKLIST_REL_PATH,
  type Checklist,
  writeChecklist,
} from '../../../src/core/checklist/index.js';
import {
  countActionableTasks,
  isActionable,
  runExecutorPass,
} from '../../../src/core/setup/executor-pass.js';
import type { RitualEffects } from '../../../src/core/setup/ritual.js';
import type { RunEffects } from '../../../src/core/setup/run.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-executor-pass-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function scriptedEffects(spawnExit: number | Error = 0): RunEffects {
  return {
    async spawn() {
      if (spawnExit instanceof Error) throw spawnExit;
      return spawnExit;
    },
    async openUrl() {
      // no-op recorder; tests that care use a custom override
    },
  };
}

const initialChecklist = (
  tasks: Array<{ id: string; title: string; run?: string; open?: string; detail?: string }>,
): Checklist => ({
  tasks: tasks.map((t) => ({ ...t, status: 'pending' as const })),
});

describe('isActionable / countActionableTasks', () => {
  it('returns true iff the task carries run: or open:', () => {
    expect(isActionable({ id: 'a', title: 'A', run: 'npm install', status: 'pending' })).toBe(true);
    expect(isActionable({ id: 'b', title: 'B', open: 'https://e.test/', status: 'pending' })).toBe(
      true,
    );
    expect(isActionable({ id: 'c', title: 'C', detail: 'manual', status: 'pending' })).toBe(false);
  });

  it('counts only PENDING actionable tasks', () => {
    const list: Checklist = {
      tasks: [
        { id: 'a', title: 'A', run: 'npm install', status: 'pending' },
        { id: 'b', title: 'B', open: 'https://e.test/', status: 'pending' },
        { id: 'c', title: 'C', run: 'gh secret set X', status: 'done' },
        { id: 'd', title: 'D', detail: 'just prose', status: 'pending' },
      ],
    };
    expect(countActionableTasks(list)).toBe(2);
  });
});

describe('runExecutorPass', () => {
  it('runs every pending actionable task in declared order and marks successes done atomically', async () => {
    const rootDir = work;
    await mkdir(rootDir, { recursive: true });
    const initial = initialChecklist([
      { id: 'install', title: 'Install', run: 'npm install' },
      { id: 'view', title: 'View dashboard', open: 'https://example.test/dash' },
      { id: 'docs', title: 'Read docs', detail: 'see README' },
    ]);
    await writeChecklist(rootDir, initial);

    const order: string[] = [];
    const effects: RunEffects = {
      async spawn(cmd) {
        order.push(`spawn:${cmd}`);
        return 0;
      },
      async openUrl(url) {
        order.push(`open:${url}`);
      },
    };

    const result = await runExecutorPass(initial, { cwd: rootDir, effects });
    expect(result.reports.map((r) => r.task.id)).toEqual(['install', 'view']);
    expect(result.reports.every((r) => r.markedDone)).toBe(true);
    expect(order).toEqual(['spawn:npm', 'open:https://example.test/dash']);

    // The detail-only task is left for the picker.
    const onDisk = parseYaml(await readFile(join(rootDir, CHECKLIST_REL_PATH), 'utf8')) as {
      tasks: Array<{ id: string; status: string }>;
    };
    expect(onDisk.tasks.map((t) => `${t.id}=${t.status}`)).toEqual([
      'install=done',
      'view=done',
      'docs=pending',
    ]);
  });

  it('failed `run:` task stays pending; the pass continues to subsequent tasks', async () => {
    const rootDir = work;
    const initial = initialChecklist([
      { id: 'test', title: 'Test', run: 'npm test' },
      { id: 'install', title: 'Install', run: 'npm install' },
    ]);
    await writeChecklist(rootDir, initial);

    const effects: RunEffects = {
      async spawn(_cmd, args) {
        if (args.includes('test')) return 1; // simulate failing test
        return 0;
      },
      async openUrl() {},
    };

    const { reports } = await runExecutorPass(initial, { cwd: rootDir, effects });
    expect(reports.map((r) => `${r.task.id}:${r.markedDone}`)).toEqual([
      'test:false',
      'install:true',
    ]);

    const onDisk = parseYaml(await readFile(join(rootDir, CHECKLIST_REL_PATH), 'utf8')) as {
      tasks: Array<{ id: string; status: string }>;
    };
    expect(onDisk.tasks.map((t) => `${t.id}=${t.status}`)).toEqual([
      'test=pending',
      'install=done',
    ]);
  });

  it('fires onTaskStart + onTaskComplete callbacks for each actionable task', async () => {
    const rootDir = work;
    const initial = initialChecklist([
      { id: 'a', title: 'A', run: 'npm install' },
      { id: 'b', title: 'B', detail: 'manual' },
    ]);
    await writeChecklist(rootDir, initial);

    const starts: string[] = [];
    const completes: string[] = [];
    await runExecutorPass(initial, {
      cwd: rootDir,
      effects: scriptedEffects(0),
      onTaskStart: (t) => starts.push(t.id),
      onTaskComplete: (r) => completes.push(`${r.task.id}:${r.markedDone}`),
    });
    expect(starts).toEqual(['a']);
    expect(completes).toEqual(['a:true']);
  });

  it('idempotent — re-running over a fully-done checklist is a no-op', async () => {
    const rootDir = work;
    const initial: Checklist = {
      tasks: [{ id: 'install', title: 'Install', run: 'npm install', status: 'done' }],
    };
    await writeChecklist(rootDir, initial);

    const { reports } = await runExecutorPass(initial, {
      cwd: rootDir,
      effects: scriptedEffects(0),
    });
    expect(reports).toEqual([]);
  });

  describe('with ritualEffects (M14.11)', () => {
    function recordingRitual(opts: { confirmYes?: boolean } = {}): RitualEffects & {
      events: string[];
    } {
      const events: string[] = [];
      return {
        events,
        narrate: (task, index, total) => {
          events.push(`narrate:${task.id}:${index}/${total}`);
        },
        confirm: async (task) => {
          events.push(`confirm:${task.id}`);
          return opts.confirmYes ?? true;
        },
        awaitContinue: async (task) => {
          events.push(`await:${task.id}`);
        },
      };
    }

    it('declined task stays pending — confirm-no skips both open + run', async () => {
      const rootDir = work;
      const initial = initialChecklist([
        { id: 'token', title: 'Token', open: 'https://e.test/', run: 'gh secret set X' },
      ]);
      await writeChecklist(rootDir, initial);

      const ritualEffects = recordingRitual({ confirmYes: false });
      const runEffects = scriptedEffects(0);

      const { reports } = await runExecutorPass(initial, {
        cwd: rootDir,
        effects: runEffects,
        ritualEffects,
      });
      expect(reports.map((r) => `${r.task.id}:${r.markedDone}`)).toEqual(['token:false']);
      expect(reports[0]?.outcome.kind).toBe('declined');
      // Side effects skipped: narrate + confirm fired, but no open + no
      // spawn (the runEffects-side spawn would push 'spawn:gh' to the
      // recorder; we don't see it because confirm-no short-circuited).
      expect(ritualEffects.events).toEqual(['narrate:token:1/1', 'confirm:token']);

      const onDisk = parseYaml(await readFile(join(rootDir, CHECKLIST_REL_PATH), 'utf8')) as {
        tasks: Array<{ id: string; status: string }>;
      };
      expect(onDisk.tasks.map((t) => `${t.id}=${t.status}`)).toEqual(['token=pending']);
    });

    it('narrate fires before open + spawn for every task', async () => {
      const rootDir = work;
      const initial = initialChecklist([
        { id: 'install', title: 'Install', run: 'npm install' },
        { id: 'token', title: 'Token', open: 'https://e.test/', run: 'gh secret set X' },
      ]);
      await writeChecklist(rootDir, initial);

      const ritualEffects = recordingRitual();
      await runExecutorPass(initial, {
        cwd: rootDir,
        effects: scriptedEffects(0),
        ritualEffects,
      });
      // The run:-only task narrates but skips confirm + await; the
      // open:+run: task narrates → confirms → awaits.
      expect(ritualEffects.events).toEqual([
        'narrate:install:1/2',
        'narrate:token:2/2',
        'confirm:token',
        'await:token',
      ]);
    });
  });
});
