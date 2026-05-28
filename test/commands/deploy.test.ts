import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { type DeployCommandEffects, runDeployCommand } from '../../src/commands/deploy.js';
import type { DeployAdapter, DeployContext, DeployResult } from '../../src/core/deploy/index.js';
import {
  LOCKFILE_DIRNAME,
  LOCKFILE_FILENAME,
  LOCKFILE_SCHEMA_VERSION,
} from '../../src/core/lockfile/index.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-deploy-cmd-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

type Capture = {
  effects: DeployCommandEffects;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  deployCalls: DeployContext[];
};

function captureEffects(
  adapter?: DeployAdapter,
  env: Record<string, string | undefined> = {},
): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const deployCalls: DeployContext[] = [];

  const wrappedAdapter: DeployAdapter | undefined = adapter
    ? {
        ...adapter,
        deploy: async (ctx) => {
          deployCalls.push(ctx);
          return adapter.deploy(ctx);
        },
      }
    : undefined;

  const effects: DeployCommandEffects = {
    stdout: { write: (s) => stdout.push(s) },
    stderr: { write: (s) => stderr.push(s) },
    setExitCode: (code) => exitCodes.push(code),
    env,
    resolveAdapter: (name: string) => {
      if (!wrappedAdapter) throw new Error(`unknown deploy adapter "${name}"`);
      if (wrappedAdapter.name !== name) {
        throw new Error(`unknown deploy adapter "${name}"`);
      }
      return wrappedAdapter;
    },
  };

  return { effects, stdout, stderr, exitCodes, deployCalls };
}

async function writeLockfileYaml(rootDir: string, body: Record<string, unknown>): Promise<void> {
  const dir = join(rootDir, LOCKFILE_DIRNAME);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, LOCKFILE_FILENAME), stringifyYaml(body), 'utf8');
}

const baseLockfile = {
  schema_version: LOCKFILE_SCHEMA_VERSION,
  root: {
    name: 'demo',
    version: '0.1.0',
    type: 'component',
    source: { kind: 'file', path: '/nowhere' },
  },
  children: [],
  answers: {},
  files: [],
};

describe('runDeployCommand', () => {
  it('errors with exit code 1 when no lockfile exists', async () => {
    const cap = captureEffects();
    await runDeployCommand(work, cap.effects);

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/no \.hex\/lockfile\.yaml/i);
  });

  it('exits cleanly when no deploy stanza is present', async () => {
    await writeLockfileYaml(work, baseLockfile);
    const cap = captureEffects();

    await runDeployCommand(work, cap.effects);

    expect(cap.exitCodes).toEqual([]);
    expect(cap.stderr).toEqual([]);
    expect(cap.stdout.join('')).toMatch(/no deploy adapter configured/i);
  });

  it('exits cleanly when the adapter is `none`', async () => {
    await writeLockfileYaml(work, { ...baseLockfile, deploy: { adapter: 'none' } });
    const cap = captureEffects();

    await runDeployCommand(work, cap.effects);

    expect(cap.exitCodes).toEqual([]);
    expect(cap.stdout.join('')).toMatch(/no deploy adapter configured/i);
  });

  it('errors when the adapter is unknown', async () => {
    await writeLockfileYaml(work, {
      ...baseLockfile,
      deploy: { adapter: 'missing' },
    });
    const cap = captureEffects();

    await runDeployCommand(work, cap.effects);

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/unknown deploy adapter "missing"/);
    expect(cap.deployCalls).toEqual([]);
  });

  it('errors when required env vars are missing', async () => {
    await writeLockfileYaml(work, { ...baseLockfile, deploy: { adapter: 'fake' } });
    const adapter: DeployAdapter = {
      name: 'fake',
      requiredEnv: ['FAKE_TOKEN'],
      validateConfig: (s) => s,
      deploy: async () => ({}),
    };
    const cap = captureEffects(adapter, {});

    await runDeployCommand(work, cap.effects);

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/missing required env vars: FAKE_TOKEN/);
    expect(cap.deployCalls).toEqual([]);
  });

  it('invokes the adapter and prints the deploy URL on success', async () => {
    await writeLockfileYaml(work, {
      ...baseLockfile,
      deploy: { adapter: 'fake', extra: 'value' },
    });
    const adapter: DeployAdapter = {
      name: 'fake',
      requiredEnv: ['FAKE_TOKEN'],
      validateConfig: (s) => s,
      deploy: async (): Promise<DeployResult> => ({ url: 'https://x.example' }),
    };
    const cap = captureEffects(adapter, { FAKE_TOKEN: 'shh' });

    await runDeployCommand(work, cap.effects);

    expect(cap.exitCodes).toEqual([]);
    expect(cap.stderr).toEqual([]);
    expect(cap.deployCalls).toHaveLength(1);
    expect(cap.deployCalls[0]?.appRoot).toBe(work);
    expect(cap.deployCalls[0]?.config).toMatchObject({ adapter: 'fake', extra: 'value' });
    expect(cap.deployCalls[0]?.env.FAKE_TOKEN).toBe('shh');
    expect(cap.stdout.join('')).toMatch(/https:\/\/x\.example/);
  });

  it('reports adapter failures with exit code 1', async () => {
    await writeLockfileYaml(work, { ...baseLockfile, deploy: { adapter: 'fake' } });
    const adapter: DeployAdapter = {
      name: 'fake',
      requiredEnv: [],
      validateConfig: (s) => s,
      deploy: async () => {
        throw new Error('boom');
      },
    };
    const cap = captureEffects(adapter, {});

    await runDeployCommand(work, cap.effects);

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/deploy failed: boom/);
  });

  it('rejects an invalid adapter config via validateConfig', async () => {
    await writeLockfileYaml(work, { ...baseLockfile, deploy: { adapter: 'fake' } });
    const adapter: DeployAdapter = {
      name: 'fake',
      requiredEnv: [],
      validateConfig: () => {
        throw new Error('prod must be boolean');
      },
      deploy: async () => ({}),
    };
    const cap = captureEffects(adapter, {});

    await runDeployCommand(work, cap.effects);

    expect(cap.exitCodes).toEqual([1]);
    expect(cap.stderr.join('')).toMatch(/invalid deploy config: prod must be boolean/);
    expect(cap.deployCalls).toEqual([]);
  });

  it('--dry-run describes the planned invocation without calling deploy', async () => {
    await writeLockfileYaml(work, { ...baseLockfile, deploy: { adapter: 'fake' } });
    const adapter: DeployAdapter = {
      name: 'fake',
      requiredEnv: ['FAKE_TOKEN'],
      validateConfig: (s) => s,
      deploy: async () => ({ url: 'should-not-be-called' }),
    };
    const cap = captureEffects(adapter, {});

    await runDeployCommand(work, cap.effects, { dryRun: true });

    expect(cap.exitCodes).toEqual([]);
    expect(cap.deployCalls).toEqual([]);
    const out = cap.stdout.join('');
    expect(out).toMatch(/adapter: fake/);
    expect(out).toMatch(/FAKE_TOKEN=<missing>/);
    expect(out).toMatch(/not actually deploying/i);
  });

  it('walks upward from a subdirectory to find the lockfile', async () => {
    await writeLockfileYaml(work, { ...baseLockfile, deploy: { adapter: 'fake' } });
    const sub = join(work, 'src', 'nested');
    await mkdir(sub, { recursive: true });
    const adapter: DeployAdapter = {
      name: 'fake',
      requiredEnv: [],
      validateConfig: (s) => s,
      deploy: async () => ({ url: 'https://x.example' }),
    };
    const cap = captureEffects(adapter, {});

    await runDeployCommand(sub, cap.effects);

    expect(cap.exitCodes).toEqual([]);
    expect(cap.deployCalls).toHaveLength(1);
    expect(cap.deployCalls[0]?.appRoot).toBe(work);
  });
});
