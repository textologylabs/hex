import { describe, expect, it, vi } from 'vitest';
import {
  RUN_COMMAND_ALLOWLIST,
  type RunEffects,
  SetupExecutorError,
  outcomeSucceeded,
  parseRunCommand,
  runSetupTask,
  validateSetupTasksAllowlist,
} from '../../../src/core/setup/run.js';

describe('parseRunCommand', () => {
  it('splits a simple command on whitespace', () => {
    expect(parseRunCommand('npm install')).toEqual({ cmd: 'npm', args: ['install'] });
    expect(parseRunCommand('git  init   -b main')).toEqual({
      cmd: 'git',
      args: ['init', '-b', 'main'],
    });
  });

  it('treats single-quoted segments as one token', () => {
    expect(parseRunCommand("git commit -m 'initial commit'")).toEqual({
      cmd: 'git',
      args: ['commit', '-m', 'initial commit'],
    });
  });

  it('treats double-quoted segments as one token and honours backslash escapes', () => {
    expect(parseRunCommand('node -e "console.log(\\"hi\\")"')).toEqual({
      cmd: 'node',
      args: ['-e', 'console.log("hi")'],
    });
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseRunCommand('git commit -m "oops')).toThrow(SetupExecutorError);
  });

  it('rejects an empty / whitespace-only command', () => {
    expect(() => parseRunCommand('   ')).toThrow(SetupExecutorError);
  });
});

describe('validateSetupTasksAllowlist', () => {
  const safe = { id: 't', title: 'T', run: 'npm install' };
  const evil = { id: 'evil', title: 'E', run: 'rm -rf /' };

  it('every allowlisted binary is accepted', () => {
    for (const cmd of RUN_COMMAND_ALLOWLIST) {
      expect(() =>
        validateSetupTasksAllowlist([{ id: cmd, title: 't', run: `${cmd} --version` }], {
          sourceKind: 'git',
          trustLocal: false,
        }),
      ).not.toThrow();
    }
  });

  it('rejects a non-allowlisted binary for a non-FileSource template', () => {
    expect(() =>
      validateSetupTasksAllowlist([evil], { sourceKind: 'git', trustLocal: false }),
    ).toThrow(/"evil".*"rm".*allowlist/s);
  });

  it('rejects a non-allowlisted binary for a FileSource template without --trust-local', () => {
    expect(() =>
      validateSetupTasksAllowlist([evil], { sourceKind: 'file', trustLocal: false }),
    ).toThrow(/--trust-local/);
  });

  it('lifts the allowlist for a FileSource template with --trust-local', () => {
    expect(() =>
      validateSetupTasksAllowlist([evil], { sourceKind: 'file', trustLocal: true }),
    ).not.toThrow();
  });

  it('does NOT lift the allowlist for a non-FileSource template even with --trust-local', () => {
    expect(() =>
      validateSetupTasksAllowlist([evil], { sourceKind: 'git', trustLocal: true }),
    ).toThrow(/trust\.allowlist/);
  });

  it('passes over tasks without `run:` (open-only or detail-only)', () => {
    expect(() =>
      validateSetupTasksAllowlist(
        [
          { id: 'a', title: 'a', open: 'https://example.test/' },
          { id: 'b', title: 'b', detail: 'pure prose' },
          safe,
        ],
        { sourceKind: 'git', trustLocal: false },
      ),
    ).not.toThrow();
  });
});

function scriptedEffects(overrides: Partial<RunEffects> = {}): RunEffects & {
  spawnCalls: Array<{ cmd: string; args: string[]; cwd: string }>;
  opened: string[];
} {
  const spawnCalls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const opened: string[] = [];
  return {
    spawnCalls,
    opened,
    spawn: vi.fn(async (cmd: string, args: string[], cwd: string) => {
      spawnCalls.push({ cmd, args, cwd });
      return 0;
    }),
    openUrl: vi.fn(async (url: string) => {
      opened.push(url);
    }),
    ...overrides,
  };
}

describe('runSetupTask', () => {
  it('spawns the `run` command and reports the exit code', async () => {
    const fx = scriptedEffects();
    const outcome = await runSetupTask(
      { id: 't', title: 'T', run: 'npm install --silent' },
      '/work',
      fx,
    );
    expect(outcome).toEqual({ kind: 'ran', exitCode: 0 });
    expect(fx.spawnCalls).toEqual([{ cmd: 'npm', args: ['install', '--silent'], cwd: '/work' }]);
    expect(fx.opened).toEqual([]);
  });

  it('opens the URL for an `open`-only task', async () => {
    const fx = scriptedEffects();
    const outcome = await runSetupTask(
      { id: 't', title: 'T', open: 'https://example.test/dash' },
      '/work',
      fx,
    );
    expect(outcome).toEqual({ kind: 'opened', url: 'https://example.test/dash' });
    expect(fx.opened).toEqual(['https://example.test/dash']);
    expect(fx.spawnCalls).toEqual([]);
  });

  it('opens FIRST then runs for a combined open+run task', async () => {
    const fx = scriptedEffects();
    const outcome = await runSetupTask(
      {
        id: 't',
        title: 'T',
        open: 'https://example.test/dash',
        run: 'vercel link',
      },
      '/work',
      fx,
    );
    expect(outcome).toEqual({
      kind: 'opened-and-ran',
      url: 'https://example.test/dash',
      exitCode: 0,
    });
    // Ordering: open before run.
    const opens = fx.opened.map((u) => `open:${u}`);
    const runs = fx.spawnCalls.map((c) => `run:${c.cmd}`);
    expect([...opens, ...runs]).toEqual(['open:https://example.test/dash', 'run:vercel']);
  });

  it('reports the non-zero exit code without throwing', async () => {
    const fx = scriptedEffects({ spawn: async () => 7 });
    const outcome = await runSetupTask({ id: 't', title: 'T', run: 'npm test' }, '/work', fx);
    expect(outcome).toEqual({ kind: 'ran', exitCode: 7 });
  });

  it('surfaces a spawn error as `spawn-error` (missing binary, OS error)', async () => {
    const fx = scriptedEffects({
      spawn: async () => {
        throw new Error('ENOENT: spawn npm');
      },
    });
    const outcome = await runSetupTask({ id: 't', title: 'T', run: 'npm install' }, '/work', fx);
    expect(outcome.kind).toBe('spawn-error');
    if (outcome.kind === 'spawn-error') {
      expect(outcome.message).toContain('ENOENT');
    }
  });

  it('returns `no-action` for a pure detail task — executor leaves it for the picker', async () => {
    const fx = scriptedEffects();
    const outcome = await runSetupTask(
      { id: 't', title: 'T', detail: 'do it yourself' },
      '/work',
      fx,
    );
    expect(outcome).toEqual({ kind: 'no-action' });
    expect(fx.spawnCalls).toEqual([]);
    expect(fx.opened).toEqual([]);
  });
});

describe('outcomeSucceeded', () => {
  it('classifies every variant correctly', () => {
    expect(outcomeSucceeded({ kind: 'ran', exitCode: 0 })).toBe(true);
    expect(outcomeSucceeded({ kind: 'ran', exitCode: 1 })).toBe(false);
    expect(outcomeSucceeded({ kind: 'opened', url: 'x' })).toBe(true);
    expect(outcomeSucceeded({ kind: 'opened-and-ran', url: 'x', exitCode: 0 })).toBe(true);
    expect(outcomeSucceeded({ kind: 'opened-and-ran', url: 'x', exitCode: 1 })).toBe(false);
    expect(outcomeSucceeded({ kind: 'spawn-error', message: 'nope' })).toBe(false);
    expect(outcomeSucceeded({ kind: 'no-action' })).toBe(false);
  });
});
