import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VercelDeployError,
  type VercelRunner,
  type VercelRunnerResult,
  _resetRegistriesForTest,
  bootstrapBuiltinAdapters,
  createVercelAdapter,
  extractDeployUrl,
  getDeployAdapter,
  listDeployAdapterNames,
  vercelAdapter,
} from '../../../src/core/deploy/index.js';

type Call = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
};

function scriptedRunner(
  reply: VercelRunnerResult | (() => Promise<VercelRunnerResult>),
  capture: Call[],
): VercelRunner {
  return async (command, args, opts) => {
    capture.push({ command, args, cwd: opts.cwd, env: opts.env });
    if (typeof reply === 'function') return reply();
    return reply;
  };
}

describe('extractDeployUrl', () => {
  it('extracts the URL from a real-looking preview output', () => {
    const stdout = [
      'Vercel CLI 32.4.1',
      '🔍  Inspect: https://vercel.com/foo/bar/abc123 [123ms]',
      '✅  Preview: https://my-app-abc.vercel.app [12s]',
    ].join('\n');
    expect(extractDeployUrl(stdout)).toBe('https://my-app-abc.vercel.app');
  });

  it('extracts the URL from a production output', () => {
    const stdout = [
      '🔍  Inspect: https://vercel.com/foo/bar/abc123',
      '✅  Production: https://my-app.vercel.app [copied to clipboard]',
    ].join('\n');
    expect(extractDeployUrl(stdout)).toBe('https://my-app.vercel.app');
  });

  it('returns undefined when stdout contains no https URL', () => {
    expect(extractDeployUrl('something went sideways')).toBeUndefined();
    expect(extractDeployUrl('')).toBeUndefined();
  });

  it('strips trailing brackets and punctuation from a URL run', () => {
    expect(extractDeployUrl('Preview: https://x.vercel.app]')).toBe('https://x.vercel.app');
  });
});

describe('createVercelAdapter', () => {
  it('rejects a stanza with an unknown extra key', () => {
    const adapter = createVercelAdapter();
    expect(() => adapter.validateConfig({ adapter: 'vercel', wrong: 1 })).toThrow(
      VercelDeployError,
    );
  });

  it('rejects a stanza whose prod field is not a boolean', () => {
    const adapter = createVercelAdapter();
    expect(() => adapter.validateConfig({ adapter: 'vercel', prod: 'yes' })).toThrow(
      VercelDeployError,
    );
  });

  it('accepts the minimal stanza and a prod stanza', () => {
    const adapter = createVercelAdapter();
    expect(adapter.validateConfig({ adapter: 'vercel' })).toEqual({ adapter: 'vercel' });
    expect(adapter.validateConfig({ adapter: 'vercel', prod: true })).toEqual({
      adapter: 'vercel',
      prod: true,
    });
  });

  it('declares VERCEL_TOKEN as a required env var', () => {
    expect(createVercelAdapter().requiredEnv).toEqual(['VERCEL_TOKEN']);
  });

  it('throws when VERCEL_TOKEN is missing', async () => {
    const capture: Call[] = [];
    const adapter = createVercelAdapter({
      runner: scriptedRunner({ stdout: '', stderr: '' }, capture),
    });
    await expect(
      adapter.deploy({
        appRoot: '/tmp/app',
        config: { adapter: 'vercel' },
        env: {},
      }),
    ).rejects.toThrow(/VERCEL_TOKEN is not set/);
    expect(capture).toEqual([]);
  });

  it('invokes npx --yes vercel deploy --yes --token <T> from appRoot and returns the URL (M14.10)', async () => {
    const capture: Call[] = [];
    const adapter = createVercelAdapter({
      runner: scriptedRunner(
        { stdout: 'Preview: https://my-app-abc.vercel.app\n', stderr: '' },
        capture,
      ),
    });
    const result = await adapter.deploy({
      appRoot: '/tmp/app',
      config: { adapter: 'vercel' },
      env: { VERCEL_TOKEN: 't-123' },
    });

    expect(capture).toHaveLength(1);
    // M14.10: invoke via `npx --yes vercel …` so users don't need a
    // global `npm i -g vercel` first. The trailing `--yes` on the
    // vercel sub-command keeps suppressing vercel's own link prompt.
    expect(capture[0]?.command).toBe('npx');
    expect(capture[0]?.args).toEqual(['--yes', 'vercel', 'deploy', '--yes', '--token', 't-123']);
    expect(capture[0]?.cwd).toBe('/tmp/app');
    expect(result.url).toBe('https://my-app-abc.vercel.app');
    expect(result.logs).toContain('Preview:');
  });

  it('passes --prod when the stanza opts in', async () => {
    const capture: Call[] = [];
    const adapter = createVercelAdapter({
      runner: scriptedRunner(
        { stdout: 'Production: https://my-app.vercel.app\n', stderr: '' },
        capture,
      ),
    });
    await adapter.deploy({
      appRoot: '/tmp/app',
      config: { adapter: 'vercel', prod: true },
      env: { VERCEL_TOKEN: 't' },
    });
    expect(capture[0]?.args).toEqual([
      '--yes',
      'vercel',
      'deploy',
      '--yes',
      '--token',
      't',
      '--prod',
    ]);
  });

  it('omits --prod by default', async () => {
    const capture: Call[] = [];
    const adapter = createVercelAdapter({
      runner: scriptedRunner({ stdout: 'https://x.vercel.app', stderr: '' }, capture),
    });
    await adapter.deploy({
      appRoot: '/tmp/app',
      config: { adapter: 'vercel', prod: false },
      env: { VERCEL_TOKEN: 't' },
    });
    expect(capture[0]?.args).not.toContain('--prod');
  });

  it('wraps CLI errors with the stderr surfaced', async () => {
    const capture: Call[] = [];
    const failure = Object.assign(new Error('command failed: vercel deploy'), {
      stderr: 'Error! Not authorized',
    });
    const adapter = createVercelAdapter({
      runner: scriptedRunner(() => Promise.reject(failure), capture),
    });
    try {
      await adapter.deploy({
        appRoot: '/tmp/app',
        config: { adapter: 'vercel' },
        env: { VERCEL_TOKEN: 't' },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VercelDeployError);
      expect((err as VercelDeployError).message).toMatch(/vercel CLI failed/);
      expect((err as VercelDeployError).stderr).toBe('Error! Not authorized');
    }
  });

  it('returns logs without url when CLI succeeds but emits no https line', async () => {
    const capture: Call[] = [];
    const adapter = createVercelAdapter({
      runner: scriptedRunner({ stdout: 'nothing useful', stderr: '' }, capture),
    });
    const result = await adapter.deploy({
      appRoot: '/tmp/app',
      config: { adapter: 'vercel' },
      env: { VERCEL_TOKEN: 't' },
    });
    expect(result.url).toBeUndefined();
    expect(result.logs).toBe('nothing useful');
  });
});

describe('bootstrapBuiltinAdapters', () => {
  beforeEach(() => {
    _resetRegistriesForTest();
  });

  afterEach(() => {
    _resetRegistriesForTest();
  });

  it('registers the vercel adapter into the registry', () => {
    bootstrapBuiltinAdapters();
    expect(listDeployAdapterNames()).toContain('vercel');
    expect(getDeployAdapter('vercel')).toBe(vercelAdapter);
  });

  it('is idempotent — calling it twice does not throw', () => {
    bootstrapBuiltinAdapters();
    expect(() => bootstrapBuiltinAdapters()).not.toThrow();
    expect(listDeployAdapterNames().filter((n) => n === 'vercel')).toHaveLength(1);
  });
});
