import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HexConfig, SourceRootEntry } from '../config/types.js';
import { parseManifestFile } from '../manifest/parse.js';
import { findManifestFile } from '../sources/file-source.js';
import { checkUpstreamDrift, resolveGitSource } from '../sources/git-source.js';

export type TemplateEntry = {
  name: string;
  version: string;
  type: 'component' | 'recipe';
  kind?: string;
  rootPath: string;
  /**
   * User-facing label for the source root the template came from. For path
   * sources it's the configured directory; for git sources it's
   * `<url>@<ref>` (or just `<url>`) — never the cache path.
   */
  sourceRoot: string;
  /**
   * Trust-gradient marker (M7.6). `'file'` for local path sources;
   * `'git'` for cached git/marketplace sources. Used downstream to
   * decide whether `--trust-local` may bypass the JS-hook sandbox.
   */
  sourceKind: 'file' | 'git';
};

export type DiscoveryResult = {
  templates: TemplateEntry[];
  warnings: string[];
};

export type DiscoveryOpts = {
  /** Forwarded to `resolveGitSource` / `checkUpstreamDrift`. */
  cacheDir?: string;
  /** Override the upstream-drift check TTL (ms). Default 6h. */
  upstreamCheckTtlMs?: number;
  /** Override `now()` for upstream-drift checks (test injection). */
  now?: Date;
};

/**
 * Walk every configured source root one level deep, looking for child
 * directories that contain `.hex/manifest.{yaml,yml}`. Git source roots
 * are resolved through `resolveGitSource` first (lazy fetch on cache
 * miss) and then walked the same way as path roots.
 *
 * Malformed manifests, missing roots, and unreachable git URLs all skip
 * to a `warnings` channel instead of aborting the walk — one bad source
 * shouldn't take down `hex list`.
 *
 * Name clashes across roots: first-root-wins, with a warning. Predictable
 * without anticipating M9's qualified-name addressing.
 *
 * Discovery deliberately lives outside `sources/` because `idea.md`
 * Section 9 splits *fetch* (Source) from *discovery* (Catalogue). Even
 * though M2/M3 ship no formal `Catalogue` interface, keeping the modules
 * separate now avoids fusing them when M9 lands.
 */
export async function discoverTemplates(
  config: HexConfig,
  opts: DiscoveryOpts = {},
): Promise<DiscoveryResult> {
  const templates: TemplateEntry[] = [];
  const warnings: string[] = [];
  const seenNames = new Map<string, TemplateEntry>();

  for (const source of config.sources) {
    const resolved = await resolveSourceRoot(source, opts, warnings);
    if (!resolved) continue;
    await walkSourceRoot(resolved, templates, seenNames, warnings);
    if (source.kind === 'git') await emitDriftWarning(source, opts, warnings);
  }

  return { templates, warnings };
}

async function emitDriftWarning(
  source: { url: string; ref?: string },
  opts: DiscoveryOpts,
  warnings: string[],
): Promise<void> {
  const display = source.ref ? `${source.url}@${source.ref}` : source.url;
  const drift = await checkUpstreamDrift(source, {
    cacheDir: opts.cacheDir,
    ttlMs: opts.upstreamCheckTtlMs,
    now: opts.now,
  });
  if (!drift.drift || !drift.upstreamSha) return;
  warnings.push(
    `git source ${display}: upstream has new commits — run 'hex sources refresh' to update ` +
      `(cached: ${drift.cachedSha.slice(0, 7)}, upstream: ${drift.upstreamSha.slice(0, 7)})`,
  );
}

type ResolvedRoot = {
  /** Filesystem directory to walk. */
  walkRoot: string;
  /** User-facing label (config path or `<url>@<ref>`). */
  displaySourceRoot: string;
  /** Marker for the trust gradient (M7.6). */
  sourceKind: 'file' | 'git';
};

async function resolveSourceRoot(
  source: SourceRootEntry,
  opts: DiscoveryOpts,
  warnings: string[],
): Promise<ResolvedRoot | null> {
  if (source.kind === 'git') {
    const display = source.ref ? `${source.url}@${source.ref}` : source.url;
    try {
      const result = await resolveGitSource(
        { url: source.url, ref: source.ref },
        { cacheDir: opts.cacheDir },
      );
      return { walkRoot: result.localPath, displaySourceRoot: display, sourceKind: 'git' };
    } catch (err) {
      warnings.push(`git source ${display}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
  if (source.kind === 'catalogue') {
    // Catalogue sources don't participate in the path-walking discovery
    // pipeline — their packages are surfaced via the Catalogue
    // interface (M13.3 wires `hex list` / `browse` / `search` through
    // it). Skip them here so a config that mixes the two doesn't drop
    // the path / git sources.
    return null;
  }
  return { walkRoot: source.path, displaySourceRoot: source.path, sourceKind: 'file' };
}

async function walkSourceRoot(
  root: ResolvedRoot,
  templates: TemplateEntry[],
  seenNames: Map<string, TemplateEntry>,
  warnings: string[],
): Promise<void> {
  const { walkRoot, displaySourceRoot, sourceKind } = root;

  let rootStat: Awaited<ReturnType<typeof stat>>;
  try {
    rootStat = await stat(walkRoot);
  } catch {
    warnings.push(`source root not found: ${displaySourceRoot}`);
    return;
  }
  if (!rootStat.isDirectory()) {
    warnings.push(`source root is not a directory: ${displaySourceRoot}`);
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(walkRoot);
  } catch (err) {
    warnings.push(
      `cannot read source root ${displaySourceRoot}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  for (const entry of entries) {
    const childPath = join(walkRoot, entry);
    let childStat: Awaited<ReturnType<typeof stat>>;
    try {
      childStat = await stat(childPath);
    } catch {
      continue;
    }
    if (!childStat.isDirectory()) continue;

    const manifestPath = await findManifestFile(childPath);
    if (!manifestPath) continue;

    try {
      const manifest = await parseManifestFile(manifestPath);
      const template: TemplateEntry = {
        name: manifest.name,
        version: manifest.version,
        type: manifest.type,
        kind: manifest.kind,
        rootPath: childPath,
        sourceRoot: displaySourceRoot,
        sourceKind,
      };

      const previous = seenNames.get(manifest.name);
      if (previous) {
        warnings.push(
          `duplicate template "${manifest.name}" — keeping ${previous.rootPath}, ignoring ${childPath}`,
        );
        continue;
      }

      seenNames.set(manifest.name, template);
      templates.push(template);
    } catch (err) {
      warnings.push(`skipped ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
