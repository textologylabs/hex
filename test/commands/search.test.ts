import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import {
  formatSearchTable,
  searchAllSources,
  searchMarketplaces,
} from '../../src/commands/search.js';
import type { HexConfig } from '../../src/core/config/types.js';
import type { MarketplaceConfig } from '../../src/core/marketplace/address.js';
import type { MarketplaceYaml } from '../../src/core/marketplace/catalogue-schema.js';

const execFileAsync = promisify(execFile);

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-search-test-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

type CataloguePkg = {
  name: string;
  type: 'component' | 'recipe';
  latest: string;
  description?: string;
  categories?: string[];
};
type Policy = { block?: string[]; override?: Array<{ name: string; use: string }> };

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

describe('searchMarketplaces', () => {
  it('aggregates hits across every configured marketplace', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api-express', type: 'component', latest: '1.0.0', description: 'Express layer' },
    ]);
    const acme = await buildRegistry('acme', [
      { name: 'acme-api', type: 'component', latest: '2.0.0', description: 'Express layer' },
    ]);
    const marketplaces: MarketplaceConfig[] = [
      { id: 'hex', registry: hex },
      { id: 'acme', registry: acme },
    ];

    const { results, warnings } = await searchMarketplaces(marketplaces, 'express');
    expect(warnings).toEqual([]);
    expect(results.map((e) => `${e.marketplace}/${e.name}`)).toEqual([
      'hex/api-express',
      'acme/acme-api',
    ]);
  });

  it('respects block policy — a blocked entry is absent from results', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'lodash-helpers', type: 'component', latest: '1.0.0' },
      { name: 'api-express', type: 'component', latest: '1.0.0' },
    ]);
    const acme = await buildRegistry('acme', [], { block: ['hex/lodash-helpers'] });

    const { results } = await searchMarketplaces(
      [
        { id: 'hex', registry: hex },
        { id: 'acme', registry: acme },
      ],
      '',
    );
    expect(results.map((e) => `${e.marketplace}/${e.name}`)).toEqual(['hex/api-express']);
  });

  it('collects a warning when a marketplace is unreachable', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api-express', type: 'component', latest: '1.0.0' },
    ]);
    const dead = pathToFileURL(join(work, 'no-registry')).href;

    const { results, warnings } = await searchMarketplaces(
      [
        { id: 'hex', registry: hex },
        { id: 'dead', registry: dead },
      ],
      'api',
    );
    expect(results.map((e) => e.marketplace)).toEqual(['hex']);
    // One warning from the policy load, one from the search fan-out.
    expect(warnings.some((w) => w.startsWith('dead: '))).toBe(true);
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

describe('searchAllSources (M13.3)', () => {
  it('unions hits across marketplaces and catalogue sources', async () => {
    const hex = await buildRegistry('hex', [
      {
        name: 'api-express',
        type: 'component',
        latest: '1.0.0',
        description: 'Express layer',
      },
    ]);
    const acme = await makeCatalogueRepo('acme', {
      namespace: 'acme',
      packages: [
        {
          name: 'api-fastify',
          description: 'Fastify express-like layer',
          versions: [stubVersion('2.0.0')],
        },
      ],
    });

    const config: HexConfig = {
      sources: [{ kind: 'catalogue', url: `file://${acme}` }],
      marketplaces: [{ id: 'hex', registry: hex }],
    };

    const { results, warnings } = await searchAllSources(config, 'express', {
      cacheDir: join(work, 'cache'),
    });
    expect(warnings).toEqual([]);
    expect(results.map((e) => `${e.marketplace}/${e.name}`)).toEqual([
      'hex/api-express',
      'acme/api-fastify',
    ]);
  });

  it('honours catalogue blocks — blocked entries are absent', async () => {
    const acme = await makeCatalogueRepo('acme', {
      namespace: 'acme',
      packages: [
        { name: 'visible', versions: [stubVersion('1.0.0')] },
        { name: 'hidden', versions: [stubVersion('1.0.0')] },
      ],
      blocks: ['acme/hidden'],
    });
    const config: HexConfig = {
      sources: [{ kind: 'catalogue', url: `file://${acme}` }],
      marketplaces: [],
    };
    const { results } = await searchAllSources(config, '', {
      cacheDir: join(work, 'cache'),
    });
    expect(results.map((e) => e.name)).toEqual(['visible']);
  });

  it('collects a warning when a catalogue source is broken', async () => {
    const acme = await makeCatalogueRepo('acme', {
      namespace: 'acme',
      packages: [{ name: 'p', versions: [stubVersion('1.0.0')] }],
    });
    const broken = join(work, 'broken');
    await mkdir(broken, { recursive: true });
    await git(broken, 'init', '-q', '-b', 'main');
    await writeFile(join(broken, 'README.md'), '# nope\n', 'utf8');
    await git(broken, 'add', '.');
    await git(broken, 'commit', '-q', '-m', 'init');

    const config: HexConfig = {
      sources: [
        { kind: 'catalogue', url: `file://${acme}` },
        { kind: 'catalogue', url: `file://${broken}` },
      ],
      marketplaces: [],
    };
    const { results, warnings } = await searchAllSources(config, '', {
      cacheDir: join(work, 'cache'),
    });
    expect(results.map((e) => e.marketplace)).toEqual(['acme']);
    expect(warnings.some((w) => w.startsWith('catalogue '))).toBe(true);
  });
});

describe('searchAllSources — local filesystem sources (M14.9)', () => {
  it('returns hits from a path: source root even with no marketplaces/catalogues', async () => {
    const root = join(work, 'templates');
    await mkdir(join(root, 'node-ts-cli', '.hex'), { recursive: true });
    await writeFile(
      join(root, 'node-ts-cli', '.hex', 'manifest.yaml'),
      'type: component\nname: node-ts-cli\nversion: 0.2.0\nkind: cli\n',
      'utf8',
    );

    const config: HexConfig = {
      sources: [{ kind: 'path', path: root }],
      marketplaces: [],
    };
    const { results, warnings } = await searchAllSources(config, 'cli', {
      cacheDir: join(work, 'cache'),
    });

    expect(warnings).toEqual([]);
    expect(results.map((e) => `${e.marketplace}/${e.name}`)).toEqual(['local/node-ts-cli']);
  });

  it('unions local hits with marketplace hits (marketplace first)', async () => {
    const root = join(work, 'templates');
    await mkdir(join(root, 'node-ts-cli', '.hex'), { recursive: true });
    await writeFile(
      join(root, 'node-ts-cli', '.hex', 'manifest.yaml'),
      'type: component\nname: node-ts-cli\nversion: 0.2.0\nkind: cli\n',
      'utf8',
    );
    const hex = await buildRegistry('hex', [
      { name: 'api-cli-helper', type: 'component', latest: '1.0.0' },
    ]);

    const config: HexConfig = {
      sources: [{ kind: 'path', path: root }],
      marketplaces: [{ id: 'hex', registry: hex }],
    };
    const { results } = await searchAllSources(config, 'cli', { cacheDir: join(work, 'cache') });

    expect(results.map((e) => `${e.marketplace}/${e.name}`)).toEqual([
      'hex/api-cli-helper',
      'local/node-ts-cli',
    ]);
  });
});

describe('formatSearchTable', () => {
  it('renders qualified-name@version rows with descriptions', () => {
    const out = formatSearchTable([
      {
        marketplace: 'hex',
        name: 'db-postgres',
        type: 'component',
        latest: '2.0.0',
        description: 'Postgres data access',
        categories: [],
      },
    ]);
    expect(out).toContain('hex/db-postgres');
    expect(out).toContain('@2.0.0');
    expect(out).toContain('component');
    expect(out).toContain('Postgres data access');
  });
});
