import { describe, expect, it } from 'vitest';
import type { Manifest } from '../../../src/core/manifest/types.js';
import {
  RecipeContractError,
  validateContracts,
  versionSatisfies,
} from '../../../src/core/recipe/contracts.js';
import type { ChildResolution, ResolvedRecipe } from '../../../src/core/recipe/resolve.js';

function recipeManifest(name: string, overrides: Partial<Manifest> = {}): Manifest {
  return { type: 'recipe', name, version: '1.0.0', ...overrides };
}

function componentManifest(name: string, overrides: Partial<Manifest> = {}): Manifest {
  return { type: 'component', name, version: '1.0.0', ...overrides };
}

function child(key: string, manifest: Manifest, resolved?: ResolvedRecipe): ChildResolution {
  return {
    key,
    ref: { kind: 'name', name: manifest.name, versionSpec: '*' },
    bundle: { manifest, rootPath: `/fake/${key}`, jsHookSources: {} },
    resolved,
  };
}

function recipe(name: string, children: ChildResolution[]): ResolvedRecipe {
  return {
    recipeBundle: { manifest: recipeManifest(name), rootPath: `/fake/${name}`, jsHookSources: {} },
    children: new Map(children.map((c) => [c.key, c])),
  };
}

describe('validateContracts — happy paths', () => {
  it('accepts a recipe with no children', () => {
    expect(() => validateContracts(recipe('empty', []))).not.toThrow();
  });

  it('accepts components with matched provides/consumes', () => {
    const r = recipe('demo', [
      child('db', componentManifest('pg', { kind: 'db', provides: ['DB_URL'] })),
      child('api', componentManifest('api', { kind: 'api', consumes: ['DB_URL'] })),
    ]);
    expect(() => validateContracts(r)).not.toThrow();
  });

  it('accepts a kind-based requires when a peer of that kind exists', () => {
    const r = recipe('demo', [
      child('mon', componentManifest('prom', { kind: 'monitoring' })),
      child('api', componentManifest('api', { kind: 'api', requires: [{ kind: 'monitoring' }] })),
    ]);
    expect(() => validateContracts(r)).not.toThrow();
  });

  it('accepts a name+version requires when a peer at the right version exists', () => {
    const r = recipe('demo', [
      child('auth', componentManifest('auth-session', { version: '1.4.0' })),
      child(
        'csrf',
        componentManifest('csrf', { requires: [{ name: 'auth-session', version: '^1.0.0' }] }),
      ),
    ]);
    expect(() => validateContracts(r)).not.toThrow();
  });
});

describe('validateContracts — wiring errors (consumes)', () => {
  it('throws when a consumed symbol has no provider', () => {
    const r = recipe('demo', [child('api', componentManifest('api', { consumes: ['DB_URL'] }))]);
    let thrown: unknown;
    try {
      validateContracts(r);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RecipeContractError);
    const err = thrown as RecipeContractError;
    expect(err.kind).toBe('wiring');
    expect(err.recipe).toBe('demo');
    expect(err.child).toBe('api');
    expect(err.message).toMatch(/consumes "DB_URL"/);
    expect(err.message).toMatch(/no peer provides it/);
  });

  it('throws when one of several consumed symbols is unprovided', () => {
    const r = recipe('demo', [
      child('db', componentManifest('pg', { provides: ['DB_URL'] })),
      child('api', componentManifest('api', { consumes: ['DB_URL', 'CACHE_URL'] })),
    ]);
    expect(() => validateContracts(r)).toThrow(/CACHE_URL/);
  });
});

describe('validateContracts — composition errors (requires)', () => {
  it('throws when a kind-based requires has no matching peer', () => {
    const r = recipe('demo', [
      child('api', componentManifest('api', { kind: 'api', requires: [{ kind: 'monitoring' }] })),
    ]);
    let thrown: unknown;
    try {
      validateContracts(r);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RecipeContractError);
    const err = thrown as RecipeContractError;
    expect(err.kind).toBe('composition');
    expect(err.message).toMatch(/peer of kind "monitoring"/);
  });

  it('does not let a child satisfy its own kind requirement', () => {
    const r = recipe('demo', [
      child(
        'mon',
        componentManifest('prom', { kind: 'monitoring', requires: [{ kind: 'monitoring' }] }),
      ),
    ]);
    expect(() => validateContracts(r)).toThrow(/no peer with kind "monitoring"/);
  });

  it('throws when a name+version requires has no peer with that name', () => {
    const r = recipe('demo', [
      child(
        'csrf',
        componentManifest('csrf', { requires: [{ name: 'auth-session', version: '^1.0.0' }] }),
      ),
    ]);
    expect(() => validateContracts(r)).toThrow(/no peer named "auth-session"/);
  });

  it('throws when a name+version peer is present but at the wrong version', () => {
    const r = recipe('demo', [
      child('auth', componentManifest('auth-session', { version: '0.9.0' })),
      child(
        'csrf',
        componentManifest('csrf', { requires: [{ name: 'auth-session', version: '^1.0.0' }] }),
      ),
    ]);
    expect(() => validateContracts(r)).toThrow(/does not satisfy "\^1.0.0"/);
  });

  it('reports the composition error class for requires failures (not wiring)', () => {
    const r = recipe('demo', [
      child('csrf', componentManifest('csrf', { requires: [{ kind: 'auth' }] })),
    ]);
    try {
      validateContracts(r);
      expect.fail('expected throw');
    } catch (e) {
      expect((e as RecipeContractError).kind).toBe('composition');
    }
  });
});

describe('validateContracts — sub-recipes', () => {
  it('validates contracts inside a sub-recipe independently', () => {
    const innerBad = recipe('inner', [
      child('api', componentManifest('api', { consumes: ['MISSING'] })),
    ]);
    const outer = recipe('outer', [
      {
        key: 'inner',
        ref: { kind: 'name', name: 'inner', versionSpec: '*' },
        bundle: { manifest: recipeManifest('inner'), rootPath: '/fake/inner', jsHookSources: {} },
        resolved: innerBad,
      },
    ]);
    expect(() => validateContracts(outer)).toThrow(/recipe "inner".*MISSING/);
  });

  it('does not leak provides across recipe boundaries', () => {
    // db is provided in the outer recipe; the inner recipe's api consumes it,
    // but they are in different scopes so the consume is unsatisfied.
    const inner = recipe('inner', [
      child('api', componentManifest('api', { consumes: ['DB_URL'] })),
    ]);
    const outer = recipe('outer', [
      child('db', componentManifest('pg', { provides: ['DB_URL'] })),
      {
        key: 'inner',
        ref: { kind: 'name', name: 'inner', versionSpec: '*' },
        bundle: { manifest: recipeManifest('inner'), rootPath: '/fake/inner', jsHookSources: {} },
        resolved: inner,
      },
    ]);
    expect(() => validateContracts(outer)).toThrow(/recipe "inner".*DB_URL/);
  });
});

describe('versionSatisfies', () => {
  it('matches `*` against any version', () => {
    expect(versionSatisfies('1.2.3', '*')).toBe(true);
    expect(versionSatisfies('0.0.1', '*')).toBe(true);
  });

  it('matches bare semver as exact', () => {
    expect(versionSatisfies('1.2.3', '1.2.3')).toBe(true);
    expect(versionSatisfies('1.2.4', '1.2.3')).toBe(false);
  });

  it('matches `=` as exact', () => {
    expect(versionSatisfies('1.2.3', '=1.2.3')).toBe(true);
    expect(versionSatisfies('1.2.4', '=1.2.3')).toBe(false);
  });

  it('matches `^` against same major, ≥ spec', () => {
    expect(versionSatisfies('1.5.0', '^1.0.0')).toBe(true);
    expect(versionSatisfies('1.0.0', '^1.0.0')).toBe(true);
    expect(versionSatisfies('2.0.0', '^1.0.0')).toBe(false);
    expect(versionSatisfies('0.9.0', '^1.0.0')).toBe(false);
  });

  it('matches `~` against same major.minor, ≥ spec', () => {
    expect(versionSatisfies('1.2.5', '~1.2.0')).toBe(true);
    expect(versionSatisfies('1.2.0', '~1.2.0')).toBe(true);
    expect(versionSatisfies('1.3.0', '~1.2.0')).toBe(false);
    expect(versionSatisfies('1.1.9', '~1.2.0')).toBe(false);
  });

  it('matches `>=`, `<=`, `>`, `<`', () => {
    expect(versionSatisfies('1.0.0', '>=1.0.0')).toBe(true);
    expect(versionSatisfies('0.9.0', '>=1.0.0')).toBe(false);
    expect(versionSatisfies('1.0.0', '<=1.0.0')).toBe(true);
    expect(versionSatisfies('1.0.1', '<=1.0.0')).toBe(false);
    expect(versionSatisfies('1.0.1', '>1.0.0')).toBe(true);
    expect(versionSatisfies('1.0.0', '>1.0.0')).toBe(false);
    expect(versionSatisfies('0.9.9', '<1.0.0')).toBe(true);
    expect(versionSatisfies('1.0.0', '<1.0.0')).toBe(false);
  });

  it('strips prerelease/build metadata for comparison', () => {
    expect(versionSatisfies('1.0.0-alpha.1', '^1.0.0')).toBe(true);
    expect(versionSatisfies('1.0.0+build.1', '1.0.0')).toBe(true);
  });
});
