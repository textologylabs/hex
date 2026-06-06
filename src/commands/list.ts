import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import type { AggregateCatalogueEntry } from '../core/catalogue/aggregate.js';
import {
  type CatalogueProvider,
  loadCatalogueProviders,
  searchCatalogueProviders,
} from '../core/catalogue/catalogue-providers.js';
import { getDefaultConfigPath, loadConfig } from '../core/config/load.js';
import { type TemplateEntry, discoverTemplates } from '../core/discovery/index.js';

export function registerList(program: Command): void {
  program
    .command('list')
    .description('list templates available across configured source roots')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (opts: { json: boolean }) => {
      const config = await loadConfig();
      const { templates, warnings } = await discoverTemplates(config);
      const { providers, warnings: catalogueWarnings } = await loadCatalogueProviders(config);
      const { entries: catalogueEntries, warnings: searchWarnings } =
        await searchCatalogueProviders(providers, '');
      const allWarnings = [...warnings, ...catalogueWarnings, ...searchWarnings];

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              templates,
              catalogueEntries,
              warnings: allWarnings,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (config.sources.length === 0) {
        const configPath = getDefaultConfigPath();
        const example =
          '  sources:\n    - path: ~/dev/hex-templates\n    - path: /opt/hex/templates\n';
        process.stdout.write(
          `${brand.dim('No source roots configured.')}\n\nAdd a config file at ${brand.bold(configPath)}:\n\n${example}`,
        );
        return;
      }

      if (templates.length === 0 && catalogueEntries.length === 0) {
        process.stdout.write(`${brand.dim('No templates found.')}\n`);
      } else {
        process.stdout.write(formatTable(templates, catalogueEntries, providers));
      }

      if (allWarnings.length > 0) {
        process.stdout.write('\n');
        for (const w of allWarnings) {
          process.stdout.write(`${brand.warn(`! ${w}`)}\n`);
        }
      }
    });
}

type Row = {
  name: string;
  version: string;
  type: string;
  kind: string;
  source: string;
};

function templateRow(t: TemplateEntry): Row {
  return {
    name: t.name,
    version: `@${t.version}`,
    type: t.type,
    kind: t.kind ?? '',
    source: t.rootPath,
  };
}

function catalogueRow(e: AggregateCatalogueEntry, providers: CatalogueProvider[]): Row {
  const provider = providers.find((p) => p.id === e.marketplace);
  return {
    name: `${e.marketplace}/${e.name}`,
    version: `@${e.latest}`,
    type: e.type,
    kind: e.kind ?? '',
    source: provider ? `catalogue:${provider.display}` : `catalogue:${e.marketplace}`,
  };
}

function formatTable(
  templates: TemplateEntry[],
  catalogueEntries: AggregateCatalogueEntry[],
  providers: CatalogueProvider[],
): string {
  const rows: Row[] = [
    ...templates.map(templateRow),
    ...catalogueEntries.map((e) => catalogueRow(e, providers)),
  ];

  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    kind: Math.max(4, ...rows.map((r) => r.kind.length)),
  };

  return rows
    .map((r) => {
      const name = brand.bold(r.name.padEnd(widths.name));
      const version = brand.dim(r.version.padEnd(widths.version));
      const type = r.type.padEnd(widths.type);
      const kind = r.kind.padEnd(widths.kind);
      const source = brand.dim(r.source);
      return `${name}  ${version}  ${type}  ${kind}  ${source}\n`;
    })
    .join('');
}
