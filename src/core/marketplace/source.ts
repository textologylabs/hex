import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from 'tar';
import { z } from 'zod';
import { versionSatisfies } from '../recipe/contracts.js';
import { type ComponentBundle, loadFromPath } from '../sources/file-source.js';
import { getDefaultCacheDir } from '../sources/git-source.js';
import { type TrustedKeys, verifyPackage } from './package.js';

/**
 * `MarketplaceSource` — the third `Source` implementation (M9.2),
 * alongside `FileSource` and `GitSource`. Given a registry URL, a name,
 * and a version spec, it resolves the matching `hexpkg` package, verifies
 * its signature, unpacks it into the shared `~/.hex/cache/`, and hands
 * back a `ComponentBundle` the rest of the pipeline consumes unchanged.
 *
 * Registry wire shape (HTTP or `file://`):
 *
 *   <registry>/<name>/index.json   →  { name, versions: [{version, package}] }
 *   <registry>/<package-url>       →  the `.hexpkg` archive bytes
 *
 * `package` URLs resolve against the registry root, so a registry can
 * serve packages from a CDN by giving absolute URLs, or keep them
 * relative for a self-contained static-file registry.
 *
 * Caching mirrors `GitSource`: the index and every unpacked package are
 * cached under `~/.hex/cache/marketplace/`, and a warm cache means zero
 * network — `refresh` forces a re-fetch of both. Signature verification
 * always gates the unpack: an unverifiable package never lands in the
 * cache. See `docs/marketplace-package-format.md`.
 */

export class MarketplaceSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketplaceSourceError';
  }
}

/** A marketplace coordinate: which registry, which package, which versions. */
export type MarketplaceEntry = {
  /** Registry base URL — `https://…/` or `file://…/`. */
  registry: string;
  /** Package name. */
  name: string;
  /** Semver spec (`^1.2.0`, `~1.2`, `1.2.3`, `*`, `latest`). Defaults to `latest`. */
  version?: string;
};

/** Fetches the bytes at a URL. Injectable so tests need no live server. */
export type Fetcher = (url: string) => Promise<Buffer>;

export type MarketplaceResolveOpts = {
  /** Override the cache root. Defaults to `HEX_CACHE_DIR` or `~/.hex/cache`. */
  cacheDir?: string;
  /** Re-fetch the index and package even on a warm cache. */
  refresh?: boolean;
  /** keyId → SPKI public-key PEM. Verification fails closed if a key is absent. */
  trustedKeys: TrustedKeys;
  /** Override the URL fetcher (test injection). */
  fetcher?: Fetcher;
};

export type MarketplaceResolveResult = {
  /** The loaded bundle — `sourceKind: 'git'` (remote → always sandboxed). */
  bundle: ComponentBundle;
  registry: string;
  name: string;
  /** Concrete version selected from the index. */
  version: string;
  /** Signing key the package verified against. */
  keyId: string;
  /** Cached artifact directory — the bundle's `rootPath`. */
  localPath: string;
  /** When the package was fetched + unpacked (ISO 8601). */
  fetchedAt: string;
};

const registryIndexSchema = z.object({
  name: z.string().min(1),
  versions: z
    .array(
      z.object({
        version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/, 'index version must be semver'),
        /** URL of the `.hexpkg`, absolute or relative to the registry root. */
        package: z.string().min(1),
      }),
    )
    .min(1),
});

type RegistryIndex = z.infer<typeof registryIndexSchema>;

const META_FILENAME = '.hex-pkg-meta.json';
const INDEX_FILENAME = 'index.json';
const ARTIFACT_SUBDIR = 'artifact';

export type MarketplaceMeta = {
  registry: string;
  name: string;
  version: string;
  digest: string;
  keyId: string;
  fetchedAt: string;
};

function shortHash(input: string, len: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

function slug(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Compare two semver versions by their numeric triplet (prerelease ignored). */
function compareVersions(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const ai = Number(pa[i]);
    const bi = Number(pb[i]);
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

/**
 * Pick the highest indexed version satisfying `spec`. `latest` and `*`
 * both mean "the highest version available". Returns `null` when nothing
 * matches.
 */
export function pickVersion(available: string[], spec: string): string | null {
  const normalised = spec === 'latest' ? '*' : spec;
  const matching = available.filter((v) => versionSatisfies(v, normalised));
  if (matching.length === 0) return null;
  return matching.sort((a, b) => compareVersions(b, a))[0] ?? null;
}

/** Default fetcher: `file://` reads from disk, `http(s)://` uses `fetch`. */
const defaultFetcher: Fetcher = async (url) => {
  if (url.startsWith('file:')) {
    try {
      return await readFile(fileURLToPath(url));
    } catch (err) {
      throw new MarketplaceSourceError(
        `cannot read ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new MarketplaceSourceError(
      `cannot fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new MarketplaceSourceError(`fetch ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
};

function registryBase(registry: string): string {
  return registry.endsWith('/') ? registry : `${registry}/`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Read + schema-validate a registry index, fetching only when needed. */
async function loadIndex(
  entry: MarketplaceEntry,
  cacheRoot: string,
  fetcher: Fetcher,
  refresh: boolean,
): Promise<RegistryIndex> {
  const cachedPath = join(cacheRoot, INDEX_FILENAME);

  if (!refresh && (await pathExists(cachedPath))) {
    const parsed = registryIndexSchema.safeParse(JSON.parse(await readFile(cachedPath, 'utf8')));
    if (parsed.success) return parsed.data;
    // A corrupt cached index falls through to a re-fetch rather than failing.
  }

  const url = new URL(
    `${encodeURIComponent(entry.name)}/${INDEX_FILENAME}`,
    registryBase(entry.registry),
  );
  const raw = await fetcher(url.href);

  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new MarketplaceSourceError(
      `registry index for "${entry.name}" is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const parsed = registryIndexSchema.safeParse(json);
  if (!parsed.success) {
    throw new MarketplaceSourceError(
      `registry index for "${entry.name}" failed validation: ${parsed.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    );
  }

  await mkdir(cacheRoot, { recursive: true });
  await writeFile(cachedPath, JSON.stringify(parsed.data, null, 2), 'utf8');
  return parsed.data;
}

/**
 * Resolve a marketplace coordinate into a verified, unpacked
 * `ComponentBundle`.
 *
 * Flow: load the index (cached unless `refresh`) → pick the highest
 * version satisfying the spec → on a cache miss, download the `.hexpkg`,
 * verify its signature against `trustedKeys`, and only then unpack it
 * into the cache. A failed verification throws and leaves the cache
 * untouched.
 */
export async function resolveMarketplaceSource(
  entry: MarketplaceEntry,
  opts: MarketplaceResolveOpts,
): Promise<MarketplaceResolveResult> {
  const baseDir = opts.cacheDir ?? getDefaultCacheDir();
  const fetcher = opts.fetcher ?? defaultFetcher;
  const refresh = opts.refresh ?? false;
  const spec = entry.version ?? 'latest';

  const cacheRoot = join(baseDir, 'marketplace', shortHash(entry.registry, 16), slug(entry.name));

  const index = await loadIndex(entry, cacheRoot, fetcher, refresh);
  const version = pickVersion(
    index.versions.map((v) => v.version),
    spec,
  );
  if (!version) {
    throw new MarketplaceSourceError(
      `no version of "${entry.name}" satisfies "${spec}" (registry has: ${index.versions
        .map((v) => v.version)
        .join(', ')})`,
    );
  }
  const indexEntry = index.versions.find((v) => v.version === version);
  if (!indexEntry) {
    throw new MarketplaceSourceError(`internal: index entry for ${version} vanished`);
  }

  const versionDir = join(cacheRoot, slug(version));
  const artifactDir = join(versionDir, ARTIFACT_SUBDIR);
  const metaPath = join(versionDir, META_FILENAME);

  // Warm cache: a previously verified+unpacked package is reused verbatim.
  if (!refresh && (await pathExists(metaPath)) && (await pathExists(artifactDir))) {
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as MarketplaceMeta;
    const bundle = await loadFromPath(artifactDir, 'git');
    return {
      bundle,
      registry: entry.registry,
      name: entry.name,
      version,
      keyId: meta.keyId,
      localPath: artifactDir,
      fetchedAt: meta.fetchedAt,
    };
  }

  // Cache miss → download the package to a temp file.
  const packageUrl = new URL(indexEntry.package, registryBase(entry.registry)).href;
  const packageBytes = await fetcher(packageUrl);

  const downloadDir = await mkdtemp(join(tmpdir(), 'hex-mkt-'));
  const tmpPackage = join(downloadDir, 'package.hexpkg');
  try {
    await writeFile(tmpPackage, packageBytes);

    // Verification gates the unpack — an unverifiable package never
    // reaches the cache.
    const verified = await verifyPackage(tmpPackage, opts.trustedKeys);
    if (!verified.ok) {
      throw new MarketplaceSourceError(
        `package "${entry.name}@${version}" failed verification: ${verified.reason}`,
      );
    }
    if (verified.manifest.name !== entry.name || verified.manifest.version !== version) {
      throw new MarketplaceSourceError(
        `package contents (${verified.manifest.name}@${verified.manifest.version}) do not match the index entry (${entry.name}@${version})`,
      );
    }

    // Atomic-ish unpack: extract into a sibling temp dir, then swap in.
    await rm(versionDir, { recursive: true, force: true });
    await mkdir(versionDir, { recursive: true });
    await extract({ file: tmpPackage, cwd: versionDir });

    const fetchedAt = new Date().toISOString();
    const meta: MarketplaceMeta = {
      registry: entry.registry,
      name: entry.name,
      version,
      digest: verified.manifest.digest,
      keyId: verified.keyId,
      fetchedAt,
    };
    await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

    const bundle = await loadFromPath(artifactDir, 'git');
    return {
      bundle,
      registry: entry.registry,
      name: entry.name,
      version,
      keyId: verified.keyId,
      localPath: artifactDir,
      fetchedAt,
    };
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}
