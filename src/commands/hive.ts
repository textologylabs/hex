import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import { loadCatalogueProviders } from '../core/catalogue/catalogue-providers.js';
import { createMarketplaceCatalogue } from '../core/catalogue/marketplace.js';
import { getDefaultConfigPath, loadConfig } from '../core/config/load.js';
import type { HexConfig } from '../core/config/types.js';
import { type NewSource, addSource, removeSource } from '../core/config/write.js';
import { buildBrowseCommand } from './browse.js';
import { buildValidateCommand } from './marketplace.js';
import { buildSearchCommand } from './search.js';
import { buildSourcesListCommand, buildSourcesRefreshCommand } from './sources.js';

/**
 * `hex hive` — the honeycomb hub (M15.1). One umbrella noun over the
 * whole "where do my templates come from" surface: list/refresh the
 * configured sources, search/browse what's in them, add/remove a source
 * without hand-editing YAML, inspect a single package's versions, and
 * validate a catalogue file. The discovery + source verbs used to be
 * scattered across `hex sources` / `hex search` / `hex browse` /
 * `hex marketplace`; those survive as hidden aliases.
 */
export function registerHive(program: Command): void {
  const hive = program
    .command('hive')
    .description('the honeycomb hub — discover, manage, and inspect your template sources');

  // Bare `hex hive` lists configured sources (list is the default action).
  buildSourcesListCommand(hive, { isDefault: true });
  buildSourcesRefreshCommand(hive);
  buildSearchCommand(hive);
  buildBrowseCommand(hive);
  buildHiveAddCommand(hive);
  buildHiveRemoveCommand(hive);
  buildHiveInfoCommand(hive);
  buildValidateCommand(hive);
}

type AddOpts = { ref?: string; git?: boolean; path?: boolean };

/** `hex hive add <url>` — append a source to config.yaml (catalogue by default). */
function buildHiveAddCommand(parent: Command): void {
  parent
    .command('add')
    .description('add a source to your config (a catalogue by default)')
    .argument('<url>', 'catalogue/git URL, or a local path with --path')
    .option('--ref <ref>', 'pin a git ref (branch / tag / sha)')
    .option('--git', 'add as a plain git template source instead of a catalogue', false)
    .option('--path', 'add as a local filesystem path source', false)
    .action(async (url: string, opts: AddOpts) => {
      const entry = toNewSource(url, opts);
      const { added, configPath } = await addSource(entry);
      if (added) {
        process.stdout.write(
          `${brand.done('✓')} added ${brand.bold(`${entry.kind}`)} ${url}${
            entry.kind !== 'path' && opts.ref ? brand.dim(`@${opts.ref}`) : ''
          }\n${brand.dim(`  → ${configPath}`)}\n`,
        );
      } else {
        process.stdout.write(`${brand.dim(`${url} is already configured — nothing to do.`)}\n`);
      }
    });
}

/** `hex hive remove <url>` — drop matching source(s) from config.yaml. */
function buildHiveRemoveCommand(parent: Command): void {
  parent
    .command('remove')
    .alias('rm')
    .description('remove a source from your config by its URL or path')
    .argument('<url>', 'the catalogue/git URL or path to remove')
    .action(async (url: string) => {
      const { removed, configPath } = await removeSource(url);
      if (removed > 0) {
        process.stdout.write(
          `${brand.done('✓')} removed ${removed} source${removed === 1 ? '' : 's'} matching ${url}\n${brand.dim(`  → ${configPath}`)}\n`,
        );
      } else {
        process.stdout.write(`${brand.dim(`No configured source matched ${url}.`)}\n`);
      }
    });
}

function toNewSource(url: string, opts: AddOpts): NewSource {
  if (opts.path) return { kind: 'path', path: url };
  const kind = opts.git ? 'git' : 'catalogue';
  return opts.ref ? { kind, url, ref: opts.ref } : { kind, url };
}

/** One package's versions in one source (marketplace or catalogue). */
export type InfoHit = {
  /** `<namespace>/<name>` — the qualified address. */
  qualified: string;
  /** Where it resolves from — `marketplace <registry>` or `catalogue <url>`. */
  source: string;
  /** Published versions, newest first. */
  versions: string[];
};

export type InfoResult = {
  package: string;
  hits: InfoHit[];
  warnings: string[];
};

/**
 * Look up one package's published versions across every configured
 * marketplace and catalogue (M15.1) — the per-package view no other
 * command exposes. Accepts a bare name (`api`) or a qualified address
 * (`acme/api`); a qualified name restricts the lookup to that namespace.
 */
export async function collectPackageInfo(config: HexConfig, pkg: string): Promise<InfoResult> {
  const slash = pkg.indexOf('/');
  const namespace = slash >= 0 ? pkg.slice(0, slash) : undefined;
  const name = slash >= 0 ? pkg.slice(slash + 1) : pkg;

  const hits: InfoHit[] = [];
  const warnings: string[] = [];

  // Marketplaces (M9.5) — listVersions per registry, newest first.
  for (const mkt of config.marketplaces ?? []) {
    if (namespace && mkt.id !== namespace) continue;
    try {
      const versions = await createMarketplaceCatalogue(mkt.registry).listVersions(name);
      if (versions.length > 0) {
        hits.push({
          qualified: `${mkt.id}/${name}`,
          source: `marketplace ${mkt.registry}`,
          versions,
        });
      }
    } catch {
      // Package absent here, or registry unreachable — try the next.
    }
  }

  // Catalogues (M13.3) — listVersions per provider, tagged by namespace.
  const { providers, warnings: providerWarnings } = await loadCatalogueProviders(config);
  warnings.push(...providerWarnings);
  for (const p of providers) {
    if (namespace && p.id !== namespace) continue;
    try {
      const versions = await p.catalogue.listVersions(name);
      if (versions.length > 0) {
        hits.push({ qualified: `${p.id}/${name}`, source: `catalogue ${p.display}`, versions });
      }
    } catch {
      // Unknown package in this catalogue — skip.
    }
  }

  return { package: pkg, hits, warnings };
}

/** Render an `info` result as human-facing text. */
export function formatPackageInfo(result: InfoResult): string {
  if (result.hits.length === 0) {
    return `${brand.dim(`No package "${result.package}" found in configured marketplaces or catalogues.`)}\n${brand.dim('(local templates are listed by `hex list`)')}\n`;
  }
  let out = '';
  for (const hit of result.hits) {
    out += `${brand.bold(hit.qualified)}\n`;
    out += `  ${brand.dim(hit.source)}\n`;
    out += `  ${brand.dim('versions:')} ${hit.versions.join(', ')}\n`;
  }
  return out;
}

/** `hex hive info <pkg>` — show a package's versions + where it resolves from. */
function buildHiveInfoCommand(parent: Command): void {
  parent
    .command('info')
    .description("show a package's published versions and where it resolves from")
    .argument('<package>', 'package name (`api`) or qualified address (`acme/api`)')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (pkg: string, opts: { json: boolean }) => {
      const config = await loadConfig();
      if ((config.marketplaces ?? []).length === 0 && config.sources.length === 0) {
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ package: pkg, hits: [], warnings: [] }, null, 2)}\n`,
          );
          return;
        }
        const configPath = getDefaultConfigPath();
        process.stdout.write(
          `${brand.dim('No sources or marketplaces configured.')}\n${brand.dim(`Add one with ${brand.bold('hex hive add <url>')} or edit ${configPath}.`)}\n`,
        );
        return;
      }

      const result = await collectPackageInfo(config, pkg);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      process.stdout.write(formatPackageInfo(result));
      if (result.warnings.length > 0) {
        process.stdout.write('\n');
        for (const w of result.warnings) process.stdout.write(`${brand.warn(`! ${w}`)}\n`);
      }
    });
}
