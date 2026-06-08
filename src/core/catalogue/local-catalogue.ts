import type { HexConfig } from '../config/types.js';
import { type DiscoveryOpts, type TemplateEntry, discoverTemplates } from '../discovery/index.js';
import type { AggregateCatalogueEntry } from './aggregate.js';

/**
 * Catalogue surface over filesystem source roots (M14.9). `hex search`
 * and `hex browse` historically only knew about `marketplaces:` and
 * `catalogue:` sources, even though `hex list` happily walks
 * `path:` and `git:` source roots. That asymmetry made local
 * development (clone a templates repo, point a `path:` entry at it,
 * iterate) effectively unsearchable.
 *
 * This module bridges the gap: it takes `discoverTemplates`' output
 * — which surfaces `path:` and `git:` roots uniformly — and
 * re-shapes the entries to the `AggregateCatalogueEntry` shape the
 * search/browse plumbing already operates on. The synthetic
 * marketplace id is `local`; categories are derived from each
 * component's `kind` so `hex browse api` returns every locally-known
 * component declared with `kind: api`.
 *
 * Manifests carry no top-level `description` field, so the
 * `description` slot stays empty for local entries — search matches
 * on `name` only for those.
 */

/** Reserved marketplace id used for filesystem (`path:` / `git:`) source roots. */
export const LOCAL_MARKETPLACE_ID = 'local';

export type LocalCatalogueResult = {
  entries: AggregateCatalogueEntry[];
  /** Discovery warnings (missing roots, malformed manifests, drift, etc). */
  warnings: string[];
};

/**
 * Map a `TemplateEntry` from filesystem discovery into the
 * `AggregateCatalogueEntry` shape used by search/browse. Components
 * contribute their `kind` as a single category so browse output groups
 * naturally; recipes contribute no category (consistent with how
 * `marketplace.yaml` recipes are filed). Version becomes `latest` —
 * filesystem discovery exposes one version per template.
 */
function toCatalogueEntry(t: TemplateEntry): AggregateCatalogueEntry {
  return {
    marketplace: LOCAL_MARKETPLACE_ID,
    name: t.name,
    type: t.type,
    ...(t.kind !== undefined && { kind: t.kind }),
    latest: t.version,
    categories: t.type === 'component' && t.kind ? [t.kind] : [],
  };
}

/**
 * Substring-match a query against an entry's name. Case-insensitive;
 * an empty query matches every entry. Mirrors the marketplace
 * catalogue's search semantics minus description/categories matching
 * (those slots are empty for local entries).
 */
function matchesQuery(entry: AggregateCatalogueEntry, query: string): boolean {
  if (query.length === 0) return true;
  return entry.name.toLowerCase().includes(query.toLowerCase());
}

/** Substring-match a category against an entry's categories (case-insensitive). */
function inCategory(entry: AggregateCatalogueEntry, category: string): boolean {
  const needle = category.toLowerCase();
  return entry.categories.some((c) => c.toLowerCase() === needle);
}

/**
 * Discover every template in `path:` / `git:` source roots and return
 * the matching `AggregateCatalogueEntry`s for `query`. An empty query
 * returns every entry — that's the shape `listAllCategories` consumes
 * to tally categories across local + marketplace + catalogue.
 */
export async function searchLocalCatalogue(
  config: HexConfig,
  query: string,
  opts: DiscoveryOpts = {},
): Promise<LocalCatalogueResult> {
  const { templates, warnings } = await discoverTemplates(config, opts);
  const entries = templates.map(toCatalogueEntry).filter((e) => matchesQuery(e, query));
  return { entries, warnings };
}

/** Same shape as `searchLocalCatalogue` but filtered by category, not query. */
export async function browseLocalCatalogue(
  config: HexConfig,
  category: string,
  opts: DiscoveryOpts = {},
): Promise<LocalCatalogueResult> {
  const { templates, warnings } = await discoverTemplates(config, opts);
  const entries = templates.map(toCatalogueEntry).filter((e) => inCategory(e, category));
  return { entries, warnings };
}
