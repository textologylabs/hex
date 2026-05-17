import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Catalogue,
  StoreError,
  addPackage,
  findPackage,
  listCategories,
  packagesInCategory,
  readCatalogue,
  readIndex,
  searchCatalogue,
} from '../../registry/store.js';
import { generateSigningKeypair, packPackage } from '../../src/core/marketplace/package.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-store-test-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** Pack a minimal signed `.hexpkg` and return its path. */
async function makePackage(name: string, version: string): Promise<string> {
  const bundle = join(work, `src-${name}-${version}`);
  await mkdir(join(bundle, '.hex'), { recursive: true });
  await writeFile(
    join(bundle, '.hex', 'manifest.yaml'),
    `type: component\nname: ${name}\nversion: ${version}\n`,
    'utf8',
  );
  await writeFile(join(bundle, 'index.ts'), `export const v = '${version}';\n`, 'utf8');
  const out = join(work, `${name}-${version}.hexpkg`);
  await packPackage(bundle, out, { privateKeyPem: generateSigningKeypair().privateKeyPem });
  return out;
}

describe('store — addPackage', () => {
  it('ingests a package and regenerates index + catalogue', async () => {
    const store = join(work, 'store');
    await addPackage({
      rootDir: store,
      signedPackagePath: await makePackage('db-postgres', '1.0.0'),
      name: 'db-postgres',
      version: '1.0.0',
      type: 'component',
      kind: 'db',
      description: 'Postgres access',
      categories: ['database'],
    });

    const index = await readIndex(store, 'db-postgres');
    expect(index?.versions).toEqual([
      { version: '1.0.0', package: 'packages/db-postgres-1.0.0.hexpkg' },
    ]);
    const catalogue = await readCatalogue(store);
    expect(catalogue.packages).toEqual([
      {
        name: 'db-postgres',
        type: 'component',
        kind: 'db',
        latest: '1.0.0',
        description: 'Postgres access',
        categories: ['database'],
      },
    ]);
  });

  it('recomputes latest as more versions land, newest-first in the index', async () => {
    const store = join(work, 'store');
    const common = { rootDir: store, name: 'api', type: 'component' as const };
    await addPackage({
      ...common,
      signedPackagePath: await makePackage('api', '1.0.0'),
      version: '1.0.0',
    });
    await addPackage({
      ...common,
      signedPackagePath: await makePackage('api', '2.1.0'),
      version: '2.1.0',
    });
    await addPackage({
      ...common,
      signedPackagePath: await makePackage('api', '1.5.0'),
      version: '1.5.0',
    });

    const index = await readIndex(store, 'api');
    expect(index?.versions.map((v) => v.version)).toEqual(['2.1.0', '1.5.0', '1.0.0']);
    const catalogue = await readCatalogue(store);
    expect(catalogue.packages[0]?.latest).toBe('2.1.0');
  });

  it('rejects republishing an existing version', async () => {
    const store = join(work, 'store');
    const common = { rootDir: store, name: 'api', type: 'component' as const, version: '1.0.0' };
    await addPackage({ ...common, signedPackagePath: await makePackage('api', '1.0.0') });
    await expect(
      addPackage({ ...common, signedPackagePath: await makePackage('api', '1.0.0') }),
    ).rejects.toThrow(StoreError);
  });
});

describe('store — catalogue queries', () => {
  const catalogue: Catalogue = {
    packages: [
      { name: 'api-express', type: 'component', latest: '1.0.0', categories: ['backend'] },
      {
        name: 'db-postgres',
        type: 'component',
        latest: '2.0.0',
        description: 'Postgres',
        categories: ['backend', 'database'],
      },
      { name: 'ui-kit', type: 'component', latest: '3.0.0', categories: ['frontend'] },
    ],
  };

  it('searchCatalogue matches name, description, category', () => {
    expect(searchCatalogue(catalogue, 'postgres').map((p) => p.name)).toEqual(['db-postgres']);
    expect(
      searchCatalogue(catalogue, 'backend')
        .map((p) => p.name)
        .sort(),
    ).toEqual(['api-express', 'db-postgres']);
    expect(searchCatalogue(catalogue, '')).toHaveLength(3);
  });

  it('listCategories tallies and sorts', () => {
    expect(listCategories(catalogue)).toEqual([
      { name: 'backend', count: 2 },
      { name: 'database', count: 1 },
      { name: 'frontend', count: 1 },
    ]);
  });

  it('packagesInCategory + findPackage', () => {
    expect(packagesInCategory(catalogue, 'frontend').map((p) => p.name)).toEqual(['ui-kit']);
    expect(findPackage(catalogue, 'db-postgres')?.latest).toBe('2.0.0');
    expect(findPackage(catalogue, 'missing')).toBeUndefined();
  });
});
