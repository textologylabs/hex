import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Catalogue, CatalogueEntry } from '../catalogue/types.js';
import { CatalogueError } from '../catalogue/types.js';
import { versionSatisfies } from '../recipe/contracts.js';
import { type ComponentBundle, loadFromPath } from '../sources/file-source.js';
import {
  type ResolveOpts as GitResolveOpts,
  type GitResolveResult,
  resolveGitSource,
} from '../sources/git-source.js';
import {
  MARKETPLACE_YAML_FILENAME,
  type MarketplaceYaml,
  marketplaceYamlSchema,
} from './catalogue-schema.js';
import { compareVersions, pickVersion } from './source.js';

/**
 * `CatalogueSource` — the git-catalogue variant (M13.1) of the
 * marketplace abstraction. A catalogue is a git repo whose root carries
 * a `marketplace.yaml` (see `catalogue-schema.ts`); this module clones
 * the catalogue via `GitSource`, validates the yaml, and exposes the
 * cataloged packages through the same `Catalogue` discovery interface
 * (`search` / `browse` / `listVersions`) as the hosted-registry
 * `MarketplaceSource`. Resolving a specific package version delegates
 * to `GitSource` again — once for the catalogue repo, once for the
 * package's own source. Two layers, same primitives.
 *
 * Block + override policy travels inside the catalogue (per M9.6 model)
 * and is surfaced via `extractCataloguePolicy` for the aggregation
 * layer (M13.3+).
 */

export class CatalogueSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueSourceError';
  }
}

/** A catalogue's git coordinate. */
export type CatalogueSourceEntry = {
  /** Git URL hosting the catalogue repo. */
  url: string;
  /** Optional ref (branch / tag / SHA). */
  ref?: string;
};

export type LoadCatalogueOpts = {
  /** Override the shared cache root. */
  cacheDir?: string;
  /** Force the catalogue repo to be re-fetched. */
  refresh?: boolean;
};

export type LoadedCatalogue = {
  /** The validated catalogue document. */
  yaml: MarketplaceYaml;
  /** Filesystem path where the catalogue repo was cloned. */
  rootPath: string;
  /** Path of the validated `marketplace.yaml` file. */
  yamlPath: string;
  /** Git coordinate the catalogue was fetched from. */
  source: { url: string; ref?: string; sha: string };
};

/**
 * Clone (or reuse the cached clone of) the catalogue repo, read its
 * `marketplace.yaml`, validate against the schema, and return the loaded
 * document. Throws `CatalogueSourceError` on any failure with a single
 * clear message; never leaves a partial cache behind (`resolveGitSource`
 * handles that for us).
 */
export async function loadCatalogue(
  entry: CatalogueSourceEntry,
  opts: LoadCatalogueOpts = {},
): Promise<LoadedCatalogue> {
  const gitOpts: GitResolveOpts = {};
  if (opts.cacheDir !== undefined) gitOpts.cacheDir = opts.cacheDir;
  if (opts.refresh !== undefined) gitOpts.refresh = opts.refresh;

  let gitResult: GitResolveResult;
  try {
    gitResult = await resolveGitSource({ url: entry.url, ref: entry.ref }, gitOpts);
  } catch (err) {
    throw new CatalogueSourceError(
      `cannot fetch catalogue ${entry.url}${entry.ref ? `@${entry.ref}` : ''}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const yamlPath = join(gitResult.localPath, MARKETPLACE_YAML_FILENAME);
  let raw: string;
  try {
    raw = await readFile(yamlPath, 'utf8');
  } catch (err) {
    throw new CatalogueSourceError(
      `catalogue ${entry.url} has no ${MARKETPLACE_YAML_FILENAME} at its root: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(raw);
  } catch (err) {
    throw new CatalogueSourceError(
      `${yamlPath}: invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = marketplaceYamlSchema.safeParse(parsedYaml);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new CatalogueSourceError(`${yamlPath}: schema validation failed:\n${issues}`);
  }

  const source: { url: string; ref?: string; sha: string } = {
    url: gitResult.url,
    sha: gitResult.sha,
  };
  if (gitResult.ref !== undefined) source.ref = gitResult.ref;

  return {
    yaml: result.data,
    rootPath: gitResult.localPath,
    yamlPath,
    source,
  };
}

/** The result of resolving a `(catalogue, package, version)` triple. */
export type CatalogueResolveResult = {
  /** The fetched component bundle, ready for the render pipeline. */
  bundle: ComponentBundle;
  /** The catalogue that provided the package. */
  catalogue: LoadedCatalogue;
  /** Package name within the catalogue. */
  name: string;
  /** Concrete version that satisfied the spec. */
  version: string;
  /** The package's git coordinate (carried through to the lockfile by M13.4). */
  packageSource: {
    git: string;
    ref?: string;
    path?: string;
    /** Resolved SHA of the package's source repo. */
    sha: string;
  };
};

export type ResolveFromCatalogueOpts = {
  /** Override the shared cache root. */
  cacheDir?: string;
  /** Force the package repo to be re-fetched. */
  refresh?: boolean;
};

/**
 * Resolve `<package>@<versionSpec>` against an already-loaded catalogue.
 * Picks the highest version satisfying the spec, refuses the request if
 * the qualified name is in the catalogue's own `blocks` list, then
 * delegates to `GitSource` + `loadFromPath` for the actual fetch.
 *
 * The bundle's `sourceKind` is `'git'` (remote → always sandboxed),
 * matching `MarketplaceSource`'s policy.
 */
export async function resolveFromCatalogue(
  catalogue: LoadedCatalogue,
  packageName: string,
  versionSpec: string,
  opts: ResolveFromCatalogueOpts = {},
): Promise<CatalogueResolveResult> {
  const qualified = `${catalogue.yaml.namespace}/${packageName}`;
  if ((catalogue.yaml.blocks ?? []).includes(qualified)) {
    throw new CatalogueSourceError(`"${qualified}" is blocked by its own catalogue policy`);
  }

  const pkg = catalogue.yaml.packages.find((p) => p.name === packageName);
  if (!pkg) {
    const known = catalogue.yaml.packages.map((p) => p.name).join(', ') || '<none>';
    throw new CatalogueSourceError(
      `catalogue "${catalogue.yaml.namespace}" does not list a package "${packageName}" (has: ${known})`,
    );
  }

  const availableTags = pkg.versions.map((v) => v.tag);
  const chosen = pickVersion(availableTags, versionSpec);
  if (!chosen) {
    throw new CatalogueSourceError(
      `no version of "${qualified}" satisfies "${versionSpec}" (available: ${availableTags.join(', ')})`,
    );
  }
  const versionEntry = pkg.versions.find((v) => v.tag === chosen);
  if (!versionEntry) {
    throw new CatalogueSourceError(`internal: version entry for ${chosen} vanished`);
  }

  const gitOpts: GitResolveOpts = {};
  if (opts.cacheDir !== undefined) gitOpts.cacheDir = opts.cacheDir;
  if (opts.refresh !== undefined) gitOpts.refresh = opts.refresh;

  let packageGit: GitResolveResult;
  try {
    const entry: { url: string; ref?: string } = { url: versionEntry.source.git };
    if (versionEntry.source.ref !== undefined) entry.ref = versionEntry.source.ref;
    packageGit = await resolveGitSource(entry, gitOpts);
  } catch (err) {
    throw new CatalogueSourceError(
      `cannot fetch package "${qualified}@${chosen}" from ${versionEntry.source.git}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const bundlePath = versionEntry.source.path
    ? join(packageGit.localPath, versionEntry.source.path)
    : packageGit.localPath;

  let bundle: ComponentBundle;
  try {
    bundle = await loadFromPath(bundlePath, 'git');
  } catch (err) {
    throw new CatalogueSourceError(
      `package "${qualified}@${chosen}" at ${bundlePath} could not be loaded: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const packageSource: CatalogueResolveResult['packageSource'] = {
    git: versionEntry.source.git,
    sha: packageGit.sha,
  };
  if (versionEntry.source.ref !== undefined) packageSource.ref = versionEntry.source.ref;
  if (versionEntry.source.path !== undefined) packageSource.path = versionEntry.source.path;

  return {
    bundle,
    catalogue,
    name: packageName,
    version: chosen,
    packageSource,
  };
}

/**
 * Build a `Catalogue` view over a loaded catalogue's in-memory yaml.
 * Search/browse/listVersions filter out packages whose qualified name is
 * in the catalogue's own `blocks` list. Discovery never hits the network;
 * the catalogue is already on disk.
 */
export function createCatalogueFromYaml(catalogue: LoadedCatalogue): Catalogue {
  const blocks = new Set(catalogue.yaml.blocks ?? []);
  const namespace = catalogue.yaml.namespace;

  const isBlocked = (name: string): boolean => blocks.has(`${namespace}/${name}`);

  const entryOf = (pkg: MarketplaceYaml['packages'][number]): CatalogueEntry => {
    const sorted = [...pkg.versions].sort((a, b) => compareVersions(b.tag, a.tag));
    const latest = sorted[0]?.tag ?? '0.0.0';
    const entry: CatalogueEntry = {
      name: pkg.name,
      type: 'component',
      latest,
      categories: pkg.categories ?? [],
    };
    if (pkg.kind !== undefined) entry.kind = pkg.kind;
    if (pkg.description !== undefined) entry.description = pkg.description;
    return entry;
  };

  return {
    async search(query: string): Promise<CatalogueEntry[]> {
      const q = query.trim().toLowerCase();
      return catalogue.yaml.packages
        .filter((p) => !isBlocked(p.name))
        .filter((p) => {
          if (q.length === 0) return true;
          if (p.name.toLowerCase().includes(q)) return true;
          if (p.description?.toLowerCase().includes(q)) return true;
          if ((p.categories ?? []).some((c) => c.toLowerCase().includes(q))) return true;
          return false;
        })
        .map(entryOf);
    },

    async browse(category: string): Promise<CatalogueEntry[]> {
      return catalogue.yaml.packages
        .filter((p) => !isBlocked(p.name))
        .filter((p) => (p.categories ?? []).includes(category))
        .map(entryOf);
    },

    async listVersions(name: string): Promise<string[]> {
      if (isBlocked(name)) {
        throw new CatalogueError(
          `package "${namespace}/${name}" is blocked by its own catalogue policy`,
        );
      }
      const pkg = catalogue.yaml.packages.find((p) => p.name === name);
      if (!pkg) {
        throw new CatalogueError(`catalogue "${namespace}" does not list a package "${name}"`);
      }
      return [...pkg.versions].sort((a, b) => compareVersions(b.tag, a.tag)).map((v) => v.tag);
    },
  };
}

/** Extract the policy directives a catalogue contributes to aggregate policy. */
export type CataloguePolicy = {
  /** Qualified names this catalogue blocks. */
  blocks: string[];
  /** Bare-name overrides this catalogue declares. */
  overrides: Array<{ name: string; use: string }>;
};

export function extractCataloguePolicy(catalogue: LoadedCatalogue): CataloguePolicy {
  return {
    blocks: catalogue.yaml.blocks ?? [],
    overrides: catalogue.yaml.overrides ?? [],
  };
}

/** Re-export for tests/users — the same matcher MarketplaceSource uses. */
export { versionSatisfies };
