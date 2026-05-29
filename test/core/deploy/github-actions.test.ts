import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  GITHUB_ACTIONS_PROVIDER_NAME,
  GithubActionsProviderError,
  _resetRegistriesForTest,
  bootstrapBuiltinAdapters,
  createGithubActionsProvider,
  getCicdProvider,
  githubActionsProvider,
  listCicdProviderNames,
} from '../../../src/core/deploy/index.js';

describe('createGithubActionsProvider — config validation', () => {
  it('accepts the minimal stanza', () => {
    const p = createGithubActionsProvider();
    expect(p.validateConfig({ provider: 'github-actions' })).toEqual({
      provider: 'github-actions',
    });
  });

  it('accepts node-version and deploy-on', () => {
    const p = createGithubActionsProvider();
    expect(
      p.validateConfig({
        provider: 'github-actions',
        'node-version': '20',
        'deploy-on': 'manual',
      }),
    ).toMatchObject({
      provider: 'github-actions',
      'node-version': '20',
      'deploy-on': 'manual',
    });
  });

  it('rejects unknown keys', () => {
    const p = createGithubActionsProvider();
    expect(() => p.validateConfig({ provider: 'github-actions', extra: 1 })).toThrow(
      GithubActionsProviderError,
    );
  });

  it('rejects a non-supported deploy-on value', () => {
    const p = createGithubActionsProvider();
    expect(() => p.validateConfig({ provider: 'github-actions', 'deploy-on': 'tag' })).toThrow(
      GithubActionsProviderError,
    );
  });
});

describe('createGithubActionsProvider — emitWorkflow', () => {
  it('throws when no deploy adapter is configured', () => {
    const p = createGithubActionsProvider();
    expect(() =>
      p.emitWorkflow({
        appRoot: '/tmp/app',
        config: { provider: 'github-actions' },
      }),
    ).toThrow(/requires a deploy adapter to be configured/);
  });

  it('throws on an unknown adapter name', () => {
    const p = createGithubActionsProvider();
    expect(() =>
      p.emitWorkflow({
        appRoot: '/tmp/app',
        config: { provider: 'github-actions' },
        deployAdapter: 'mystery-meat',
      }),
    ).toThrow(/does not yet know how to deploy via adapter "mystery-meat"/);
  });

  it('emits a single workflow file at .github/workflows/deploy.yml', () => {
    const p = createGithubActionsProvider();
    const files = p.emitWorkflow({
      appRoot: '/tmp/app',
      config: { provider: 'github-actions' },
      deployAdapter: 'vercel',
      deployRequiredEnv: ['VERCEL_TOKEN'],
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('.github/workflows/deploy.yml');
  });

  it('emits valid yaml', () => {
    const p = createGithubActionsProvider();
    const [file] = p.emitWorkflow({
      appRoot: '/tmp/app',
      config: { provider: 'github-actions' },
      deployAdapter: 'vercel',
      deployRequiredEnv: ['VERCEL_TOKEN'],
    });
    expect(() => parseYaml(file?.content ?? '')).not.toThrow();
  });

  it('vercel + github-actions snapshot — pipeline stages and adapter step shape', () => {
    const p = createGithubActionsProvider();
    const [file] = p.emitWorkflow({
      appRoot: '/tmp/app',
      config: { provider: 'github-actions', 'node-version': '20' },
      deployAdapter: 'vercel',
      deployRequiredEnv: ['VERCEL_TOKEN'],
    });
    const wf = parseYaml(file?.content ?? '');

    expect(wf.name).toBe('Deploy');
    expect(wf.on).toEqual({ push: { branches: ['main'] } });
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.jobs.deploy['runs-on']).toBe('ubuntu-latest');

    const steps = wf.jobs.deploy.steps as Array<Record<string, unknown>>;
    const runs = steps.map((s) => s.run).filter(Boolean);
    expect(runs).toContain('npm ci');
    expect(runs).toContain('npm run typecheck');
    expect(runs).toContain('npm run test');
    expect(runs).toContain('npm run lint');
    expect(runs).toContain('npm run build');

    const checkout = steps.find((s) => s.uses === 'actions/checkout@v4');
    expect(checkout).toBeDefined();

    const setupNode = steps.find((s) => s.uses === 'actions/setup-node@v4') as
      | { with: { 'node-version': string; cache: string } }
      | undefined;
    expect(setupNode?.with['node-version']).toBe('20');
    expect(setupNode?.with.cache).toBe('npm');

    const deployStep = steps.find((s) => (s.name as string)?.includes('Deploy via vercel')) as
      | { run: string; env: Record<string, string> }
      | undefined;
    expect(deployStep).toBeDefined();
    expect(deployStep?.run).toMatch(/vercel.*deploy/);
    expect(deployStep?.env.VERCEL_TOKEN).toBe('${{ secrets.VERCEL_TOKEN }}');
  });

  it('defaults to node-version 20 when omitted', () => {
    const [file] = createGithubActionsProvider().emitWorkflow({
      appRoot: '/tmp/app',
      config: { provider: 'github-actions' },
      deployAdapter: 'vercel',
      deployRequiredEnv: ['VERCEL_TOKEN'],
    });
    const wf = parseYaml(file?.content ?? '');
    const setupNode = wf.jobs.deploy.steps.find(
      (s: { uses?: string }) => s.uses === 'actions/setup-node@v4',
    );
    expect(setupNode.with['node-version']).toBe('20');
  });

  it('switches the trigger to workflow_dispatch when deploy-on is manual', () => {
    const [file] = createGithubActionsProvider().emitWorkflow({
      appRoot: '/tmp/app',
      config: { provider: 'github-actions', 'deploy-on': 'manual' },
      deployAdapter: 'vercel',
      deployRequiredEnv: ['VERCEL_TOKEN'],
    });
    const wf = parseYaml(file?.content ?? '');
    expect(wf.on).toEqual({ workflow_dispatch: {} });
  });

  it('emits a no-op deploy step when the adapter is `none`', () => {
    const [file] = createGithubActionsProvider().emitWorkflow({
      appRoot: '/tmp/app',
      config: { provider: 'github-actions' },
      deployAdapter: 'none',
    });
    const wf = parseYaml(file?.content ?? '');
    const step = wf.jobs.deploy.steps.find((s: { name?: string }) =>
      s.name?.includes('No-op deploy'),
    );
    expect(step).toBeDefined();
    expect(step.run).toMatch(/no deploy adapter configured/);
  });
});

describe('bootstrapBuiltinAdapters — providers', () => {
  beforeEach(() => {
    _resetRegistriesForTest();
  });

  afterEach(() => {
    _resetRegistriesForTest();
  });

  it('registers the github-actions provider', () => {
    bootstrapBuiltinAdapters();
    expect(listCicdProviderNames()).toContain(GITHUB_ACTIONS_PROVIDER_NAME);
    expect(getCicdProvider(GITHUB_ACTIONS_PROVIDER_NAME)).toBe(githubActionsProvider);
  });

  it('is idempotent — calling it twice does not throw or duplicate', () => {
    bootstrapBuiltinAdapters();
    expect(() => bootstrapBuiltinAdapters()).not.toThrow();
    expect(listCicdProviderNames().filter((n) => n === GITHUB_ACTIONS_PROVIDER_NAME)).toHaveLength(
      1,
    );
  });
});
