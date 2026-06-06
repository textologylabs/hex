import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import {
  browseCategory,
  browseCategoryAllSources,
  formatCategories,
  listAllCategories,
  listCategories,
} from '../../src/commands/browse.js';
import type { HexConfig } from '../../src/core/config/types.js';
import type { MarketplaceConfig } from '../../src/core/marketplace/address.js';
import type { MarketplaceYaml } from '../../src/core/marketplace/catalogue-schema.js';

const execFileAsync = promisify(execFile);

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-browse-test-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

type CataloguePkg = {
  name: string;
  type: 'component' | 'recipe';
  latest: string;
  categories?: string[];
};
type Policy = { block?: string[] };

async function buildRegistry(
  dirName: string,
  packages: CataloguePkg[],
  policy?: Policy,
): Promise<string> {
  const registryDir = join(work, dirName);
  await mkdir(registryDir, { recursive: true });
  await writeFile(
    join(registryDir, 'catalogue.json'),
    JSON.stringify({ packages, policy }, null, 2),
    'utf8',
  );
  return pathToFileURL(registryDir).href;
}

describe('listCategories', () => {
  it('tallies distinct categories across marketplaces, alphabetical', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api-express', type: 'component', latest: '1.0.0', categories: ['backend'] },
      {
        name: 'db-postgres',
        type: 'component',
        latest: '1.0.0',
        categories: ['backend', 'database'],
      },
    ]);
    const acme = await buildRegistry('acme', [
      { name: 'acme-ui', type: 'component', latest: '1.0.0', categories: ['frontend'] },
      { name: 'acme-api', type: 'component', latest: '1.0.0', categories: ['backend'] },
    ]);
    const marketplaces: MarketplaceConfig[] = [
      { id: 'hex', registry: hex },
      { id: 'acme', registry: acme },
    ];

    const { categories, warnings } = await listCategories(marketplaces);
    expect(warnings).toEqual([]);
    expect(categories).toEqual([
      { name: 'backend', count: 3 },
      { name: 'database', count: 1 },
      { name: 'frontend', count: 1 },
    ]);
  });

  it('excludes blocked entries from the category tally', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'lodash-helpers', type: 'component', latest: '1.0.0', categories: ['utils'] },
      { name: 'api-express', type: 'component', latest: '1.0.0', categories: ['backend'] },
    ]);
    const acme = await buildRegistry('acme', [], { block: ['hex/lodash-helpers'] });

    const { categories } = await listCategories([
      { id: 'hex', registry: hex },
      { id: 'acme', registry: acme },
    ]);
    // `utils` only came from the blocked package — it must not appear.
    expect(categories.map((c) => c.name)).toEqual(['backend']);
  });

  it('warns when a marketplace is unreachable', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api-express', type: 'component', latest: '1.0.0', categories: ['backend'] },
    ]);
    const dead = pathToFileURL(join(work, 'no-registry')).href;

    const { categories, warnings } = await listCategories([
      { id: 'hex', registry: hex },
      { id: 'dead', registry: dead },
    ]);
    expect(categories.map((c) => c.name)).toEqual(['backend']);
    expect(warnings.some((w) => w.startsWith('dead: '))).toBe(true);
  });
});

describe('browseCategory', () => {
  it('lists the entries filed under a category across marketplaces', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api-express', type: 'component', latest: '1.0.0', categories: ['backend'] },
      { name: 'acme-ui', type: 'component', latest: '1.0.0', categories: ['frontend'] },
    ]);
    const acme = await buildRegistry('acme', [
      { name: 'acme-api', type: 'component', latest: '2.0.0', categories: ['backend'] },
    ]);

    const { category, results } = await browseCategory(
      [
        { id: 'hex', registry: hex },
        { id: 'acme', registry: acme },
      ],
      'backend',
    );
    expect(category).toBe('backend');
    expect(results.map((e) => `${e.marketplace}/${e.name}`)).toEqual([
      'hex/api-express',
      'acme/acme-api',
    ]);
  });

  it('returns no entries for an unknown category', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api-express', type: 'component', latest: '1.0.0', categories: ['backend'] },
    ]);
    const { results } = await browseCategory([{ id: 'hex', registry: hex }], 'nonexistent');
    expect(results).toEqual([]);
  });
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

async function makeCatalogueRepo(name: string, yaml: MarketplaceYaml): Promise<string> {
  const upstream = join(work, name);
  await mkdir(upstream, { recursive: true });
  await git(upstream, 'init', '-q', '-b', 'main');
  await writeFile(join(upstream, 'marketplace.yaml'), stringifyYaml(yaml), 'utf8');
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'init');
  return upstream;
}

const stubVersion = (tag: string) => ({ tag, source: { git: 'https://example.test/pkg.git' } });

describe('listAllCategories (M13.3)', () => {
  it('tallies categories across marketplaces and catalogue sources', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api-express', type: 'component', latest: '1.0.0', categories: ['backend'] },
    ]);
    const acme = await makeCatalogueRepo('acme', {
      namespace: 'acme',
      packages: [
        { name: 'web', categories: ['frontend'], versions: [stubVersion('1.0.0')] },
        {
          name: 'queue',
          categories: ['backend', 'messaging'],
          versions: [stubVersion('1.0.0')],
        },
      ],
    });
    const config: HexConfig = {
      sources: [{ kind: 'catalogue', url: `file://${acme}` }],
      marketplaces: [{ id: 'hex', registry: hex }],
    };
    const { categories, warnings } = await listAllCategories(config, {
      cacheDir: join(work, 'cache'),
    });
    expect(warnings).toEqual([]);
    expect(categories).toEqual([
      { name: 'backend', count: 2 },
      { name: 'frontend', count: 1 },
      { name: 'messaging', count: 1 },
    ]);
  });
});

describe('browseCategoryAllSources (M13.3)', () => {
  it('lists entries in a category across marketplaces and catalogue sources', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api-express', type: 'component', latest: '1.0.0', categories: ['backend'] },
    ]);
    const acme = await makeCatalogueRepo('acme', {
      namespace: 'acme',
      packages: [
        { name: 'queue', categories: ['backend'], versions: [stubVersion('1.0.0')] },
        { name: 'web', categories: ['frontend'], versions: [stubVersion('1.0.0')] },
      ],
    });
    const config: HexConfig = {
      sources: [{ kind: 'catalogue', url: `file://${acme}` }],
      marketplaces: [{ id: 'hex', registry: hex }],
    };
    const { category, results } = await browseCategoryAllSources(config, 'backend', {
      cacheDir: join(work, 'cache'),
    });
    expect(category).toBe('backend');
    expect(results.map((e) => `${e.marketplace}/${e.name}`)).toEqual([
      'hex/api-express',
      'acme/queue',
    ]);
  });
});

describe('formatCategories', () => {
  it('renders name + count rows', () => {
    const out = formatCategories([
      { name: 'backend', count: 3 },
      { name: 'database', count: 1 },
    ]);
    expect(out).toContain('backend');
    expect(out).toContain('(3)');
    expect(out).toContain('database');
    expect(out).toContain('(1)');
  });
});
