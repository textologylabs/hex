import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type SigningKeypair,
  generateSigningKeypair,
  packPackage,
} from '../../../src/core/marketplace/package.js';
import {
  type Fetcher,
  MarketplaceSourceError,
  pickVersion,
  resolveMarketplaceSource,
} from '../../../src/core/marketplace/source.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-mkt-test-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Write a minimal valid component bundle at `work/src-<name>-<version>`. */
async function writeBundle(name: string, version: string): Promise<string> {
  const root = join(work, `src-${name}-${version}`);
  await mkdir(join(root, '.hex'), { recursive: true });
  await writeFile(
    join(root, '.hex', 'manifest.yaml'),
    `type: component\nname: ${name}\nversion: ${version}\n`,
    'utf8',
  );
  await writeFile(join(root, 'index.ts'), `export const v = '${version}';\n`, 'utf8');
  return root;
}

/**
 * Build a `file://` registry: pack `name` at each version signed by
 * `keys`, drop the `.hexpkg`s at the registry root, and write the index
 * at `<name>/index.json`. Returns the registry base URL.
 */
async function buildRegistry(
  name: string,
  versions: string[],
  keys: SigningKeypair,
): Promise<string> {
  const registryDir = join(work, 'registry');
  await mkdir(join(registryDir, name), { recursive: true });

  const indexVersions: Array<{ version: string; package: string }> = [];
  for (const version of versions) {
    const bundle = await writeBundle(name, version);
    const pkgName = `${name}-${version}.hexpkg`;
    await packPackage(bundle, join(registryDir, pkgName), { privateKeyPem: keys.privateKeyPem });
    indexVersions.push({ version, package: pkgName });
  }
  await writeFile(
    join(registryDir, name, 'index.json'),
    JSON.stringify({ name, versions: indexVersions }, null, 2),
    'utf8',
  );
  return pathToFileURL(registryDir).href;
}

/** A `file://` fetcher that records every URL it was asked for. */
function countingFetcher(): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    return readFile(fileURLToPath(url));
  };
  return { fetcher, calls };
}

describe('pickVersion — semver resolution', () => {
  const available = ['1.0.0', '1.2.0', '1.2.5', '2.0.0'];

  it('resolves latest / * to the highest version', () => {
    expect(pickVersion(available, 'latest')).toBe('2.0.0');
    expect(pickVersion(available, '*')).toBe('2.0.0');
  });

  it('resolves caret / tilde / exact specs', () => {
    expect(pickVersion(available, '^1.0.0')).toBe('1.2.5');
    expect(pickVersion(available, '~1.2.0')).toBe('1.2.5');
    expect(pickVersion(available, '1.2.0')).toBe('1.2.0');
  });

  it('returns null when nothing satisfies the spec', () => {
    expect(pickVersion(available, '^3.0.0')).toBeNull();
  });
});

describe('resolveMarketplaceSource — fake registry', () => {
  it('resolves a version spec to a verified ComponentBundle', async () => {
    const keys = generateSigningKeypair();
    const registry = await buildRegistry('db-postgres', ['1.0.0', '1.2.0'], keys);

    const result = await resolveMarketplaceSource(
      { registry, name: 'db-postgres', version: '^1.0.0' },
      { cacheDir: join(work, 'cache'), trustedKeys: { [keys.keyId]: keys.publicKeyPem } },
    );

    expect(result.version).toBe('1.2.0');
    expect(result.keyId).toBe(keys.keyId);
    expect(result.bundle.manifest.name).toBe('db-postgres');
    expect(result.bundle.manifest.version).toBe('1.2.0');
    // Remote source → always sandboxed (M7.6 trust gradient).
    expect(result.bundle.sourceKind).toBe('git');
    expect(result.localPath).toBe(result.bundle.rootPath);
  });

  it('defaults to latest when no version spec is given', async () => {
    const keys = generateSigningKeypair();
    const registry = await buildRegistry('api', ['0.9.0', '1.4.0', '1.1.0'], keys);

    const result = await resolveMarketplaceSource(
      { registry, name: 'api' },
      { cacheDir: join(work, 'cache'), trustedKeys: { [keys.keyId]: keys.publicKeyPem } },
    );
    expect(result.version).toBe('1.4.0');
  });

  it('throws when no published version satisfies the spec', async () => {
    const keys = generateSigningKeypair();
    const registry = await buildRegistry('api', ['1.0.0'], keys);

    await expect(
      resolveMarketplaceSource(
        { registry, name: 'api', version: '^2.0.0' },
        { cacheDir: join(work, 'cache'), trustedKeys: { [keys.keyId]: keys.publicKeyPem } },
      ),
    ).rejects.toThrow(/no version of "api" satisfies "\^2\.0\.0"/);
  });

  it('refuses to unpack a package signed by an untrusted key', async () => {
    const keys = generateSigningKeypair();
    const registry = await buildRegistry('api', ['1.0.0'], keys);
    const cacheDir = join(work, 'cache');

    // Trust store holds a different key — verification must fail closed.
    const stranger = generateSigningKeypair();
    await expect(
      resolveMarketplaceSource(
        { registry, name: 'api', version: '1.0.0' },
        { cacheDir, trustedKeys: { [stranger.keyId]: stranger.publicKeyPem } },
      ),
    ).rejects.toThrow(/failed verification: untrusted signing key/);

    // The unverifiable package left nothing behind in the cache.
    const present = await pathExists(join(cacheDir, 'marketplace'));
    if (present) {
      // index.json may be cached, but no extracted artifact/ may exist.
      const result = await resolveMarketplaceSource(
        { registry, name: 'api', version: '1.0.0' },
        { cacheDir, trustedKeys: { [keys.keyId]: keys.publicKeyPem } },
      );
      // A subsequent trusted resolve succeeds — proving the bad attempt
      // did not poison the cache with a half-written package.
      expect(result.version).toBe('1.0.0');
    }
  });

  it('reuses the cache on a warm hit — no network', async () => {
    const keys = generateSigningKeypair();
    const registry = await buildRegistry('api', ['1.0.0', '1.1.0'], keys);
    const cacheDir = join(work, 'cache');
    const trustedKeys = { [keys.keyId]: keys.publicKeyPem };

    const first = countingFetcher();
    await resolveMarketplaceSource(
      { registry, name: 'api', version: '^1.0.0' },
      { cacheDir, trustedKeys, fetcher: first.fetcher },
    );
    // Cold cache fetched the index + the package.
    expect(first.calls.length).toBe(2);

    const second = countingFetcher();
    const result = await resolveMarketplaceSource(
      { registry, name: 'api', version: '^1.0.0' },
      { cacheDir, trustedKeys, fetcher: second.fetcher },
    );
    // Warm cache: zero network.
    expect(second.calls).toEqual([]);
    expect(result.version).toBe('1.1.0');
  });

  it('re-fetches when refresh is set', async () => {
    const keys = generateSigningKeypair();
    const registry = await buildRegistry('api', ['1.0.0'], keys);
    const cacheDir = join(work, 'cache');
    const trustedKeys = { [keys.keyId]: keys.publicKeyPem };

    await resolveMarketplaceSource(
      { registry, name: 'api', version: '1.0.0' },
      { cacheDir, trustedKeys },
    );

    const { fetcher, calls } = countingFetcher();
    await resolveMarketplaceSource(
      { registry, name: 'api', version: '1.0.0' },
      { cacheDir, trustedKeys, refresh: true, fetcher },
    );
    expect(calls.length).toBe(2);
  });

  it('rejects an unreachable registry', async () => {
    const keys = generateSigningKeypair();
    await expect(
      resolveMarketplaceSource(
        { registry: pathToFileURL(join(work, 'no-such-registry')).href, name: 'api' },
        { cacheDir: join(work, 'cache'), trustedKeys: { [keys.keyId]: keys.publicKeyPem } },
      ),
    ).rejects.toThrow(MarketplaceSourceError);
  });
});
