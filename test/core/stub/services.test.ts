import { describe, expect, it } from 'vitest';
import type { ChildRef, Manifest, Stub } from '../../../src/core/manifest/types.js';
import type { ChildResolution, ResolvedRecipe } from '../../../src/core/recipe/resolve.js';
import {
  enginePort,
  engineProcessModel,
  isOutOfProcess,
} from '../../../src/core/stub/catalogue.js';
import { collectStubServices, engineSymbolPrefix } from '../../../src/core/stub/services.js';

function componentManifest(name: string, stub?: Stub): Manifest {
  return { type: 'component', name, version: '1.0.0', ...(stub ? { stub } : {}) };
}

function child(key: string, manifest: Manifest, stubFlag: boolean): ChildResolution {
  const ref: ChildRef = {
    kind: 'name',
    name: manifest.name,
    versionSpec: '*',
    stub: stubFlag,
  };
  return {
    key,
    ref,
    bundle: { manifest, rootPath: `/fake/${key}`, jsHookSources: {}, sourceKind: 'file' },
  };
}

function recipe(children: ChildResolution[]): ResolvedRecipe {
  return {
    recipeBundle: {
      manifest: { type: 'recipe', name: 'demo', version: '1.0.0' },
      rootPath: '/fake/demo',
      jsHookSources: {},
      sourceKind: 'file',
    },
    children: new Map(children.map((c) => [c.key, c])),
  };
}

describe('stub engine catalogue', () => {
  it('classifies pg-mem and msw as in-process', () => {
    expect(engineProcessModel('pg-mem')).toBe('in-process');
    expect(engineProcessModel('msw')).toBe('in-process');
    expect(isOutOfProcess('pg-mem')).toBe(false);
    expect(isOutOfProcess('msw')).toBe(false);
  });

  it('classifies wiremock as out-of-process with a default port', () => {
    expect(engineProcessModel('wiremock')).toBe('out-of-process');
    expect(isOutOfProcess('wiremock')).toBe(true);
    expect(enginePort('wiremock')).toBe(8080);
  });

  it('reports no port for in-process engines', () => {
    expect(enginePort('pg-mem')).toBeUndefined();
    expect(enginePort('msw')).toBeUndefined();
  });
});

describe('engineSymbolPrefix', () => {
  it('uppercases and collapses non-alphanumerics', () => {
    expect(engineSymbolPrefix('wiremock')).toBe('STUB_WIREMOCK');
    expect(engineSymbolPrefix('pg-mem')).toBe('STUB_PG_MEM');
  });
});

describe('collectStubServices', () => {
  it('returns nothing when no children are stubbed', () => {
    const r = recipe([child('a', componentManifest('a', { engine: 'wiremock' }), false)]);
    expect(collectStubServices(r)).toEqual([]);
  });

  it('emits a single service for one out-of-process stubbed child', () => {
    const r = recipe([child('api', componentManifest('api-x', { engine: 'wiremock' }), true)]);
    expect(collectStubServices(r)).toEqual([{ engine: 'wiremock', host: 'wiremock', port: 8080 }]);
  });

  it('deduplicates two children stubbing against the same engine', () => {
    const r = recipe([
      child('api', componentManifest('api-x', { engine: 'wiremock' }), true),
      child('payments', componentManifest('pay-x', { engine: 'wiremock' }), true),
    ]);
    expect(collectStubServices(r)).toEqual([{ engine: 'wiremock', host: 'wiremock', port: 8080 }]);
  });

  it('ignores in-process engines', () => {
    const r = recipe([child('db', componentManifest('db-x', { engine: 'pg-mem' }), true)]);
    expect(collectStubServices(r)).toEqual([]);
  });

  it('ignores a stubbable child whose slot is not stub-enabled', () => {
    const r = recipe([child('api', componentManifest('api-x', { engine: 'wiremock' }), false)]);
    expect(collectStubServices(r)).toEqual([]);
  });
});
