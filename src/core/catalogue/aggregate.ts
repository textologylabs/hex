import type { MarketplaceConfig } from '../marketplace/address.js';
import type { Fetcher } from '../marketplace/source.js';
import { createMarketplaceCatalogue } from './marketplace.js';
import type { CatalogueEntry } from './types.js';

/**
 * Multi-marketplace aggregation (M9.5). A Hex install can have several
 * marketplaces configured — the public `hex` registry plus, say, a
 * company `acme` and an `acme-frontend`. `idea.md` §9 aggregates them
 * into one flat discovery surface:
 *
 *   - `search` / `browse` union results across *every* marketplace,
 *     each result tagged with the marketplace it came from — so a name
 *     clash (the same package in two marketplaces) surfaces as two
 *     distinct, qualified entries rather than one shadowing the other.
 *   - `listVersions` walks marketplaces in declared order and returns
 *     the first hit — the same precedence bare-name resolution uses
 *     (`resolveAddress`, M9.4).
 *
 * One unreachable marketplace must not sink discovery: per-marketplace
 * failures land in a `warnings` channel and the rest still answer.
 */

/** A discovery result tagged with its originating marketplace. */
export type AggregateCatalogueEntry = CatalogueEntry & {
  /** Id of the marketplace this entry came from. */
  marketplace: string;
};

/** Outcome of an aggregate `search` / `browse` — results plus soft failures. */
export type AggregateSearchResult = {
  /** Matches across all marketplaces, in marketplace-declaration order. */
  entries: AggregateCatalogueEntry[];
  /** One line per marketplace that could not be queried. */
  warnings: string[];
};

/** Outcome of an aggregate `listVersions` — the winning marketplace + versions. */
export type AggregateVersionResult = {
  marketplace: string;
  /** Published versions, newest first. */
  versions: string[];
};

export type AggregateCatalogue = {
  /** Free-text search unioned across every configured marketplace. */
  search(query: string): Promise<AggregateSearchResult>;
  /** Category browse unioned across every configured marketplace. */
  browse(category: string): Promise<AggregateSearchResult>;
  /**
   * Versions of `name` from the first marketplace (declared order) that
   * publishes it — `null` if no marketplace does.
   */
  listVersions(name: string): Promise<AggregateVersionResult | null>;
};

export type AggregateCatalogueOpts = {
  /** Override the URL fetcher (test injection). */
  fetcher?: Fetcher;
};

/**
 * Build an `AggregateCatalogue` over an ordered list of marketplaces.
 * Order is significant: it drives `listVersions` precedence and the
 * order entries appear in `search` / `browse` results.
 */
export function createAggregateCatalogue(
  marketplaces: MarketplaceConfig[],
  opts: AggregateCatalogueOpts = {},
): AggregateCatalogue {
  async function fanOut(
    op: (mkt: MarketplaceConfig) => Promise<CatalogueEntry[]>,
  ): Promise<AggregateSearchResult> {
    const entries: AggregateCatalogueEntry[] = [];
    const warnings: string[] = [];
    for (const mkt of marketplaces) {
      try {
        const found = await op(mkt);
        for (const e of found) entries.push({ ...e, marketplace: mkt.id });
      } catch (err) {
        warnings.push(`${mkt.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { entries, warnings };
  }

  return {
    search(query) {
      return fanOut((mkt) =>
        createMarketplaceCatalogue(mkt.registry, { fetcher: opts.fetcher }).search(query),
      );
    },

    browse(category) {
      return fanOut((mkt) =>
        createMarketplaceCatalogue(mkt.registry, { fetcher: opts.fetcher }).browse(category),
      );
    },

    async listVersions(name) {
      for (const mkt of marketplaces) {
        try {
          const versions = await createMarketplaceCatalogue(mkt.registry, {
            fetcher: opts.fetcher,
          }).listVersions(name);
          if (versions.length > 0) return { marketplace: mkt.id, versions };
        } catch {
          // Package absent here (or registry unreachable) — try the next.
        }
      }
      return null;
    },
  };
}
