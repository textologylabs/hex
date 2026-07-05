import { stat } from 'node:fs/promises';
import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import { getDefaultConfigPath, loadConfig } from '../core/config/load.js';
import type { HexConfig, SourceRootEntry } from '../core/config/types.js';
import { CatalogueSourceError, loadCatalogue } from '../core/marketplace/catalogue-source.js';
import {
  GitSourceError,
  checkUpstreamDrift,
  readGitMeta,
  resolveGitSource,
} from '../core/sources/git-source.js';

export type GitStatus = {
  cached: boolean;
  sha?: string;
  fetchedAt?: string;
  drift?: boolean;
  upstreamSha?: string;
  driftError?: string;
};

/**
 * Catalogue status (M13.2). Carries the underlying git-cache state plus
 * the outcome of validating the catalogue's `marketplace.yaml` against
 * the M13.1 schema. `catalogueError` populated when validation fails
 * (or the file is missing); on success, `namespace` and `packageCount`
 * are filled in for the human-facing status line.
 */
export type CatalogueStatus = GitStatus & {
  namespace?: string;
  packageCount?: number;
  catalogueError?: string;
};

export type SourceStatus =
  | { kind: 'path'; path: string; exists: boolean }
  | { kind: 'git'; url: string; ref?: string; status: GitStatus }
  | { kind: 'catalogue'; url: string; ref?: string; status: CatalogueStatus };

export type StatusOpts = {
  cacheDir?: string;
};

export type RefreshResult = {
  display: string;
  ok: boolean;
  sha?: string;
  error?: string;
};

export type RefreshOpts = {
  cacheDir?: string;
  onStart?: (display: string) => void;
  onComplete?: (result: RefreshResult) => void;
};

/**
 * Attach the `list` subcommand to a parent (M15.1). Used both by the
 * legacy `hex sources` alias and by the `hex hive` umbrella, so the two
 * surfaces share one definition. `isDefault` makes it the parent's
 * bare-invocation action (`hex hive` / `hex sources` → list).
 */
export function buildSourcesListCommand(parent: Command, opts: { isDefault?: boolean } = {}): void {
  const cmdOpts: { isDefault?: boolean } = {};
  if (opts.isDefault) cmdOpts.isDefault = true;
  parent
    .command('list', cmdOpts)
    .description('list configured sources with cache + drift status')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (o: { json: boolean }) => {
      const config = await loadConfig();
      await runList(config, o.json);
    });
}

/** Attach the `refresh` subcommand to a parent (M15.1). */
export function buildSourcesRefreshCommand(parent: Command): void {
  parent
    .command('refresh')
    .description('force-refresh every git + catalogue source, ignoring the cache')
    .action(async () => {
      const config = await loadConfig();
      await runRefresh(config);
    });
}

/**
 * Legacy `hex sources` command — kept as a **hidden** alias of the
 * `hex hive` subcommands (M15.1) so existing muscle memory and scripts
 * keep working. Discovery + source management now lives under `hex hive`.
 */
export function registerSources(program: Command): void {
  const sources = program
    .command('sources', { hidden: true })
    .description('manage configured template source roots (alias: hex hive)');
  buildSourcesListCommand(sources, { isDefault: true });
  buildSourcesRefreshCommand(sources);
}

async function runList(config: HexConfig, asJson: boolean): Promise<void> {
  if (config.sources.length === 0) {
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ sources: [] }, null, 2)}\n`);
      return;
    }
    const configPath = getDefaultConfigPath();
    process.stdout.write(`${brand.dim('No source roots configured.')}\n`);
    process.stdout.write(`${brand.dim(`(edit ${configPath} to add some)`)}\n`);
    return;
  }

  const statuses = await gatherSourceStatuses(config);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ sources: statuses }, null, 2)}\n`);
    return;
  }

  for (const s of statuses) process.stdout.write(formatStatusLine(s));
}

async function runRefresh(config: HexConfig): Promise<void> {
  const remoteSources = config.sources.filter((s) => s.kind === 'git' || s.kind === 'catalogue');

  if (remoteSources.length === 0) {
    process.stdout.write(`${brand.dim('No git or catalogue sources to refresh.')}\n`);
    return;
  }

  const callbacks: RefreshOpts = {
    onStart: (display) => process.stdout.write(`${brand.dim('refreshing')} ${display} ... `),
    onComplete: (r) => {
      if (r.ok) {
        process.stdout.write(`${brand.done('ok')} ${brand.dim(r.sha?.slice(0, 7) ?? '')}\n`);
      } else {
        process.stdout.write(`${brand.error('failed')}\n  ${brand.dim(r.error ?? '')}\n`);
      }
    },
  };

  const gitResults = await refreshAllGitSources(config, callbacks);
  const catResults = await refreshAllCatalogueSources(config, callbacks);

  if ([...gitResults, ...catResults].some((r) => !r.ok)) process.exitCode = 1;
}

/**
 * Collect cache + drift status for every configured source. Pure data
 * function — never writes to stdout, never triggers a clone (uses
 * `readGitMeta` for cache state, `checkUpstreamDrift` for the TTL-gated
 * upstream comparison).
 */
export async function gatherSourceStatuses(
  config: HexConfig,
  opts: StatusOpts = {},
): Promise<SourceStatus[]> {
  return Promise.all(config.sources.map((s) => describeSource(s, opts)));
}

/**
 * Force-refresh every git source. Pure data function — emits progress via
 * optional callbacks instead of writing to stdout, so tests can assert on
 * the returned result array without parsing terminal output.
 */
export async function refreshAllGitSources(
  config: HexConfig,
  opts: RefreshOpts = {},
): Promise<RefreshResult[]> {
  const gitSources = config.sources.filter((s) => s.kind === 'git');
  const results: RefreshResult[] = [];

  for (const source of gitSources) {
    const display = source.ref ? `${source.url}@${source.ref}` : source.url;
    opts.onStart?.(display);
    try {
      const result = await resolveGitSource(
        { url: source.url, ref: source.ref },
        { refresh: true, cacheDir: opts.cacheDir },
      );
      const r: RefreshResult = { display, ok: true, sha: result.sha };
      results.push(r);
      opts.onComplete?.(r);
    } catch (err) {
      const r: RefreshResult = {
        display,
        ok: false,
        error: err instanceof GitSourceError ? err.message : String(err),
      };
      results.push(r);
      opts.onComplete?.(r);
    }
  }

  return results;
}

/**
 * Force-refresh every configured `catalogue:` source (M13.2). Mirrors
 * `refreshAllGitSources` — same `RefreshResult` shape, same callback
 * contract — but additionally validates the cloned catalogue's
 * `marketplace.yaml` via `loadCatalogue` so a malformed catalogue
 * surfaces immediately rather than at first use. A schema failure marks
 * the result as not-ok with the validator's message.
 */
export async function refreshAllCatalogueSources(
  config: HexConfig,
  opts: RefreshOpts = {},
): Promise<RefreshResult[]> {
  const catalogues = config.sources.filter((s) => s.kind === 'catalogue');
  const results: RefreshResult[] = [];

  for (const source of catalogues) {
    const display = source.ref ? `${source.url}@${source.ref}` : source.url;
    opts.onStart?.(display);
    try {
      const loaded = await loadCatalogue(
        { url: source.url, ref: source.ref },
        { refresh: true, cacheDir: opts.cacheDir },
      );
      const r: RefreshResult = { display, ok: true, sha: loaded.source.sha };
      results.push(r);
      opts.onComplete?.(r);
    } catch (err) {
      const r: RefreshResult = {
        display,
        ok: false,
        error:
          err instanceof CatalogueSourceError || err instanceof GitSourceError
            ? err.message
            : String(err),
      };
      results.push(r);
      opts.onComplete?.(r);
    }
  }

  return results;
}

async function describeSource(source: SourceRootEntry, opts: StatusOpts): Promise<SourceStatus> {
  if (source.kind === 'path') {
    return { kind: 'path', path: source.path, exists: await pathExists(source.path) };
  }

  // Informational only — never triggers a clone. `hex sources refresh` is
  // the explicit knob that populates caches; `list` just reports state.
  const gitStatus = await describeGitState({ url: source.url, ref: source.ref }, opts);

  if (source.kind === 'git') {
    return { kind: 'git', url: source.url, ref: source.ref, status: gitStatus };
  }

  // Catalogue: same git state plus marketplace.yaml validation outcome.
  // Validation never triggers a fetch on its own — if the cache is cold,
  // there's nothing to validate yet and we leave `catalogueError` unset.
  const catStatus: CatalogueStatus = { ...gitStatus };
  if (gitStatus.cached) {
    try {
      const loaded = await loadCatalogue(
        { url: source.url, ref: source.ref },
        { cacheDir: opts.cacheDir },
      );
      catStatus.namespace = loaded.yaml.namespace;
      catStatus.packageCount = loaded.yaml.packages.length;
    } catch (err) {
      catStatus.catalogueError = err instanceof Error ? err.message : String(err);
    }
  }
  return { kind: 'catalogue', url: source.url, ref: source.ref, status: catStatus };
}

async function describeGitState(
  entry: { url: string; ref?: string },
  opts: StatusOpts,
): Promise<GitStatus> {
  const status: GitStatus = { cached: false };
  const meta = await readGitMeta(entry, opts.cacheDir);
  if (!meta) return status;
  status.cached = true;
  status.sha = meta.sha;
  status.fetchedAt = meta.fetchedAt;
  try {
    const drift = await checkUpstreamDrift(entry, { cacheDir: opts.cacheDir });
    status.drift = drift.drift;
    status.upstreamSha = drift.upstreamSha ?? undefined;
    if (drift.error) status.driftError = drift.error;
  } catch (err) {
    status.driftError = err instanceof Error ? err.message : String(err);
  }
  return status;
}

function formatStatusLine(s: SourceStatus): string {
  if (s.kind === 'path') {
    const tag = s.exists ? brand.done('exists') : brand.warn('missing');
    return `${brand.bold('path')}      ${s.path}  ${tag}\n`;
  }

  const display = s.ref ? `${s.url}@${s.ref}` : s.url;
  const tail = formatGitTail(s.status);
  // A failed drift probe means we couldn't reach the remote to compare
  // SHAs — the cached data below is still valid. Collapse the raw
  // (multi-line) git stderr to a short tag so it doesn't bleed across
  // the one-line-per-source status table; `hex hive refresh` surfaces the
  // full error when the user actually asks to fetch.
  const errSuffix = s.status.driftError ? `  ${brand.dim('(upstream unreachable)')}` : '';
  const label = s.kind === 'catalogue' ? 'catalogue' : 'git      ';

  if (s.kind === 'catalogue') {
    const n = s.status.packageCount ?? 0;
    const summary = s.status.catalogueError
      ? `  ${brand.error(`(${s.status.catalogueError})`)}`
      : s.status.namespace !== undefined
        ? `  ${brand.dim(`${s.status.namespace} · ${n} package${n === 1 ? '' : 's'}`)}`
        : '';
    return `${brand.bold(label)}  ${display}  ${tail}${errSuffix}${summary}\n`;
  }

  return `${brand.bold(label)}  ${display}  ${tail}${errSuffix}\n`;
}

function formatGitTail(status: GitStatus): string {
  if (!status.cached) return brand.dim('uncached');
  const sha = status.sha?.slice(0, 7) ?? '?';
  const fetchedAt = status.fetchedAt ? ` ${brand.dim(`fetched ${status.fetchedAt}`)}` : '';
  const drift = status.drift
    ? brand.warn(`drift → upstream ${status.upstreamSha?.slice(0, 7) ?? '?'}`)
    : brand.done('fresh');
  return `${brand.dim(sha)}${fetchedAt}  ${drift}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
