import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import type { MarketplaceYaml } from '../../../src/core/marketplace/catalogue-schema.js';
import {
  CatalogueSourceError,
  createCatalogueFromYaml,
  extractCataloguePolicy,
  loadCatalogue,
  resolveFromCatalogue,
} from '../../../src/core/marketplace/catalogue-source.js';

const execFileAsync = promisify(execFile);

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-catalogue-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

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

function fileUrl(path: string): string {
  return `file://${path}`;
}

/** Write a minimal `.hex/manifest.yaml` + a file inside a directory. */
async function writeTemplate(
  dir: string,
  name: string,
  version: string,
  extraContent = 'hello\n',
): Promise<void> {
  await mkdir(join(dir, '.hex'), { recursive: true });
  await writeFile(
    join(dir, '.hex', 'manifest.yaml'),
    `type: component\nname: ${name}\nversion: ${version}\n`,
    'utf8',
  );
  await writeFile(join(dir, 'README.md'), extraContent, 'utf8');
}

/**
 * Build a git fixture: a single bare-ish repo containing the catalogue's
 * `marketplace.yaml` at the root, plus N sibling template subdirs.
 */
async function makeCatalogueRepo(yaml: MarketplaceYaml): Promise<string> {
  const upstream = join(work, 'catalogue-upstream');
  await mkdir(upstream, { recursive: true });
  await git(upstream, 'init', '-q', '-b', 'main');
  await writeFile(join(upstream, 'marketplace.yaml'), stringifyYaml(yaml), 'utf8');
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'init catalogue');
  return upstream;
}

async function makeTemplateRepo(
  templates: Array<{ path: string; name: string; version: string }>,
): Promise<string> {
  const upstream = join(work, 'templates-upstream');
  await mkdir(upstream, { recursive: true });
  await git(upstream, 'init', '-q', '-b', 'main');
  for (const t of templates) {
    await writeTemplate(join(upstream, t.path), t.name, t.version);
  }
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'init templates');
  return upstream;
}

describe('loadCatalogue', () => {
  it('clones the catalogue repo, reads marketplace.yaml, and validates it', async () => {
    const tplRepo = await makeTemplateRepo([
      { path: 'templates/vite', name: 'vite-ts-spa', version: '0.1.0' },
    ]);
    const catRepo = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [
        {
          name: 'vite-ts-spa',
          versions: [{ tag: '0.1.0', source: { git: fileUrl(tplRepo), path: 'templates/vite' } }],
        },
      ],
    });

    const loaded = await loadCatalogue(
      { url: fileUrl(catRepo) },
      { cacheDir: join(work, 'cache') },
    );

    expect(loaded.yaml.namespace).toBe('hex');
    expect(loaded.yaml.packages).toHaveLength(1);
    expect(loaded.yaml.packages[0]?.name).toBe('vite-ts-spa');
    expect(loaded.source.url).toBe(fileUrl(catRepo));
    expect(loaded.source.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(loaded.yamlPath).toContain('marketplace.yaml');
  });

  it('errors clearly when the repo has no marketplace.yaml', async () => {
    const empty = join(work, 'empty-upstream');
    await mkdir(empty, { recursive: true });
    await git(empty, 'init', '-q', '-b', 'main');
    await writeFile(join(empty, 'README.md'), 'no catalogue\n', 'utf8');
    await git(empty, 'add', '.');
    await git(empty, 'commit', '-q', '-m', 'init');

    await expect(
      loadCatalogue({ url: fileUrl(empty) }, { cacheDir: join(work, 'cache') }),
    ).rejects.toThrow(/has no marketplace\.yaml/);
  });

  it('errors clearly when marketplace.yaml fails schema validation', async () => {
    const upstream = join(work, 'bad-upstream');
    await mkdir(upstream, { recursive: true });
    await git(upstream, 'init', '-q', '-b', 'main');
    await writeFile(join(upstream, 'marketplace.yaml'), 'namespace: Hex\npackages: []\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'init');

    await expect(
      loadCatalogue({ url: fileUrl(upstream) }, { cacheDir: join(work, 'cache') }),
    ).rejects.toThrow(/schema validation failed/);
  });

  it('errors clearly when marketplace.yaml is unparseable yaml', async () => {
    const upstream = join(work, 'broken-upstream');
    await mkdir(upstream, { recursive: true });
    await git(upstream, 'init', '-q', '-b', 'main');
    await writeFile(join(upstream, 'marketplace.yaml'), 'this: is: not: yaml: at: all\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'init');

    await expect(
      loadCatalogue({ url: fileUrl(upstream) }, { cacheDir: join(work, 'cache') }),
    ).rejects.toThrow(CatalogueSourceError);
  });
});

describe('resolveFromCatalogue', () => {
  it('fetches the matching version and returns a ComponentBundle', async () => {
    const tplRepo = await makeTemplateRepo([
      { path: 'templates/vite', name: 'vite-ts-spa', version: '0.1.0' },
    ]);
    const catRepo = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [
        {
          name: 'vite-ts-spa',
          versions: [{ tag: '0.1.0', source: { git: fileUrl(tplRepo), path: 'templates/vite' } }],
        },
      ],
    });

    const loaded = await loadCatalogue(
      { url: fileUrl(catRepo) },
      { cacheDir: join(work, 'cache') },
    );
    const result = await resolveFromCatalogue(loaded, 'vite-ts-spa', '*', {
      cacheDir: join(work, 'cache'),
    });

    expect(result.name).toBe('vite-ts-spa');
    expect(result.version).toBe('0.1.0');
    expect(result.bundle.manifest.name).toBe('vite-ts-spa');
    expect(result.bundle.manifest.version).toBe('0.1.0');
    expect(result.packageSource.git).toBe(fileUrl(tplRepo));
    expect(result.packageSource.path).toBe('templates/vite');
    expect(result.packageSource.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('picks the highest version satisfying a caret spec', async () => {
    const tplRepo = await makeTemplateRepo([
      { path: 'templates/v1', name: 'demo', version: '1.0.0' },
      { path: 'templates/v15', name: 'demo', version: '1.5.0' },
      { path: 'templates/v200', name: 'demo', version: '2.0.0' },
    ]);
    const catRepo = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [
        {
          name: 'demo',
          versions: [
            { tag: '1.0.0', source: { git: fileUrl(tplRepo), path: 'templates/v1' } },
            { tag: '1.5.0', source: { git: fileUrl(tplRepo), path: 'templates/v15' } },
            { tag: '2.0.0', source: { git: fileUrl(tplRepo), path: 'templates/v200' } },
          ],
        },
      ],
    });

    const loaded = await loadCatalogue(
      { url: fileUrl(catRepo) },
      { cacheDir: join(work, 'cache') },
    );

    const v1x = await resolveFromCatalogue(loaded, 'demo', '^1.0.0', {
      cacheDir: join(work, 'cache'),
    });
    expect(v1x.version).toBe('1.5.0');

    const exact = await resolveFromCatalogue(loaded, 'demo', '2.0.0', {
      cacheDir: join(work, 'cache'),
    });
    expect(exact.version).toBe('2.0.0');
  });

  it('throws CatalogueSourceError on an unknown package', async () => {
    const tplRepo = await makeTemplateRepo([
      { path: 'templates/vite', name: 'vite-ts-spa', version: '0.1.0' },
    ]);
    const catRepo = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [
        {
          name: 'vite-ts-spa',
          versions: [{ tag: '0.1.0', source: { git: fileUrl(tplRepo), path: 'templates/vite' } }],
        },
      ],
    });

    const loaded = await loadCatalogue(
      { url: fileUrl(catRepo) },
      { cacheDir: join(work, 'cache') },
    );

    await expect(
      resolveFromCatalogue(loaded, 'missing', '*', { cacheDir: join(work, 'cache') }),
    ).rejects.toThrow(/does not list a package "missing"/);
  });

  it('throws when no version satisfies the spec', async () => {
    const tplRepo = await makeTemplateRepo([
      { path: 'templates/v1', name: 'demo', version: '1.0.0' },
    ]);
    const catRepo = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [
        {
          name: 'demo',
          versions: [{ tag: '1.0.0', source: { git: fileUrl(tplRepo), path: 'templates/v1' } }],
        },
      ],
    });

    const loaded = await loadCatalogue(
      { url: fileUrl(catRepo) },
      { cacheDir: join(work, 'cache') },
    );

    await expect(
      resolveFromCatalogue(loaded, 'demo', '^2.0.0', { cacheDir: join(work, 'cache') }),
    ).rejects.toThrow(/no version of "hex\/demo" satisfies/);
  });

  it("refuses a package that is blocked in the catalogue's own policy", async () => {
    const tplRepo = await makeTemplateRepo([
      { path: 'templates/v1', name: 'banned', version: '1.0.0' },
    ]);
    const catRepo = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [
        {
          name: 'banned',
          versions: [{ tag: '1.0.0', source: { git: fileUrl(tplRepo), path: 'templates/v1' } }],
        },
      ],
      blocks: ['hex/banned'],
    });

    const loaded = await loadCatalogue(
      { url: fileUrl(catRepo) },
      { cacheDir: join(work, 'cache') },
    );

    await expect(
      resolveFromCatalogue(loaded, 'banned', '*', { cacheDir: join(work, 'cache') }),
    ).rejects.toThrow(/blocked by its own catalogue policy/);
  });

  it('resolves when the version source omits the path (whole-repo bundle)', async () => {
    const tplRepo = join(work, 'whole-tpl');
    await mkdir(tplRepo, { recursive: true });
    await git(tplRepo, 'init', '-q', '-b', 'main');
    await writeTemplate(tplRepo, 'whole-app', '0.1.0');
    await git(tplRepo, 'add', '.');
    await git(tplRepo, 'commit', '-q', '-m', 'init');

    const catRepo = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [
        {
          name: 'whole-app',
          versions: [{ tag: '0.1.0', source: { git: fileUrl(tplRepo) } }],
        },
      ],
    });

    const loaded = await loadCatalogue(
      { url: fileUrl(catRepo) },
      { cacheDir: join(work, 'cache') },
    );
    const result = await resolveFromCatalogue(loaded, 'whole-app', '*', {
      cacheDir: join(work, 'cache'),
    });
    expect(result.bundle.manifest.name).toBe('whole-app');
    expect(result.packageSource.path).toBeUndefined();
  });
});

describe('createCatalogueFromYaml (Catalogue interface)', () => {
  async function loaded(): Promise<Awaited<ReturnType<typeof loadCatalogue>>> {
    const tplRepo = await makeTemplateRepo([
      { path: 'templates/v1', name: 'cli', version: '0.1.0' },
    ]);
    const catRepo = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [
        {
          name: 'node-ts-cli',
          description: 'TypeScript CLI scaffolding',
          kind: 'cli',
          categories: ['cli', 'node'],
          versions: [
            { tag: '0.1.0', source: { git: fileUrl(tplRepo), path: 'templates/v1' } },
            { tag: '0.2.0', source: { git: fileUrl(tplRepo), path: 'templates/v1' } },
          ],
        },
        {
          name: 'vite-ts-spa',
          description: 'Minimal Vite SPA',
          kind: 'webapp',
          categories: ['webapp', 'frontend'],
          versions: [{ tag: '0.1.0', source: { git: fileUrl(tplRepo), path: 'templates/v1' } }],
        },
        {
          name: 'banned',
          versions: [{ tag: '0.1.0', source: { git: fileUrl(tplRepo), path: 'templates/v1' } }],
        },
      ],
      blocks: ['hex/banned'],
    });
    return loadCatalogue({ url: fileUrl(catRepo) }, { cacheDir: join(work, 'cache') });
  }

  it('search returns all packages on an empty query, filtering blocked', async () => {
    const cat = createCatalogueFromYaml(await loaded());
    const all = await cat.search('');
    expect(all.map((p) => p.name).sort()).toEqual(['node-ts-cli', 'vite-ts-spa']);
  });

  it('search matches name / description / category substring', async () => {
    const cat = createCatalogueFromYaml(await loaded());
    expect((await cat.search('cli')).map((p) => p.name)).toEqual(['node-ts-cli']);
    expect((await cat.search('Vite')).map((p) => p.name)).toEqual(['vite-ts-spa']);
    expect((await cat.search('frontend')).map((p) => p.name)).toEqual(['vite-ts-spa']);
  });

  it('search returns the latest version', async () => {
    const cat = createCatalogueFromYaml(await loaded());
    const cli = (await cat.search('cli'))[0];
    expect(cli?.latest).toBe('0.2.0');
  });

  it('browse filters by category and excludes blocked', async () => {
    const cat = createCatalogueFromYaml(await loaded());
    expect((await cat.browse('cli')).map((p) => p.name)).toEqual(['node-ts-cli']);
    expect((await cat.browse('webapp')).map((p) => p.name)).toEqual(['vite-ts-spa']);
    expect(await cat.browse('does-not-exist')).toEqual([]);
  });

  it('listVersions returns versions newest first', async () => {
    const cat = createCatalogueFromYaml(await loaded());
    expect(await cat.listVersions('node-ts-cli')).toEqual(['0.2.0', '0.1.0']);
  });

  it('listVersions throws for an unknown package', async () => {
    const cat = createCatalogueFromYaml(await loaded());
    await expect(cat.listVersions('nope')).rejects.toThrow(/does not list a package "nope"/);
  });

  it('listVersions refuses a blocked package', async () => {
    const cat = createCatalogueFromYaml(await loaded());
    await expect(cat.listVersions('banned')).rejects.toThrow(/blocked by its own catalogue policy/);
  });
});

describe('extractCataloguePolicy', () => {
  it('returns blocks + overrides from the catalogue', async () => {
    const tplRepo = await makeTemplateRepo([
      { path: 'templates/v1', name: 'demo', version: '0.1.0' },
    ]);
    const catRepo = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [
        {
          name: 'demo',
          versions: [{ tag: '0.1.0', source: { git: fileUrl(tplRepo), path: 'templates/v1' } }],
        },
      ],
      blocks: ['hex/deprecated', 'acme/anything'],
      overrides: [{ name: 'cli', use: 'hex/demo' }],
    });
    const loaded = await loadCatalogue(
      { url: fileUrl(catRepo) },
      { cacheDir: join(work, 'cache') },
    );

    const policy = extractCataloguePolicy(loaded);
    expect(policy.blocks).toEqual(['hex/deprecated', 'acme/anything']);
    expect(policy.overrides).toEqual([{ name: 'cli', use: 'hex/demo' }]);
  });

  it('returns empty arrays when policy is unset', async () => {
    const tplRepo = await makeTemplateRepo([
      { path: 'templates/v1', name: 'demo', version: '0.1.0' },
    ]);
    const catRepo = await makeCatalogueRepo({
      namespace: 'hex',
      packages: [
        {
          name: 'demo',
          versions: [{ tag: '0.1.0', source: { git: fileUrl(tplRepo), path: 'templates/v1' } }],
        },
      ],
    });
    const loaded = await loadCatalogue(
      { url: fileUrl(catRepo) },
      { cacheDir: join(work, 'cache') },
    );
    const policy = extractCataloguePolicy(loaded);
    expect(policy.blocks).toEqual([]);
    expect(policy.overrides).toEqual([]);
  });
});
