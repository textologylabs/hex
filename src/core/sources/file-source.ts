import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseManifestFile } from '../manifest/parse.js';
import type { Manifest } from '../manifest/types.js';

export type ComponentBundle = {
  manifest: Manifest;
  rootPath: string;
  /**
   * Source text of every JS hook the manifest references, keyed by the
   * filename declared in `hooks.<lifecycle>[i].js`. Populated eagerly at
   * load time so the render pipeline can hand strings straight to the
   * sandbox without re-reading from disk.
   */
  jsHookSources: Record<string, string>;
};

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

export const MANIFEST_CANDIDATES = ['manifest.yaml', 'manifest.yml'];

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate `.hex/manifest.{yaml,yml}` under a candidate template root,
 * returning the first match. Exported so the discovery walker can reuse
 * the candidate-file logic.
 */
export async function findManifestFile(rootPath: string): Promise<string | null> {
  for (const name of MANIFEST_CANDIDATES) {
    const candidate = join(rootPath, '.hex', name);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

async function findManifest(rootPath: string): Promise<string> {
  const found = await findManifestFile(rootPath);
  if (found) return found;
  throw new SourceError(
    `no manifest found in ${rootPath}/.hex/ — expected one of: ${MANIFEST_CANDIDATES.join(', ')}`,
  );
}

/**
 * Load a component bundle from a local filesystem path.
 *
 * The path must be an existing directory containing `.hex/manifest.yaml`.
 */
export async function loadFromPath(path: string): Promise<ComponentBundle> {
  const rootPath = isAbsolute(path) ? path : resolve(process.cwd(), path);

  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(rootPath);
  } catch {
    throw new SourceError(`template path does not exist: ${rootPath}`);
  }
  if (!s.isDirectory()) {
    throw new SourceError(`template path is not a directory: ${rootPath}`);
  }

  const manifestPath = await findManifest(rootPath);
  const manifest = await parseManifestFile(manifestPath);
  const jsHookSources = await loadJsHookSources(rootPath, manifest);
  return { manifest, rootPath, jsHookSources };
}

/**
 * Read every JS hook file referenced by the manifest into memory.
 *
 * Hooks live at `<rootPath>/.hex/hooks/<filename>`. The schema already
 * forbids subdirectories and `..` in the declared filename, so a simple
 * `join` is sufficient — no extra traversal check needed here.
 *
 * Missing files are an *authoring* error and abort the load with a
 * message that names the lifecycle, filename, and expected path so a
 * template author can fix it without grep-hunting the manifest.
 */
async function loadJsHookSources(
  rootPath: string,
  manifest: Manifest,
): Promise<Record<string, string>> {
  const lifecycleEntries: Array<{ lifecycle: 'pre_render' | 'post_render'; filename: string }> = [];
  for (const entry of manifest.hooks?.pre_render ?? []) {
    lifecycleEntries.push({ lifecycle: 'pre_render', filename: entry.js });
  }
  for (const entry of manifest.hooks?.post_render ?? []) {
    if ('js' in entry) {
      lifecycleEntries.push({ lifecycle: 'post_render', filename: entry.js });
    }
  }

  const sources: Record<string, string> = {};
  for (const { lifecycle, filename } of lifecycleEntries) {
    if (filename in sources) continue;
    const hookPath = join(rootPath, '.hex', 'hooks', filename);
    try {
      sources[filename] = await readFile(hookPath, 'utf8');
    } catch (err) {
      const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
      throw new SourceError(
        `${lifecycle} hook "${filename}" declared in manifest but file not found at ${hookPath}${detail}`,
      );
    }
  }
  return sources;
}
