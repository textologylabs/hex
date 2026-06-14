import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectPackageInfo, formatPackageInfo } from '../../src/commands/hive.js';
import type { HexConfig } from '../../src/core/config/types.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-hive-test-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/**
 * Build a `file://` fake registry with a `catalogue.json` plus a
 * per-package `index.json` for every package — the shape
 * `createMarketplaceCatalogue.listVersions` reads.
 */
async function buildRegistry(
  dirName: string,
  packages: Array<{ name: string; versions: string[] }>,
): Promise<string> {
  const registryDir = join(work, dirName);
  await mkdir(registryDir, { recursive: true });
  await writeFile(
    join(registryDir, 'catalogue.json'),
    JSON.stringify(
      {
        packages: packages.map((p) => ({ name: p.name, type: 'component', latest: p.versions[0] })),
      },
      null,
      2,
    ),
    'utf8',
  );
  for (const p of packages) {
    await mkdir(join(registryDir, p.name), { recursive: true });
    await writeFile(
      join(registryDir, p.name, 'index.json'),
      JSON.stringify(
        {
          name: p.name,
          versions: p.versions.map((v) => ({ version: v, package: `${p.name}-${v}.hexpkg` })),
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  return pathToFileURL(registryDir).href;
}

describe('collectPackageInfo', () => {
  it('lists a marketplace package’s versions, newest first, with its source', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api', versions: ['1.0.0', '1.2.0', '1.1.0'] },
    ]);
    const config: HexConfig = { sources: [], marketplaces: [{ id: 'hex', registry: hex }] };

    const result = await collectPackageInfo(config, 'api');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.qualified).toBe('hex/api');
    expect(result.hits[0]?.versions).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(result.hits[0]?.source).toContain('marketplace');
  });

  it('a qualified address restricts the lookup to that namespace', async () => {
    const hex = await buildRegistry('hex', [{ name: 'api', versions: ['1.0.0'] }]);
    const acme = await buildRegistry('acme', [{ name: 'api', versions: ['9.0.0'] }]);
    const config: HexConfig = {
      sources: [],
      marketplaces: [
        { id: 'hex', registry: hex },
        { id: 'acme', registry: acme },
      ],
    };

    const result = await collectPackageInfo(config, 'acme/api');
    expect(result.hits.map((h) => h.qualified)).toEqual(['acme/api']);
    expect(result.hits[0]?.versions).toEqual(['9.0.0']);
  });

  it('returns no hits for an unknown package', async () => {
    const hex = await buildRegistry('hex', [{ name: 'api', versions: ['1.0.0'] }]);
    const config: HexConfig = { sources: [], marketplaces: [{ id: 'hex', registry: hex }] };

    const result = await collectPackageInfo(config, 'nope');
    expect(result.hits).toEqual([]);
  });
});

describe('formatPackageInfo', () => {
  it('renders qualified name, source, and versions for each hit', () => {
    const out = formatPackageInfo({
      package: 'api',
      hits: [
        {
          qualified: 'hex/api',
          source: 'marketplace https://reg.test/',
          versions: ['2.0.0', '1.0.0'],
        },
      ],
      warnings: [],
    });
    expect(out).toContain('hex/api');
    expect(out).toContain('marketplace https://reg.test/');
    expect(out).toContain('2.0.0, 1.0.0');
  });

  it('renders a not-found message when there are no hits', () => {
    const out = formatPackageInfo({ package: 'ghost', hits: [], warnings: [] });
    expect(out).toContain('No package "ghost"');
    expect(out).toContain('hex list');
  });
});
