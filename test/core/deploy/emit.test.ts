import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  _resetRegistriesForTest,
  bootstrapBuiltinAdapters,
  emitCicdWorkflows,
} from '../../../src/core/deploy/index.js';

describe('emitCicdWorkflows', () => {
  beforeEach(() => {
    _resetRegistriesForTest();
    bootstrapBuiltinAdapters();
  });
  afterEach(() => {
    _resetRegistriesForTest();
  });

  async function scratch(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'hex-emit-'));
  }

  it('returns [] and writes nothing when there is no cicd stanza', async () => {
    const dir = await scratch();
    const written = await emitCicdWorkflows({
      cicd: undefined,
      deploy: { adapter: 'vercel' },
      outputDir: dir,
    });
    expect(written).toEqual([]);
    await expect(stat(join(dir, '.github'))).rejects.toThrow();
  });

  it('writes .github/workflows/deploy.yml for a github-actions + vercel manifest', async () => {
    const dir = await scratch();
    const written = await emitCicdWorkflows({
      cicd: { provider: 'github-actions' },
      deploy: { adapter: 'vercel' },
      outputDir: dir,
    });

    expect(written).toEqual(['.github/workflows/deploy.yml']);

    const content = await readFile(join(dir, '.github/workflows/deploy.yml'), 'utf8');
    const workflow = parseYaml(content);
    // Deploy-on defaults to push-to-main.
    expect(workflow.on).toEqual({ push: { branches: ['main'] } });
    // The deploy step must carry the Vercel secret wiring — the whole point of
    // keeping the adapter's requiredEnv while making the LOCAL token optional.
    const deployStep = workflow.jobs.deploy.steps.at(-1);
    expect(deployStep.env).toEqual({ VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}' });
    expect(deployStep.run).toContain('vercel');
  });

  it('throws for an unknown cicd provider rather than silently skipping', async () => {
    const dir = await scratch();
    await expect(
      emitCicdWorkflows({
        cicd: { provider: 'nope' },
        deploy: { adapter: 'vercel' },
        outputDir: dir,
      }),
    ).rejects.toThrow(/nope/);
  });
});
