import { isCancel, select } from '@clack/prompts';
import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import {
  type AggregateCatalogueEntry,
  createAggregateCatalogue,
} from '../core/catalogue/aggregate.js';
import {
  browseCatalogueProviders,
  loadCatalogueProviders,
  searchCatalogueProviders,
} from '../core/catalogue/catalogue-providers.js';
import { browseLocalCatalogue, searchLocalCatalogue } from '../core/catalogue/local-catalogue.js';
import { getDefaultConfigPath, loadConfig } from '../core/config/load.js';
import type { HexConfig } from '../core/config/types.js';
import type { MarketplaceConfig } from '../core/marketplace/address.js';
import { loadAggregatePolicy } from '../core/marketplace/policy.js';
import { formatSearchTable } from './search.js';

/** One browseable category and how many entries it holds. */
export type CategorySummary = { name: string; count: number };

export type BrowseCategoriesResult = {
  /** Distinct categories across all marketplaces, alphabetical. */
  categories: CategorySummary[];
  /** Soft failures — unreachable marketplaces, unloadable policy. */
  warnings: string[];
};

export type BrowseEntriesResult = {
  category: string;
  /** Entries filed under the category, blocked entries already filtered out. */
  results: AggregateCatalogueEntry[];
  warnings: string[];
};

/**
 * Enumerate every category across the configured marketplaces. Built
 * from the aggregate `search('')` result (all entries, blocked ones
 * already dropped by policy) folded into a category → count tally.
 */
export async function listCategories(
  marketplaces: MarketplaceConfig[],
): Promise<BrowseCategoriesResult> {
  const policy = await loadAggregatePolicy(marketplaces);
  const { entries, warnings } = await createAggregateCatalogue(marketplaces, { policy }).search('');

  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const category of entry.categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  const categories = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  return { categories, warnings: [...policy.warnings, ...warnings] };
}

/** List the entries filed under one category across all marketplaces. */
export async function browseCategory(
  marketplaces: MarketplaceConfig[],
  category: string,
): Promise<BrowseEntriesResult> {
  const policy = await loadAggregatePolicy(marketplaces);
  const { entries, warnings } = await createAggregateCatalogue(marketplaces, { policy }).browse(
    category,
  );
  return { category, results: entries, warnings: [...policy.warnings, ...warnings] };
}

export type BrowseAllOpts = {
  /** Forwarded to `loadCatalogueProviders` (test injection). */
  cacheDir?: string;
};

/**
 * Category tally across every configured marketplace, every
 * `catalogue:` source (M13.3) AND every `path:` / `git:` source root
 * (M14.9). Counts union over all three surfaces.
 */
export async function listAllCategories(
  config: HexConfig,
  opts: BrowseAllOpts = {},
): Promise<BrowseCategoriesResult> {
  const marketplaces = config.marketplaces ?? [];
  const mktResult = await listCategories(marketplaces);

  const providerOpts: { cacheDir?: string } = {};
  if (opts.cacheDir !== undefined) providerOpts.cacheDir = opts.cacheDir;
  const { providers, warnings: providerWarnings } = await loadCatalogueProviders(
    config,
    providerOpts,
  );
  const { entries: catEntries, warnings: searchWarnings } = await searchCatalogueProviders(
    providers,
    '',
  );

  const localDiscoveryOpts = opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {};
  const { entries: localEntries, warnings: localWarnings } = await searchLocalCatalogue(
    config,
    '',
    localDiscoveryOpts,
  );

  const counts = new Map<string, number>(mktResult.categories.map((c) => [c.name, c.count]));
  for (const entry of [...catEntries, ...localEntries]) {
    for (const category of entry.categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  const categories = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  return {
    categories,
    warnings: [...mktResult.warnings, ...providerWarnings, ...searchWarnings, ...localWarnings],
  };
}

/**
 * Browse one category across every configured marketplace, every
 * `catalogue:` source (M13.3) AND every `path:` / `git:` source root
 * (M14.9). Marketplace entries come first to preserve existing CLI
 * ordering; catalogue and local entries follow.
 */
export async function browseCategoryAllSources(
  config: HexConfig,
  category: string,
  opts: BrowseAllOpts = {},
): Promise<BrowseEntriesResult> {
  const marketplaces = config.marketplaces ?? [];
  const mktResult = await browseCategory(marketplaces, category);

  const providerOpts: { cacheDir?: string } = {};
  if (opts.cacheDir !== undefined) providerOpts.cacheDir = opts.cacheDir;
  const { providers, warnings: providerWarnings } = await loadCatalogueProviders(
    config,
    providerOpts,
  );
  const { entries: catEntries, warnings: browseWarnings } = await browseCatalogueProviders(
    providers,
    category,
  );

  const localDiscoveryOpts = opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {};
  const { entries: localEntries, warnings: localWarnings } = await browseLocalCatalogue(
    config,
    category,
    localDiscoveryOpts,
  );

  return {
    category,
    results: [...mktResult.results, ...catEntries, ...localEntries],
    warnings: [...mktResult.warnings, ...providerWarnings, ...browseWarnings, ...localWarnings],
  };
}

/** Render the category list as aligned `name  (count)` rows. */
export function formatCategories(categories: CategorySummary[]): string {
  const width = Math.max(8, ...categories.map((c) => c.name.length));
  return categories
    .map((c) => `${brand.bold(c.name.padEnd(width))}  ${brand.dim(`(${c.count})`)}\n`)
    .join('');
}

function writeWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  process.stdout.write('\n');
  for (const w of warnings) {
    process.stdout.write(`${brand.warn(`! ${w}`)}\n`);
  }
}

export function registerBrowse(program: Command): void {
  program
    .command('browse')
    .description('browse marketplace categories and the templates filed under them')
    .argument('[category]', 'category to list directly (skips the interactive picker)')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (category: string | undefined, opts: { json: boolean }) => {
      const config = await loadConfig();
      const marketplaces = config.marketplaces ?? [];

      if (marketplaces.length === 0 && config.sources.length === 0) {
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ categories: [], warnings: [] }, null, 2)}\n`);
          return;
        }
        const configPath = getDefaultConfigPath();
        const example =
          '  sources:\n    - path: ~/dev/hex-templates\n' +
          '    - catalogue: https://github.com/textologylabs/hex-marketplace\n' +
          '  marketplaces:\n    - id: hex\n      registry: https://registry.hex.dev/\n';
        process.stdout.write(
          `${brand.dim('No sources or marketplaces configured.')}\n\nAdd one to ${brand.bold(configPath)}:\n\n${example}`,
        );
        return;
      }

      // A category argument lists it directly — no picker.
      if (category !== undefined) {
        const { results, warnings } = await browseCategoryAllSources(config, category);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ category, results, warnings }, null, 2)}\n`);
          return;
        }
        if (results.length === 0) {
          process.stdout.write(`${brand.dim(`No templates in category "${category}".`)}\n`);
        } else {
          process.stdout.write(formatSearchTable(results));
        }
        writeWarnings(warnings);
        return;
      }

      const { categories, warnings } = await listAllCategories(config);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ categories, warnings }, null, 2)}\n`);
        return;
      }

      if (categories.length === 0) {
        process.stdout.write(`${brand.dim('No categories found.')}\n`);
        writeWarnings(warnings);
        return;
      }

      // Non-interactive (piped / no TTY): print the flat category list.
      if (!process.stdout.isTTY) {
        process.stdout.write(formatCategories(categories));
        writeWarnings(warnings);
        return;
      }

      // Interactive: pick a category, then drill down into its entries.
      const picked = await select({
        message: 'Browse which category?',
        options: categories.map((c) => ({ value: c.name, label: `${c.name} (${c.count})` })),
      });
      if (isCancel(picked)) return;

      const drill = await browseCategoryAllSources(config, picked as string);
      if (drill.results.length === 0) {
        process.stdout.write(`${brand.dim(`No templates in category "${picked}".`)}\n`);
      } else {
        process.stdout.write(formatSearchTable(drill.results));
      }
      writeWarnings([...warnings, ...drill.warnings]);
    });
}
