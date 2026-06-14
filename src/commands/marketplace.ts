import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { brand } from '../brand/colors.js';
import {
  MARKETPLACE_YAML_FILENAME,
  marketplaceYamlSchema,
} from '../core/marketplace/catalogue-schema.js';

/**
 * `hex marketplace …` — operations on `marketplace.yaml` files (M13.5).
 * Today the only subcommand is `validate`, which a catalogue repo's CI
 * runs on every PR to gate schema correctness (kebab-case names, semver
 * tags, no duplicate packages/versions, strict-key rejection, …).
 */
/** The `validate` action body — shared by the `hive` subcommand + legacy alias. */
export async function runValidateCommand(pathArg: string | undefined): Promise<void> {
  const path = resolve(pathArg ?? MARKETPLACE_YAML_FILENAME);
  const result = await validateMarketplaceFile(path);
  writeValidationReport(path, result);
  if (!result.ok) process.exitCode = 1;
}

/** Attach the `validate` subcommand to a parent (M15.1). */
export function buildValidateCommand(parent: Command): void {
  parent
    .command('validate')
    .description('schema-validate a marketplace.yaml catalogue file')
    .argument('[path]', `path to a marketplace.yaml (defaults to ./${MARKETPLACE_YAML_FILENAME})`)
    .action(runValidateCommand);
}

/**
 * Legacy `hex marketplace validate` — kept as a **hidden** alias of
 * `hex hive validate` (M15.1) so catalogue-repo CI that calls
 * `hex marketplace validate marketplace.yaml` keeps working unchanged.
 */
export function registerMarketplace(program: Command): void {
  const marketplace = program
    .command('marketplace', { hidden: true })
    .description('operations on marketplace.yaml catalogue files (alias: hex hive validate)');
  buildValidateCommand(marketplace);
}

export type ValidationIssue = {
  /** Dot-joined path inside the document (`<root>` for top-level issues). */
  path: string;
  message: string;
};

export type ValidationResult =
  | { ok: true; namespace: string; packageCount: number }
  | { ok: false; reason: 'read'; message: string }
  | { ok: false; reason: 'yaml'; message: string }
  | { ok: false; reason: 'schema'; issues: ValidationIssue[] };

/**
 * Read + schema-validate a `marketplace.yaml` at `path`. Pure data — never
 * writes to stdout, never throws on the expected failure modes (read /
 * yaml / schema). The caller decides how to surface the result.
 */
export async function validateMarketplaceFile(path: string): Promise<ValidationResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason: 'read',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return {
      ok: false,
      reason: 'yaml',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const result = marketplaceYamlSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: 'schema',
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.') || '<root>',
        message: i.message,
      })),
    };
  }

  return {
    ok: true,
    namespace: result.data.namespace,
    packageCount: result.data.packages.length,
  };
}

function writeValidationReport(path: string, result: ValidationResult): void {
  if (result.ok) {
    process.stdout.write(
      `${brand.done('✓')} ${brand.bold(path)}: ${brand.dim(
        `${result.namespace} · ${result.packageCount} package${result.packageCount === 1 ? '' : 's'}`,
      )}\n`,
    );
    return;
  }
  process.stderr.write(`${brand.error('✗')} ${brand.bold(path)}\n`);
  if (result.reason === 'read') {
    process.stderr.write(`  ${brand.dim(`cannot read: ${result.message}`)}\n`);
    return;
  }
  if (result.reason === 'yaml') {
    process.stderr.write(`  ${brand.dim(`invalid YAML: ${result.message}`)}\n`);
    return;
  }
  for (const issue of result.issues) {
    process.stderr.write(`  ${brand.dim(`${issue.path}:`)} ${issue.message}\n`);
  }
}
