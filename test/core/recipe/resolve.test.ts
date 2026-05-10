import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HexConfig } from '../../../src/core/config/types.js';
import { RecipeResolutionError, resolveRecipe } from '../../../src/core/recipe/resolve.js';
import { loadFromPath } from '../../../src/core/sources/file-source.js';

const execFileAsync = promisify(execFile);

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-recipe-resolve-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeManifest(rootPath: string, manifest: object): Promise<void> {
  const hexDir = join(rootPath, '.hex');
  await mkdir(hexDir, { recursive: true });
  await writeFile(join(hexDir, 'manifest.yaml'), serialize(manifest), 'utf8');
}

function serialize(obj: unknown, indent = 0): string {
  // Tiny YAML-emitter for fixtures — only handles scalars / nested maps.
  // Keeps the test free of a yaml lib dep.
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    return `\n${obj.map((v) => `${' '.repeat(indent)}- ${serialize(v, indent + 2)}`).join('\n')}`;
  }
  const entries = Object.entries(obj);
  return `\n${entries
    .map(([k, v]) => `${' '.repeat(indent)}${k}: ${serialize(v, indent + 2)}`)
    .join('\n')}`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return stdout.trim();
}

async function makeUpstreamGitRepo(): Promise<string> {
  const upstream = join(work, 'git-upstream');
  await mkdir(upstream, { recursive: true });
  await git(upstream, 'init', '-q', '-b', 'main');
  // Put a child component manifest at the root of the repo.
  await writeManifest(upstream, {
    type: 'component',
    name: 'git-child',
    version: '0.1.0',
  });
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'initial');
  return upstream;
}

function fileUrl(path: string): string {
  return `file://${path}`;
}

describe('resolveRecipe — file: refs', () => {
  it('resolves a "file:" child relative to the recipe root', async () => {
    const recipeRoot = join(work, 'recipe');
    const childRoot = join(work, 'children', 'cli');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { cli: 'file:../children/cli' },
    });
    await writeManifest(childRoot, {
      type: 'component',
      name: 'demo-cli',
      version: '0.1.0',
    });

    const recipeBundle = await loadFromPath(recipeRoot);
    const result = await resolveRecipe(recipeBundle, { config: { sources: [] } });

    expect(result.children.size).toBe(1);
    const cli = result.children.get('cli');
    expect(cli?.bundle.manifest.name).toBe('demo-cli');
    expect(cli?.ref).toEqual({ kind: 'file', path: '../children/cli' });
  });

  it('resolves an absolute "file:" path verbatim', async () => {
    const recipeRoot = join(work, 'recipe');
    const childRoot = join(work, 'absolute-child');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { foo: `file:${childRoot}` },
    });
    await writeManifest(childRoot, {
      type: 'component',
      name: 'absolute-foo',
      version: '0.1.0',
    });

    const recipeBundle = await loadFromPath(recipeRoot);
    const result = await resolveRecipe(recipeBundle, { config: { sources: [] } });

    expect(result.children.get('foo')?.bundle.manifest.name).toBe('absolute-foo');
  });
});

describe('resolveRecipe — bare-name refs through source roots', () => {
  it('finds a child by name in a configured path source root', async () => {
    const sourceRoot = join(work, 'sources');
    await mkdir(sourceRoot, { recursive: true });
    const recipeRoot = join(work, 'recipe');
    const childRoot = join(sourceRoot, 'thing');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { thing: 'discovered-thing@^0.1.0' },
    });
    await writeManifest(childRoot, {
      type: 'component',
      name: 'discovered-thing',
      version: '0.1.0',
    });

    const config: HexConfig = { sources: [{ kind: 'path', path: sourceRoot }] };
    const recipeBundle = await loadFromPath(recipeRoot);
    const result = await resolveRecipe(recipeBundle, { config });

    expect(result.children.get('thing')?.bundle.manifest.name).toBe('discovered-thing');
  });

  it('first-source-root wins when two roots host the same name (and emits a warning)', async () => {
    const rootA = join(work, 'root-a');
    const rootB = join(work, 'root-b');
    const recipeRoot = join(work, 'recipe');
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { dup: 'duplicated@^0.1.0' },
    });
    await writeManifest(join(rootA, 'first'), {
      type: 'component',
      name: 'duplicated',
      version: '0.1.0',
      kind: 'from-a',
    });
    await writeManifest(join(rootB, 'second'), {
      type: 'component',
      name: 'duplicated',
      version: '0.2.0',
      kind: 'from-b',
    });

    const config: HexConfig = {
      sources: [
        { kind: 'path', path: rootA },
        { kind: 'path', path: rootB },
      ],
    };
    const recipeBundle = await loadFromPath(recipeRoot);
    const warnings: string[] = [];
    const result = await resolveRecipe(recipeBundle, { config, warnings });

    expect(result.children.get('dup')?.bundle.manifest.kind).toBe('from-a');
    expect(warnings.some((w) => /duplicate template "duplicated"/.test(w))).toBe(true);
  });
});

describe('resolveRecipe — git+ refs', () => {
  it('clones a git child and loads its manifest', async () => {
    const upstream = await makeUpstreamGitRepo();
    const cacheDir = join(work, 'cache');
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { svc: `git+${fileUrl(upstream)}` },
    });

    const recipeBundle = await loadFromPath(recipeRoot);
    const result = await resolveRecipe(recipeBundle, { config: { sources: [] }, cacheDir });

    expect(result.children.get('svc')?.bundle.manifest.name).toBe('git-child');
  });

  it('honours an explicit @ref on a git+ entry', async () => {
    const upstream = await makeUpstreamGitRepo();
    const cacheDir = join(work, 'cache');
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { svc: `git+${fileUrl(upstream)}@main` },
    });

    const recipeBundle = await loadFromPath(recipeRoot);
    const result = await resolveRecipe(recipeBundle, { config: { sources: [] }, cacheDir });

    expect(result.children.get('svc')?.bundle.manifest.name).toBe('git-child');
    expect(result.children.get('svc')?.ref).toEqual({
      kind: 'git',
      url: fileUrl(upstream),
      ref: 'main',
    });
  });
});

describe('resolveRecipe — error handling', () => {
  it('throws RecipeResolutionError naming the failing key on missing bare-name child', async () => {
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { ghost: 'no-such-template@^0.1.0' },
    });

    const recipeBundle = await loadFromPath(recipeRoot);
    await expect(resolveRecipe(recipeBundle, { config: { sources: [] } })).rejects.toMatchObject({
      name: 'RecipeResolutionError',
      key: 'ghost',
    });
  });

  it('throws RecipeResolutionError on an unreachable file: path', async () => {
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { broken: 'file:./nope' },
    });

    const recipeBundle = await loadFromPath(recipeRoot);
    await expect(resolveRecipe(recipeBundle, { config: { sources: [] } })).rejects.toBeInstanceOf(
      RecipeResolutionError,
    );
  });

  it('throws when called on a non-recipe bundle', async () => {
    const componentRoot = join(work, 'comp');
    await writeManifest(componentRoot, {
      type: 'component',
      name: 'leaf',
      version: '0.1.0',
    });
    const bundle = await loadFromPath(componentRoot);
    await expect(resolveRecipe(bundle, { config: { sources: [] } })).rejects.toThrow(
      /resolveRecipe called on a component/,
    );
  });

  it('returns an empty children map for a recipe with no composes block', async () => {
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
    });
    const bundle = await loadFromPath(recipeRoot);
    const result = await resolveRecipe(bundle, { config: { sources: [] } });
    expect(result.children.size).toBe(0);
    expect(result.recipeBundle).toBe(bundle);
  });

  it('skips discovery when no child uses a bare-name ref', async () => {
    // If discovery were called, it would fail loudly because there's no
    // valid source root configured. The test asserting success is the proof
    // that discovery was bypassed.
    const recipeRoot = join(work, 'recipe');
    const childRoot = join(work, 'child');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { local: 'file:../child' },
    });
    await writeManifest(childRoot, {
      type: 'component',
      name: 'local-child',
      version: '0.1.0',
    });
    const bundle = await loadFromPath(recipeRoot);
    const result = await resolveRecipe(bundle, {
      config: { sources: [{ kind: 'path', path: '/this/path/does/not/exist' }] },
    });
    expect(result.children.get('local')?.bundle.manifest.name).toBe('local-child');
  });
});

describe('resolveRecipe — recursive (recipe composing recipes)', () => {
  it('recursively resolves a 2-level recipe (outer → inner-recipe → leaf)', async () => {
    const outerRoot = join(work, 'outer');
    const innerRoot = join(work, 'inner');
    const leafRoot = join(work, 'leaf');
    await writeManifest(outerRoot, {
      type: 'recipe',
      name: 'outer',
      version: '0.1.0',
      composes: { inner: 'file:../inner' },
    });
    await writeManifest(innerRoot, {
      type: 'recipe',
      name: 'inner',
      version: '0.1.0',
      composes: { leaf: 'file:../leaf' },
    });
    await writeManifest(leafRoot, {
      type: 'component',
      name: 'leaf',
      version: '0.1.0',
    });

    const bundle = await loadFromPath(outerRoot);
    const result = await resolveRecipe(bundle, { config: { sources: [] } });

    const innerChild = result.children.get('inner');
    expect(innerChild?.bundle.manifest.name).toBe('inner');
    expect(innerChild?.resolved).toBeDefined();

    const leafChild = innerChild?.resolved?.children.get('leaf');
    expect(leafChild?.bundle.manifest.name).toBe('leaf');
    expect(leafChild?.resolved).toBeUndefined(); // it's a component
  });

  it('rejects a direct cycle (recipe references itself)', async () => {
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'self',
      version: '0.1.0',
      composes: { me: 'file:.' },
    });

    const bundle = await loadFromPath(recipeRoot);
    await expect(resolveRecipe(bundle, { config: { sources: [] } })).rejects.toMatchObject({
      name: 'RecipeResolutionError',
      key: 'me',
    });
    await expect(resolveRecipe(bundle, { config: { sources: [] } })).rejects.toThrow(/cycle/);
  });

  it('rejects an indirect cycle (A → B → A)', async () => {
    const aRoot = join(work, 'a');
    const bRoot = join(work, 'b');
    await writeManifest(aRoot, {
      type: 'recipe',
      name: 'a',
      version: '0.1.0',
      composes: { b: 'file:../b' },
    });
    await writeManifest(bRoot, {
      type: 'recipe',
      name: 'b',
      version: '0.1.0',
      composes: { a: 'file:../a' },
    });

    const bundle = await loadFromPath(aRoot);
    await expect(resolveRecipe(bundle, { config: { sources: [] } })).rejects.toMatchObject({
      name: 'RecipeResolutionError',
      key: 'a',
    });
    await expect(resolveRecipe(bundle, { config: { sources: [] } })).rejects.toThrow(
      /cycle.*<root>.*→.*b.*→.*a/,
    );
  });

  it('allows the same recipe under two different keys (still tree-shaped)', async () => {
    // outer composes inner under two keys; inner is a leaf-component recipe
    // (composes nothing). Path-stack-based cycle detection should NOT
    // false-positive — siblings sharing identity is a tree, not a cycle.
    const outerRoot = join(work, 'outer');
    const innerRoot = join(work, 'inner');
    const leafRoot = join(work, 'leaf');
    await writeManifest(outerRoot, {
      type: 'recipe',
      name: 'outer',
      version: '0.1.0',
      composes: { first: 'file:../inner', second: 'file:../inner' },
    });
    await writeManifest(innerRoot, {
      type: 'recipe',
      name: 'inner',
      version: '0.1.0',
      composes: { leaf: 'file:../leaf' },
    });
    await writeManifest(leafRoot, {
      type: 'component',
      name: 'leaf',
      version: '0.1.0',
    });

    const bundle = await loadFromPath(outerRoot);
    const result = await resolveRecipe(bundle, { config: { sources: [] } });
    expect(result.children.get('first')?.resolved?.children.get('leaf')?.bundle.manifest.name).toBe(
      'leaf',
    );
    expect(
      result.children.get('second')?.resolved?.children.get('leaf')?.bundle.manifest.name,
    ).toBe('leaf');
  });
});

describe('resolveRecipe — slot refs (M6.3)', () => {
  it('picks a component by kind from a configured source root', async () => {
    const sourceRoot = join(work, 'sources');
    await mkdir(sourceRoot, { recursive: true });
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { api: { kind: 'api', version: '^1.0.0' } },
    });
    await writeManifest(join(sourceRoot, 'express'), {
      type: 'component',
      name: 'api-express',
      version: '1.4.0',
      kind: 'api',
    });

    const config: HexConfig = { sources: [{ kind: 'path', path: sourceRoot }] };
    const recipeBundle = await loadFromPath(recipeRoot);
    const result = await resolveRecipe(recipeBundle, { config });

    expect(result.children.get('api')?.bundle.manifest.name).toBe('api-express');
  });

  it('warns when multiple candidates match the slot, picking the first', async () => {
    const sourceRoot = join(work, 'sources');
    await mkdir(sourceRoot, { recursive: true });
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { api: { kind: 'api', version: '^1.0.0' } },
    });
    await writeManifest(join(sourceRoot, 'express'), {
      type: 'component',
      name: 'api-express',
      version: '1.4.0',
      kind: 'api',
    });
    await writeManifest(join(sourceRoot, 'fastify'), {
      type: 'component',
      name: 'api-fastify',
      version: '1.0.0',
      kind: 'api',
    });

    const config: HexConfig = { sources: [{ kind: 'path', path: sourceRoot }] };
    const recipeBundle = await loadFromPath(recipeRoot);
    const warnings: string[] = [];
    const result = await resolveRecipe(recipeBundle, { config, warnings });

    // Either candidate is acceptable as "first"; the warning is what we assert on.
    expect(['api-express', 'api-fastify']).toContain(
      result.children.get('api')?.bundle.manifest.name,
    );
    expect(warnings.some((w) => /ambiguous slot for kind "api"/.test(w))).toBe(true);
    expect(
      warnings.some((w) => /api-express@1\.4\.0/.test(w) && /api-fastify@1\.0\.0/.test(w)),
    ).toBe(true);
  });

  it('filters candidates by version spec', async () => {
    const sourceRoot = join(work, 'sources');
    await mkdir(sourceRoot, { recursive: true });
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { api: { kind: 'api', version: '^2.0.0' } },
    });
    await writeManifest(join(sourceRoot, 'old'), {
      type: 'component',
      name: 'api-old',
      version: '1.0.0',
      kind: 'api',
    });
    await writeManifest(join(sourceRoot, 'new'), {
      type: 'component',
      name: 'api-new',
      version: '2.3.0',
      kind: 'api',
    });

    const config: HexConfig = { sources: [{ kind: 'path', path: sourceRoot }] };
    const recipeBundle = await loadFromPath(recipeRoot);
    const result = await resolveRecipe(recipeBundle, { config });

    expect(result.children.get('api')?.bundle.manifest.name).toBe('api-new');
  });

  it('errors when no component matches the slot kind', async () => {
    const sourceRoot = join(work, 'sources');
    await mkdir(sourceRoot, { recursive: true });
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { api: { kind: 'api', version: '^1.0.0' } },
    });
    await writeManifest(join(sourceRoot, 'wrong-kind'), {
      type: 'component',
      name: 'cache-redis',
      version: '1.0.0',
      kind: 'cache',
    });

    const config: HexConfig = { sources: [{ kind: 'path', path: sourceRoot }] };
    const recipeBundle = await loadFromPath(recipeRoot);

    await expect(resolveRecipe(recipeBundle, { config })).rejects.toThrow(
      /no component with kind "api"/,
    );
  });

  it('explicit name form does not fall back to kind matching', async () => {
    // The recipe asks for `api-fastify` by name; only `api-express` (same kind)
    // is in the source root. Should error, not silently substitute by kind.
    const sourceRoot = join(work, 'sources');
    await mkdir(sourceRoot, { recursive: true });
    const recipeRoot = join(work, 'recipe');
    await writeManifest(recipeRoot, {
      type: 'recipe',
      name: 'demo',
      version: '0.1.0',
      composes: { api: 'api-fastify@^1.0.0' },
    });
    await writeManifest(join(sourceRoot, 'express'), {
      type: 'component',
      name: 'api-express',
      version: '1.4.0',
      kind: 'api',
    });

    const config: HexConfig = { sources: [{ kind: 'path', path: sourceRoot }] };
    const recipeBundle = await loadFromPath(recipeRoot);

    await expect(resolveRecipe(recipeBundle, { config })).rejects.toThrow(
      /no template named "api-fastify"/,
    );
  });
});
