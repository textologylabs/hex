import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareVersions } from '../src/core/marketplace/source.js';

/**
 * The registry's on-disk store (M9.9). The public `hex` marketplace is
 * a directory tree of exactly the static files `MarketplaceSource`
 * (M9.2) and the `Catalogue` (M9.3) already fetch:
 *
 *   <root>/catalogue.json              — every package, for search/browse
 *   <root>/<name>/index.json           — a package's published versions
 *   <root>/packages/<name>-<ver>.hexpkg — the signed package archives
 *
 * The HTTP server serves this tree verbatim on the read side; `publish`
 * is the only writer, and it goes through `addPackage` here so the
 * catalogue and index files are regenerated atomically-enough for a
 * single-process server (the server serialises publishes).
 */

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

/** Sub-directory (under the store root) holding the `.hexpkg` archives. */
export const PACKAGES_DIR = 'packages';
/** The registry-wide catalogue file name. */
export const CATALOGUE_FILE = 'catalogue.json';
/** Per-package version index file name. */
export const INDEX_FILE = 'index.json';

/** One published version in a package's `index.json`. */
export type IndexEntry = {
  version: string;
  /** Store-root-relative URL of the `.hexpkg`. */
  package: string;
};

/** A package's `index.json`. */
export type RegistryIndex = {
  name: string;
  versions: IndexEntry[];
};

/** One package row in `catalogue.json`. */
export type CataloguePackage = {
  name: string;
  type: 'component' | 'recipe';
  kind?: string;
  /** Highest published version. */
  latest: string;
  description?: string;
  categories: string[];
};

/** The registry-wide `catalogue.json`. */
export type Catalogue = {
  packages: CataloguePackage[];
};

/** The `.hexpkg` file name for a `(name, version)` pair. */
export function packageFileName(name: string, version: string): string {
  return `${name}-${version}.hexpkg`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Read the registry catalogue; an absent file reads as empty. */
export async function readCatalogue(rootDir: string): Promise<Catalogue> {
  return (await readJson<Catalogue>(join(rootDir, CATALOGUE_FILE))) ?? { packages: [] };
}

/** Read a package's version index, or `null` when the package is unknown. */
export async function readIndex(rootDir: string, name: string): Promise<RegistryIndex | null> {
  return readJson<RegistryIndex>(join(rootDir, name, INDEX_FILE));
}

/** Highest version in a list, by semver triplet. */
function highestVersion(versions: string[]): string {
  return [...versions].sort((a, b) => compareVersions(b, a))[0] ?? '';
}

/** What `addPackage` needs to ingest one published version. */
export type AddPackageInput = {
  rootDir: string;
  /** Path to the signed `.hexpkg` to ingest. */
  signedPackagePath: string;
  name: string;
  version: string;
  type: 'component' | 'recipe';
  kind?: string;
  description?: string;
  categories?: string[];
};

/**
 * Ingest one signed package into the store: copy the archive into
 * `packages/`, append the version to the package's `index.json`, and
 * upsert its row in `catalogue.json` (with `latest` recomputed). A
 * version that is already published is rejected — published archives
 * are immutable.
 */
export async function addPackage(input: AddPackageInput): Promise<void> {
  const { rootDir, name, version, type } = input;

  const index = (await readIndex(rootDir, name)) ?? { name, versions: [] };
  if (index.versions.some((v) => v.version === version)) {
    throw new StoreError(`${name}@${version} is already published — versions are immutable`);
  }

  // Copy the archive into the store.
  const fileName = packageFileName(name, version);
  const packagesDir = join(rootDir, PACKAGES_DIR);
  await mkdir(packagesDir, { recursive: true });
  await copyFile(input.signedPackagePath, join(packagesDir, fileName));

  // Append to the version index, newest first.
  index.versions.push({ version, package: `${PACKAGES_DIR}/${fileName}` });
  index.versions.sort((a, b) => compareVersions(b.version, a.version));
  await writeJson(join(rootDir, name, INDEX_FILE), index);

  // Upsert the catalogue row.
  const catalogue = await readCatalogue(rootDir);
  const latest = highestVersion(index.versions.map((v) => v.version));
  const row: CataloguePackage = {
    name,
    type,
    kind: input.kind,
    latest,
    description: input.description,
    categories: input.categories ?? [],
  };
  const existing = catalogue.packages.findIndex((p) => p.name === name);
  if (existing === -1) {
    catalogue.packages.push(row);
  } else {
    catalogue.packages[existing] = row;
  }
  catalogue.packages.sort((a, b) => (a.name < b.name ? -1 : 1));
  await writeJson(join(rootDir, CATALOGUE_FILE), catalogue);
}

// ── pure catalogue queries (used by the website) ──────────────────────

/** Case-insensitive substring search over name + description + categories. */
export function searchCatalogue(catalogue: Catalogue, query: string): CataloguePackage[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...catalogue.packages];
  return catalogue.packages.filter((p) => {
    const haystack = [p.name, p.description ?? '', ...p.categories].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

/** Distinct categories with counts, alphabetical. */
export function listCategories(catalogue: Catalogue): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const p of catalogue.packages) {
    for (const c of p.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Packages filed under a category. */
export function packagesInCategory(catalogue: Catalogue, category: string): CataloguePackage[] {
  const wanted = category.trim().toLowerCase();
  return catalogue.packages.filter((p) => p.categories.some((c) => c.toLowerCase() === wanted));
}

/** Look up one package by name. */
export function findPackage(catalogue: Catalogue, name: string): CataloguePackage | undefined {
  return catalogue.packages.find((p) => p.name === name);
}
