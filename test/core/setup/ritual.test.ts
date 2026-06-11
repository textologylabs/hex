import { describe, expect, it } from 'vitest';
import type { SetupTask } from '../../../src/core/manifest/types.js';
import {
  type RitualEffects,
  formatPlan,
  ritualOutcomeSucceeded,
  runRitualTask,
} from '../../../src/core/setup/ritual.js';
import type { RunEffects } from '../../../src/core/setup/run.js';

type Event =
  | { kind: 'narrate'; id: string; index: number; total: number; plan: string }
  | { kind: 'confirm'; id: string }
  | { kind: 'await-continue'; id: string }
  | { kind: 'open'; url: string }
  | { kind: 'spawn'; cmd: string; args: string[]; cwd: string };

type Scripted = {
  events: Event[];
  ritualEffects: RitualEffects;
  runEffects: RunEffects;
};

function scripted(
  opts: {
    confirmYes?: boolean;
    spawnExit?: number | Error;
  } = {},
): Scripted {
  const events: Event[] = [];
  const ritualEffects: RitualEffects = {
    narrate(task, index, total, plan) {
      events.push({ kind: 'narrate', id: task.id, index, total, plan });
    },
    async confirm(task) {
      events.push({ kind: 'confirm', id: task.id });
      return opts.confirmYes ?? true;
    },
    async awaitContinue(task) {
      events.push({ kind: 'await-continue', id: task.id });
    },
  };
  const runEffects: RunEffects = {
    async spawn(cmd, args, cwd) {
      events.push({ kind: 'spawn', cmd, args, cwd });
      if (opts.spawnExit instanceof Error) throw opts.spawnExit;
      return opts.spawnExit ?? 0;
    },
    async openUrl(url) {
      events.push({ kind: 'open', url });
    },
  };
  return { events, ritualEffects, runEffects };
}

describe('formatPlan', () => {
  it('renders an open: + run: + detail: task as three numbered steps with a trailing pointer', () => {
    const task: SetupTask = {
      id: 't',
      title: 'Configure Vercel deploy token',
      open: 'https://vercel.com/account/tokens',
      run: 'gh secret set VERCEL_TOKEN',
      detail: 'Mint a token (no expiry), copy it, paste at the prompt.',
    };
    const plan = formatPlan(task);
    expect(plan).toContain('1. Hex will open https://vercel.com/account/tokens');
    expect(plan).toContain('2. Mint a token');
    expect(plan).toContain('3. Hex will run: gh secret set VERCEL_TOKEN');
    expect(plan).toContain('Control returns to this terminal');
  });

  it('renders a run:-only task as a single step (no terminal-return note)', () => {
    const plan = formatPlan({ id: 't', title: 'Install', run: 'npm install' });
    expect(plan).toContain('Hex will run: npm install');
    expect(plan).not.toContain('Control returns to this terminal');
  });

  it('renders an open:-only task with the terminal-return note', () => {
    const plan = formatPlan({
      id: 't',
      title: 'Read the docs',
      open: 'https://example.test/docs',
    });
    expect(plan).toContain('Hex will open https://example.test/docs');
    expect(plan).toContain('Control returns to this terminal');
  });

  it('preserves multi-line detail prose with indentation', () => {
    const plan = formatPlan({
      id: 't',
      title: 'Walk through',
      detail: 'first line\nsecond line\nthird line',
    });
    const lines = plan.split('\n');
    expect(lines.some((l) => l.includes('1. first line'))).toBe(true);
    expect(lines.some((l) => l.match(/^\s+second line$/))).toBe(true);
    expect(lines.some((l) => l.match(/^\s+third line$/))).toBe(true);
  });
});

describe('ritualOutcomeSucceeded', () => {
  it('treats declined as not succeeded', () => {
    expect(ritualOutcomeSucceeded({ kind: 'declined' })).toBe(false);
  });
  it('keeps the M14.7 outcome semantics', () => {
    expect(ritualOutcomeSucceeded({ kind: 'ran', exitCode: 0 })).toBe(true);
    expect(ritualOutcomeSucceeded({ kind: 'ran', exitCode: 1 })).toBe(false);
    expect(ritualOutcomeSucceeded({ kind: 'opened', url: 'x' })).toBe(true);
    expect(ritualOutcomeSucceeded({ kind: 'opened-and-ran', url: 'x', exitCode: 0 })).toBe(true);
    expect(ritualOutcomeSucceeded({ kind: 'spawn-error', message: 'x' })).toBe(false);
    expect(ritualOutcomeSucceeded({ kind: 'no-action' })).toBe(false);
  });
});

describe('runRitualTask', () => {
  const baseOpts = (s: Scripted) => ({
    index: 1,
    total: 1,
    cwd: '/work',
    ritualEffects: s.ritualEffects,
    runEffects: s.runEffects,
  });

  it('open: + run: — narrate → confirm → open → awaitContinue → spawn, in order', async () => {
    const s = scripted();
    const outcome = await runRitualTask(
      {
        id: 'configure-token',
        title: 'Configure token',
        open: 'https://example.test/',
        run: 'gh secret set FOO',
      },
      baseOpts(s),
    );
    expect(outcome).toEqual({
      kind: 'opened-and-ran',
      url: 'https://example.test/',
      exitCode: 0,
    });
    expect(s.events.map((e) => e.kind)).toEqual([
      'narrate',
      'confirm',
      'open',
      'await-continue',
      'spawn',
    ]);
  });

  it('declined confirm short-circuits — open + spawn never fire', async () => {
    const s = scripted({ confirmYes: false });
    const outcome = await runRitualTask(
      { id: 't', title: 'T', open: 'https://example.test/', run: 'gh secret set FOO' },
      baseOpts(s),
    );
    expect(outcome).toEqual({ kind: 'declined' });
    expect(s.events.map((e) => e.kind)).toEqual(['narrate', 'confirm']);
    expect(s.events.find((e) => e.kind === 'open')).toBeUndefined();
    expect(s.events.find((e) => e.kind === 'spawn')).toBeUndefined();
  });

  it('run:-only task — narrate then spawn, no confirm or awaitContinue', async () => {
    const s = scripted();
    const outcome = await runRitualTask(
      { id: 't', title: 'Install', run: 'npm install' },
      baseOpts(s),
    );
    expect(outcome).toEqual({ kind: 'ran', exitCode: 0 });
    expect(s.events.map((e) => e.kind)).toEqual(['narrate', 'spawn']);
  });

  it('open:-only task — narrate → confirm → open → awaitContinue, no spawn', async () => {
    const s = scripted();
    const outcome = await runRitualTask(
      { id: 't', title: 'Browse', open: 'https://example.test/' },
      baseOpts(s),
    );
    expect(outcome).toEqual({ kind: 'opened', url: 'https://example.test/' });
    expect(s.events.map((e) => e.kind)).toEqual(['narrate', 'confirm', 'open', 'await-continue']);
  });

  it('detail:-only task — narrate only; no side effects', async () => {
    const s = scripted();
    const outcome = await runRitualTask(
      { id: 't', title: 'Do thing', detail: 'just do it' },
      baseOpts(s),
    );
    expect(outcome).toEqual({ kind: 'no-action' });
    expect(s.events.map((e) => e.kind)).toEqual(['narrate']);
  });

  it('surfaces a spawn error as spawn-error (with the message)', async () => {
    const s = scripted({ spawnExit: new Error('ENOENT: spawn npm') });
    const outcome = await runRitualTask(
      { id: 't', title: 'Install', run: 'npm install' },
      baseOpts(s),
    );
    expect(outcome.kind).toBe('spawn-error');
    if (outcome.kind === 'spawn-error') expect(outcome.message).toContain('ENOENT');
  });

  it('reports the non-zero exit code without throwing', async () => {
    const s = scripted({ spawnExit: 7 });
    const outcome = await runRitualTask({ id: 't', title: 'Test', run: 'npm test' }, baseOpts(s));
    expect(outcome).toEqual({ kind: 'ran', exitCode: 7 });
  });
});
