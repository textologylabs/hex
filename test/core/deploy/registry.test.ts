import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeployRegistryError,
  NULL_ADAPTER_NAME,
  _resetRegistriesForTest,
  getCicdProvider,
  getDeployAdapter,
  listCicdProviderNames,
  listDeployAdapterNames,
  nullAdapter,
  registerCicdProvider,
  registerDeployAdapter,
} from '../../../src/core/deploy/index.js';
import type { CicdProvider, DeployAdapter } from '../../../src/core/deploy/index.js';

beforeEach(() => {
  _resetRegistriesForTest();
});

afterEach(() => {
  _resetRegistriesForTest();
});

describe('deploy registry', () => {
  it('pre-registers the null adapter', () => {
    expect(listDeployAdapterNames()).toContain(NULL_ADAPTER_NAME);
    expect(getDeployAdapter(NULL_ADAPTER_NAME)).toBe(nullAdapter);
  });

  it('registers and resolves a deploy adapter', () => {
    const fake: DeployAdapter = {
      name: 'fake',
      requiredEnv: ['FAKE_TOKEN'],
      validateConfig: (s) => s,
      deploy: async () => ({ url: 'https://x.example' }),
    };
    registerDeployAdapter(fake);
    expect(getDeployAdapter('fake')).toBe(fake);
    expect(listDeployAdapterNames()).toEqual(['fake', NULL_ADAPTER_NAME]);
  });

  it('rejects duplicate adapter registration', () => {
    const fake: DeployAdapter = {
      name: 'dup',
      requiredEnv: [],
      validateConfig: (s) => s,
      deploy: async () => ({}),
    };
    registerDeployAdapter(fake);
    expect(() => registerDeployAdapter(fake)).toThrow(DeployRegistryError);
  });

  it('throws on unknown adapter lookup', () => {
    expect(() => getDeployAdapter('missing')).toThrow(/unknown deploy adapter "missing"/);
  });

  it('registers and resolves a cicd provider', () => {
    const provider: CicdProvider = {
      name: 'fake-ci',
      validateConfig: (s) => s,
      emitWorkflow: () => [],
    };
    registerCicdProvider(provider);
    expect(getCicdProvider('fake-ci')).toBe(provider);
    expect(listCicdProviderNames()).toEqual(['fake-ci']);
  });

  it('rejects duplicate provider registration', () => {
    const provider: CicdProvider = {
      name: 'dup-ci',
      validateConfig: (s) => s,
      emitWorkflow: () => [],
    };
    registerCicdProvider(provider);
    expect(() => registerCicdProvider(provider)).toThrow(DeployRegistryError);
  });

  it('throws on unknown provider lookup', () => {
    expect(() => getCicdProvider('missing')).toThrow(/unknown cicd provider "missing"/);
  });

  it('_resetRegistriesForTest restores built-ins and clears user registrations', () => {
    registerDeployAdapter({
      name: 'leaky',
      requiredEnv: [],
      validateConfig: (s) => s,
      deploy: async () => ({}),
    });
    expect(listDeployAdapterNames()).toContain('leaky');

    _resetRegistriesForTest();

    expect(listDeployAdapterNames()).toEqual([NULL_ADAPTER_NAME]);
    expect(listCicdProviderNames()).toEqual([]);
  });
});

describe('null adapter', () => {
  it('deploy() resolves to an empty result without side effects', async () => {
    const result = await nullAdapter.deploy({
      appRoot: '/tmp/nowhere',
      config: { adapter: 'none' },
      env: {},
    });
    expect(result).toEqual({});
  });

  it('validateConfig is a pass-through', () => {
    const stanza = { adapter: 'none', extra: 1 };
    expect(nullAdapter.validateConfig(stanza)).toBe(stanza);
  });

  it('requires no env vars', () => {
    expect(nullAdapter.requiredEnv).toEqual([]);
  });
});
