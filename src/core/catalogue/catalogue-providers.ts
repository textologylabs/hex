import type { HexConfig } from '../config/types.js';
import {
  type LoadedCatalogue,
  createCatalogueFromYaml,
  loadCatalogue,
} from '../marketplace/catalogue-source.js';
import type { AggregateCatalogueEntry, AggregateSearchResult } from './aggregate.js';
import type { Catalogue } from './types.js';

/**
 * Catalogue-source discovery providers (M13.3). Each `catalogue:` source
 * in `~/.hex/config.yaml` is loaded (clone + schema-validate the catalogue's
 * `marketplace.yaml`), wrapped in a `Catalogue` view via
 * `createCatalogueFromYaml`, and tagged with the catalogue's own
 * `namespace` — that namespace plays the same role as a marketplace's `id`
 * (the `<id>/<name>` qualifier).
 *
 * Search / browse fan out across providers and tag each entry with the
 * originating namespace, mirroring `createAggregateCatalogue`'s shape so
 * the commands can union the results without reshaping them.
 *
 * Block policy that travels inside a catalogue (`blocks:` in
 * `marketplace.yaml`) is already enforced by `createCatalogueFromYaml`,
 * so providers never surface blocked entries to begin with — there is
 * nothing further to filter at this layer.
 */

export type CatalogueProvider = {
  /** Catalogue namespace — the `<id>/<name>` qualifier in addressing. */
  id: string;
  /** Catalogue view backed by the loaded `marketplace.yaml`. */
  catalogue: Catalogue;
  /** Loaded catalogue document (kept around for downstream resolution). */
  loaded: LoadedCatalogue;
  /** User-facing display label (`<url>` or `<url>@<ref>`). */
  display: string;
};

export type LoadCatalogueProvidersOpts = {
  /** Override the shared cache root. */
  cacheDir?: string;
};

export type LoadCatalogueProvidersResult = {
  providers: CatalogueProvider[];
  /** One line per catalogue source that could not be loaded. */
  warnings: string[];
};

/**
 * Walk every `catalogue:` source in `config.sources`, load each one, and
 * return providers. A single broken catalogue contributes a warning and
 * is skipped — one bad source must not sink discovery.
 */
export async function loadCatalogueProviders(
  config: HexConfig,
  opts: LoadCatalogueProvidersOpts = {},
): Promise<LoadCatalogueProvidersResult> {
  const providers: CatalogueProvider[] = [];
  const warnings: string[] = [];

  for (const source of config.sources) {
    if (source.kind !== 'catalogue') continue;
    const display = source.ref ? `${source.url}@${source.ref}` : source.url;
    const entry: { url: string; ref?: string } = { url: source.url };
    if (source.ref !== undefined) entry.ref = source.ref;
    const loadOpts: { cacheDir?: string } = {};
    if (opts.cacheDir !== undefined) loadOpts.cacheDir = opts.cacheDir;

    try {
      const loaded = await loadCatalogue(entry, loadOpts);
      providers.push({
        id: loaded.yaml.namespace,
        catalogue: createCatalogueFromYaml(loaded),
        loaded,
        display,
      });
    } catch (err) {
      warnings.push(`catalogue ${display}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { providers, warnings };
}

/** Free-text search unioned across catalogue providers, tagged with namespace. */
export async function searchCatalogueProviders(
  providers: CatalogueProvider[],
  query: string,
): Promise<AggregateSearchResult> {
  const entries: AggregateCatalogueEntry[] = [];
  const warnings: string[] = [];
  for (const p of providers) {
    try {
      const found = await p.catalogue.search(query);
      for (const e of found) entries.push({ ...e, marketplace: p.id });
    } catch (err) {
      warnings.push(`${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { entries, warnings };
}

/** Category browse unioned across catalogue providers, tagged with namespace. */
export async function browseCatalogueProviders(
  providers: CatalogueProvider[],
  category: string,
): Promise<AggregateSearchResult> {
  const entries: AggregateCatalogueEntry[] = [];
  const warnings: string[] = [];
  for (const p of providers) {
    try {
      const found = await p.catalogue.browse(category);
      for (const e of found) entries.push({ ...e, marketplace: p.id });
    } catch (err) {
      warnings.push(`${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { entries, warnings };
}
