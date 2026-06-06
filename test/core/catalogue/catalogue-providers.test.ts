import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import {
  browseCatalogueProviders,
  loadCatalogueProviders,
  searchCatalogueProviders,
} from '../../../src/core/catalogue/catalogue-providers.js';
import type { HexConfig } from '../../../src/core/config/types.js';
import type { MarketplaceYaml } from '../../../src/core/marketplace/catalogue-schema.js';

const execFileAsync = promisify(execFile);

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-cat-providers-'));
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

async function makeCatalogueRepo(name: string, yaml: MarketplaceYaml): Promise<string> {
  const upstream = join(work, name);
  await mkdir(upstream, { recursive: true });
  await git(upstream, 'init', '-q', '-b', 'main');
  await writeFile(join(upstream, 'marketplace.yaml'), stringifyYaml(yaml), 'utf8');
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-q', '-m', 'init');
  return upstream;
}

function configFor(urls: string[]): HexConfig {
  return {
    sources: urls.map((url) => ({ kind: 'catalogue', url })),
    marketplaces: [],
  };
}

const stubVersion = (tag: string) => ({ tag, source: { git: 'https://example.test/pkg.git' } });

describe('loadCatalogueProviders', () => {
  it('returns one provider per catalogue source, tagged with namespace', async () => {
    const acme = await makeCatalogueRepo('acme', {
      namespace: 'acme',
      packages: [
        { name: 'web', categories: ['frontend'], versions: [stubVersion('1.0.0')] },
        { name: 'api', categories: ['backend'], versions: [stubVersion('2.0.0')] },
      ],
    });
    const widget = await makeCatalogueRepo('widget', {
      namespace: 'widget',
      packages: [{ name: 'sso', categories: ['auth'], versions: [stubVersion('1.0.0')] }],
    });

    const { providers, warnings } = await loadCatalogueProviders(
      configFor([fileUrl(acme), fileUrl(widget)]),
      { cacheDir: join(work, 'cache') },
    );

    expect(warnings).toEqual([]);
    expect(providers.map((p) => p.id)).toEqual(['acme', 'widget']);
    expect(providers[0]?.display).toBe(fileUrl(acme));
  });

  it('warns and skips a catalogue whose marketplace.yaml is missing', async () => {
    const ok = await makeCatalogueRepo('ok', {
      namespace: 'ok',
      packages: [{ name: 'p', versions: [stubVersion('1.0.0')] }],
    });
    const broken = join(work, 'broken');
    await mkdir(broken, { recursive: true });
    await git(broken, 'init', '-q', '-b', 'main');
    await writeFile(join(broken, 'README.md'), '# not a catalogue\n', 'utf8');
    await git(broken, 'add', '.');
    await git(broken, 'commit', '-q', '-m', 'init');

    const { providers, warnings } = await loadCatalogueProviders(
      configFor([fileUrl(ok), fileUrl(broken)]),
      { cacheDir: join(work, 'cache') },
    );

    expect(providers.map((p) => p.id)).toEqual(['ok']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('marketplace.yaml');
  });

  it('ignores non-catalogue sources', async () => {
    const config: HexConfig = {
      sources: [
        { kind: 'path', path: '/tmp/no-such-dir' },
        { kind: 'git', url: 'https://example.test/some-templates.git' },
      ],
      marketplaces: [],
    };
    const { providers, warnings } = await loadCatalogueProviders(config, {
      cacheDir: join(work, 'cache'),
    });
    expect(providers).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('searchCatalogueProviders', () => {
  it('aggregates hits across providers, tagged with namespace', async () => {
    const acme = await makeCatalogueRepo('acme', {
      namespace: 'acme',
      packages: [
        {
          name: 'web',
          description: 'frontend shell',
          categories: ['frontend'],
          versions: [stubVersion('1.0.0')],
        },
        {
          name: 'api',
          description: 'express api',
          categories: ['backend'],
          versions: [stubVersion('2.0.0')],
        },
        {
          name: 'db-postgres',
          description: 'postgres driver',
          categories: ['backend', 'database'],
          versions: [stubVersion('1.0.0')],
        },
      ],
    });

    const { providers } = await loadCatalogueProviders(configFor([fileUrl(acme)]), {
      cacheDir: join(work, 'cache'),
    });

    const { entries: all } = await searchCatalogueProviders(providers, '');
    expect(all.map((e) => `${e.marketplace}/${e.name}`)).toEqual([
      'acme/web',
      'acme/api',
      'acme/db-postgres',
    ]);

    const { entries: backend } = await searchCatalogueProviders(providers, 'express');
    expect(backend.map((e) => e.name)).toEqual(['api']);
  });

  it('honours per-catalogue block policy — blocked entries are absent', async () => {
    const acme = await makeCatalogueRepo('acme', {
      namespace: 'acme',
      packages: [
        { name: 'safe', versions: [stubVersion('1.0.0')] },
        { name: 'banned', versions: [stubVersion('1.0.0')] },
      ],
      blocks: ['acme/banned'],
    });
    const { providers } = await loadCatalogueProviders(configFor([fileUrl(acme)]), {
      cacheDir: join(work, 'cache'),
    });

    const { entries } = await searchCatalogueProviders(providers, '');
    expect(entries.map((e) => e.name)).toEqual(['safe']);
  });
});

describe('browseCatalogueProviders', () => {
  it('returns entries filed under the requested category across providers', async () => {
    const acme = await makeCatalogueRepo('acme', {
      namespace: 'acme',
      packages: [
        { name: 'api', categories: ['backend'], versions: [stubVersion('1.0.0')] },
        { name: 'web', categories: ['frontend'], versions: [stubVersion('1.0.0')] },
      ],
    });
    const widget = await makeCatalogueRepo('widget', {
      namespace: 'widget',
      packages: [{ name: 'queue', categories: ['backend'], versions: [stubVersion('1.0.0')] }],
    });

    const { providers } = await loadCatalogueProviders(
      configFor([fileUrl(acme), fileUrl(widget)]),
      { cacheDir: join(work, 'cache') },
    );
    const { entries } = await browseCatalogueProviders(providers, 'backend');
    expect(entries.map((e) => `${e.marketplace}/${e.name}`)).toEqual(['acme/api', 'widget/queue']);
  });
});
