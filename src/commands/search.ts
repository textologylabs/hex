import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import {
  type AggregateCatalogueEntry,
  createAggregateCatalogue,
} from '../core/catalogue/aggregate.js';
import {
  loadCatalogueProviders,
  searchCatalogueProviders,
} from '../core/catalogue/catalogue-providers.js';
import { searchLocalCatalogue } from '../core/catalogue/local-catalogue.js';
import { getDefaultConfigPath, loadConfig } from '../core/config/load.js';
import type { HexConfig } from '../core/config/types.js';
import type { MarketplaceConfig } from '../core/marketplace/address.js';
import { loadAggregatePolicy } from '../core/marketplace/policy.js';

export type SearchResult = {
  /** Matches across all marketplaces, blocked entries already filtered out. */
  results: AggregateCatalogueEntry[];
  /** Soft failures — unreachable marketplaces, unloadable policy. */
  warnings: string[];
};

/**
 * Search every configured marketplace for `query` and aggregate the
 * hits. Block/override policy is loaded and applied: blocked entries are
 * dropped from the results (`override` is a resolution-time concern, so
 * it does not alter discovery output). Policy-load and per-marketplace
 * search failures are collected as warnings rather than thrown.
 */
export async function searchMarketplaces(
  marketplaces: MarketplaceConfig[],
  query: string,
): Promise<SearchResult> {
  const policy = await loadAggregatePolicy(marketplaces);
  const { entries, warnings } = await createAggregateCatalogue(marketplaces, { policy }).search(
    query,
  );
  return { results: entries, warnings: [...policy.warnings, ...warnings] };
}

/**
 * Search every configured marketplace AND every `catalogue:` source
 * (M13.3) AND every `path:` / `git:` source root (M14.9). Hits across
 * surfaces are unioned into a single `AggregateCatalogueEntry[]`, each
 * tagged with its originating marketplace — so a name clash across
 * surfaces appears as two distinct qualified entries rather than one
 * shadowing the other. Local filesystem hits carry the synthetic
 * `local` marketplace id. Marketplace results come first to preserve
 * the existing CLI ordering; catalogue and local results follow.
 */
export type SearchAllOpts = {
  /** Forwarded to `loadCatalogueProviders` (test injection). */
  cacheDir?: string;
};

export async function searchAllSources(
  config: HexConfig,
  query: string,
  opts: SearchAllOpts = {},
): Promise<SearchResult> {
  const marketplaces = config.marketplaces ?? [];
  const { results: mktResults, warnings: mktWarnings } = await searchMarketplaces(
    marketplaces,
    query,
  );

  const providerOpts: { cacheDir?: string } = {};
  if (opts.cacheDir !== undefined) providerOpts.cacheDir = opts.cacheDir;
  const { providers, warnings: providerWarnings } = await loadCatalogueProviders(
    config,
    providerOpts,
  );
  const { entries: catEntries, warnings: catSearchWarnings } = await searchCatalogueProviders(
    providers,
    query,
  );

  const localDiscoveryOpts = opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {};
  const { entries: localEntries, warnings: localWarnings } = await searchLocalCatalogue(
    config,
    query,
    localDiscoveryOpts,
  );

  return {
    results: [...mktResults, ...catEntries, ...localEntries],
    warnings: [...mktWarnings, ...providerWarnings, ...catSearchWarnings, ...localWarnings],
  };
}

/** Render search hits as an aligned `qualified-name@version  type  description` table. */
export function formatSearchTable(results: AggregateCatalogueEntry[]): string {
  const rows = results.map((e) => ({
    qualified: `${e.marketplace}/${e.name}`,
    version: `@${e.latest}`,
    type: e.type,
    description: e.description ?? '',
  }));

  const widths = {
    qualified: Math.max(4, ...rows.map((r) => r.qualified.length)),
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
  };

  return rows
    .map((r) => {
      const qualified = brand.bold(r.qualified.padEnd(widths.qualified));
      const version = brand.dim(r.version.padEnd(widths.version));
      const type = r.type.padEnd(widths.type);
      const description = brand.dim(r.description);
      return `${qualified}  ${version}  ${type}  ${description}\n`;
    })
    .join('');
}

/** The `search` action body — shared by the `hive` subcommand + legacy alias. */
export async function runSearchCommand(query: string, opts: { json: boolean }): Promise<void> {
  const config = await loadConfig();
  const marketplaces = config.marketplaces ?? [];

  if (marketplaces.length === 0 && config.sources.length === 0) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ results: [], warnings: [] }, null, 2)}\n`);
      return;
    }
    const configPath = getDefaultConfigPath();
    const example =
      '  sources:\n    - path: ~/dev/hex-templates\n' +
      '    - catalogue: https://github.com/textologylabs/hex-marketplace\n' +
      '  marketplaces:\n    - id: hex\n      registry: https://registry.hex.dev/\n';
    process.stdout.write(
      `${brand.dim('No sources or marketplaces configured.')}\n\nAdd one with ${brand.bold('hex hive add <url>')} or edit ${brand.bold(configPath)}:\n\n${example}`,
    );
    return;
  }

  const { results, warnings } = await searchAllSources(config, query);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ results, warnings }, null, 2)}\n`);
    return;
  }

  if (results.length === 0) {
    process.stdout.write(`${brand.dim(`No matches for "${query}".`)}\n`);
  } else {
    process.stdout.write(formatSearchTable(results));
  }

  if (warnings.length > 0) {
    process.stdout.write('\n');
    for (const w of warnings) {
      process.stdout.write(`${brand.warn(`! ${w}`)}\n`);
    }
  }
}

/** Attach the `search` subcommand to a parent (M15.1). */
export function buildSearchCommand(parent: Command, opts: { hidden?: boolean } = {}): void {
  const cmdOpts = opts.hidden ? { hidden: true } : {};
  parent
    .command('search', cmdOpts)
    .description('search templates + components across configured sources')
    .argument('<query>', 'free-text search query')
    .option('--json', 'emit machine-readable JSON', false)
    .action(runSearchCommand);
}

/** Legacy `hex search` — hidden alias of `hex hive search` (M15.1). */
export function registerSearch(program: Command): void {
  buildSearchCommand(program, { hidden: true });
}
