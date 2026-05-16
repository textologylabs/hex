import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAggregateCatalogue } from '../../../src/core/catalogue/aggregate.js';
import type { MarketplaceConfig } from '../../../src/core/marketplace/address.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-agg-test-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

type CataloguePkg = {
  name: string;
  type: 'component' | 'recipe';
  kind?: string;
  latest: string;
  description?: string;
  categories?: string[];
};

/** Build a `file://` registry `dirName` with a catalogue + per-package indexes. */
async function buildRegistry(
  dirName: string,
  packages: CataloguePkg[],
  indexes: Record<string, string[]> = {},
): Promise<string> {
  const registryDir = join(work, dirName);
  await mkdir(registryDir, { recursive: true });
  await writeFile(
    join(registryDir, 'catalogue.json'),
    JSON.stringify({ packages }, null, 2),
    'utf8',
  );
  for (const [name, versions] of Object.entries(indexes)) {
    await mkdir(join(registryDir, name), { recursive: true });
    await writeFile(
      join(registryDir, name, 'index.json'),
      JSON.stringify(
        { name, versions: versions.map((v) => ({ version: v, package: `${name}-${v}.hexpkg` })) },
        null,
        2,
      ),
      'utf8',
    );
  }
  return pathToFileURL(registryDir).href;
}

describe('createAggregateCatalogue — search', () => {
  it('unions results across marketplaces, each tagged with its origin', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api-express', type: 'component', kind: 'api', latest: '1.0.0' },
    ]);
    const acme = await buildRegistry('acme', [
      { name: 'acme-ui', type: 'component', kind: 'ui', latest: '3.0.0' },
    ]);
    const cat = createAggregateCatalogue([
      { id: 'hex', registry: hex },
      { id: 'acme', registry: acme },
    ]);

    const { entries, warnings } = await cat.search('');
    expect(warnings).toEqual([]);
    expect(entries.map((e) => `${e.marketplace}/${e.name}`)).toEqual([
      'hex/api-express',
      'acme/acme-ui',
    ]);
  });

  it('surfaces a name clash as two distinct qualified entries', async () => {
    // Same package name published in two marketplaces.
    const hex = await buildRegistry('hex', [
      { name: 'db-postgres', type: 'component', kind: 'db', latest: '2.0.0' },
    ]);
    const acme = await buildRegistry('acme', [
      { name: 'db-postgres', type: 'component', kind: 'db', latest: '9.0.0' },
    ]);
    const cat = createAggregateCatalogue([
      { id: 'hex', registry: hex },
      { id: 'acme', registry: acme },
    ]);

    const { entries } = await cat.search('db-postgres');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => ({ marketplace: e.marketplace, latest: e.latest }))).toEqual([
      { marketplace: 'hex', latest: '2.0.0' },
      { marketplace: 'acme', latest: '9.0.0' },
    ]);
  });

  it('keeps answering when one marketplace is unreachable', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api-express', type: 'component', latest: '1.0.0' },
    ]);
    const dead = pathToFileURL(join(work, 'no-such-registry')).href;
    const cat = createAggregateCatalogue([
      { id: 'hex', registry: hex },
      { id: 'dead', registry: dead },
    ]);

    const { entries, warnings } = await cat.search('api');
    expect(entries.map((e) => e.marketplace)).toEqual(['hex']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^dead: /);
  });
});

describe('createAggregateCatalogue — browse', () => {
  it('unions category results across marketplaces', async () => {
    const hex = await buildRegistry('hex', [
      { name: 'api-express', type: 'component', latest: '1.0.0', categories: ['backend'] },
    ]);
    const acme = await buildRegistry('acme', [
      { name: 'acme-api', type: 'component', latest: '2.0.0', categories: ['backend'] },
      { name: 'acme-ui', type: 'component', latest: '2.0.0', categories: ['frontend'] },
    ]);
    const cat = createAggregateCatalogue([
      { id: 'hex', registry: hex },
      { id: 'acme', registry: acme },
    ]);

    const { entries } = await cat.browse('backend');
    expect(entries.map((e) => `${e.marketplace}/${e.name}`)).toEqual([
      'hex/api-express',
      'acme/acme-api',
    ]);
  });
});

describe('createAggregateCatalogue — listVersions', () => {
  const SAMPLE: CataloguePkg[] = [{ name: 'db-postgres', type: 'component', latest: '1.0.0' }];

  it('returns versions from the first marketplace (declared order) that has the package', async () => {
    const hex = await buildRegistry('hex', SAMPLE, { 'db-postgres': ['1.0.0', '1.5.0'] });
    const acme = await buildRegistry('acme', SAMPLE, { 'db-postgres': ['9.0.0'] });
    const marketplaces: MarketplaceConfig[] = [
      { id: 'hex', registry: hex },
      { id: 'acme', registry: acme },
    ];

    const result = await createAggregateCatalogue(marketplaces).listVersions('db-postgres');
    expect(result).toEqual({ marketplace: 'hex', versions: ['1.5.0', '1.0.0'] });
  });

  it('falls through to a later marketplace when earlier ones lack the package', async () => {
    const hex = await buildRegistry('hex', SAMPLE, { 'api-express': ['1.0.0'] });
    const acme = await buildRegistry('acme', SAMPLE, { 'db-postgres': ['3.0.0'] });

    const result = await createAggregateCatalogue([
      { id: 'hex', registry: hex },
      { id: 'acme', registry: acme },
    ]).listVersions('db-postgres');
    expect(result).toEqual({ marketplace: 'acme', versions: ['3.0.0'] });
  });

  it('returns null when no marketplace publishes the package', async () => {
    const hex = await buildRegistry('hex', SAMPLE, { 'api-express': ['1.0.0'] });
    const result = await createAggregateCatalogue([{ id: 'hex', registry: hex }]).listVersions(
      'db-postgres',
    );
    expect(result).toBeNull();
  });
});
