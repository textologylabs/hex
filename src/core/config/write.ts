import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type YAMLSeq, parseDocument } from 'yaml';
import { writeFileAtomic } from '../util/atomic.js';
import { type LoadConfigOpts, getDefaultConfigPath } from './load.js';

/**
 * Mutating writes to `~/.hex/config.yaml` (M15.1). `hex hive add` /
 * `hex hive remove` go through here so a user never has to hand-edit the
 * config — the audit's A6 gap. We operate on the parsed YAML *document*
 * (not a parse → re-stringify of a plain object) so any comments and
 * formatting the user keeps in their config survive the round-trip; only
 * the `sources:` sequence is touched.
 */

export type NewSource =
  | { kind: 'path'; path: string }
  | { kind: 'git'; url: string; ref?: string }
  | { kind: 'catalogue'; url: string; ref?: string };

/** `added: false` means an equivalent entry was already present (no-op). */
export type AddSourceResult = { added: boolean; configPath: string };
/** `removed` is how many `sources:` entries matched and were dropped. */
export type RemoveSourceResult = { removed: number; configPath: string };

/** The identifier a source is matched on for dedup / removal. */
function sourceIdentifier(entry: NewSource): string {
  return entry.kind === 'path' ? entry.path : entry.url;
}

/** The identifier of an on-disk wire entry (`{path}` / `{git}` / `{catalogue}`). */
function wireIdentifier(item: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'git', 'catalogue'] as const) {
    const value = item[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** Build the wire shape (`schema.ts`) for a new source entry. */
function toWireEntry(entry: NewSource): Record<string, string> {
  if (entry.kind === 'path') return { path: entry.path };
  const key = entry.kind === 'git' ? 'git' : 'catalogue';
  return entry.ref ? { [key]: entry.url, ref: entry.ref } : { [key]: entry.url };
}

/** True if an on-disk wire entry is the same source we'd be adding. */
function sameEntry(item: Record<string, unknown>, entry: NewSource): boolean {
  const wire = toWireEntry(entry);
  const keys = new Set([...Object.keys(item), ...Object.keys(wire)]);
  for (const k of keys) {
    if (item[k] !== wire[k]) return false;
  }
  return true;
}

async function readDocument(configPath: string): Promise<ReturnType<typeof parseDocument>> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return parseDocument('sources: []\n');
    throw err;
  }
  const doc = parseDocument(raw);
  // An empty / null document still needs a `sources:` seq to write into.
  if (doc.get('sources') === undefined) doc.set('sources', []);
  return doc;
}

function sourcesSeq(doc: ReturnType<typeof parseDocument>): YAMLSeq {
  let seq = doc.get('sources') as YAMLSeq | undefined;
  if (!seq || !('items' in seq)) {
    doc.set('sources', []);
    seq = doc.get('sources') as YAMLSeq;
  }
  // Force block style — a freshly-seeded `sources: []` parses as a flow
  // seq, which would render new entries inline (`[ { ... } ]`); block is
  // the convention every example + the existing configs use.
  seq.flow = false;
  return seq;
}

/**
 * Add a source to `config.yaml`. Idempotent — if an identical entry
 * already exists, nothing is written and `added` is `false`. The config
 * directory is created if it doesn't exist yet (first run).
 */
export async function addSource(entry: NewSource, opts?: LoadConfigOpts): Promise<AddSourceResult> {
  const configPath = getDefaultConfigPath(opts);
  const doc = await readDocument(configPath);
  const seq = sourcesSeq(doc);

  const exists = seq.items.some((item) => {
    const js = (item as { toJSON(): unknown }).toJSON();
    return js !== null && typeof js === 'object' && sameEntry(js as Record<string, unknown>, entry);
  });
  if (exists) return { added: false, configPath };

  seq.add(toWireEntry(entry));
  await mkdir(dirname(configPath), { recursive: true });
  await writeFileAtomic(configPath, String(doc));
  return { added: true, configPath };
}

/**
 * Remove every source whose identifier (the `path` / `git` / `catalogue`
 * value) equals `identifier`, regardless of kind or `ref`. Returns how
 * many entries were dropped (`0` = nothing matched, no write performed).
 */
export async function removeSource(
  identifier: string,
  opts?: LoadConfigOpts,
): Promise<RemoveSourceResult> {
  const configPath = getDefaultConfigPath(opts);
  const doc = await readDocument(configPath);
  const seq = sourcesSeq(doc);

  const kept = seq.items.filter((item) => {
    const js = (item as { toJSON(): unknown }).toJSON();
    if (js === null || typeof js !== 'object') return true;
    return wireIdentifier(js as Record<string, unknown>) !== identifier;
  });
  const removed = seq.items.length - kept.length;
  if (removed === 0) return { removed: 0, configPath };

  seq.items = kept;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFileAtomic(configPath, String(doc));
  return { removed, configPath };
}

/** `added: false` means the source was already trusted (no-op). */
export type TrustSourceResult = { added: boolean; configPath: string };

/**
 * Add `identifier` to `trust.sources` in `config.yaml` (M15.3),
 * vouching for a remote source so its `run:` setup tasks may auto-run.
 * Idempotent — an already-trusted source is a no-op. Creates the
 * `trust:` map and `sources:` sequence if they don't exist yet.
 */
export async function trustSource(
  identifier: string,
  opts?: LoadConfigOpts,
): Promise<TrustSourceResult> {
  const configPath = getDefaultConfigPath(opts);
  const doc = await readDocument(configPath);

  const current = doc.getIn(['trust', 'sources']) as YAMLSeq | undefined;
  const existing =
    current && typeof (current as { toJSON?: () => unknown }).toJSON === 'function'
      ? (current.toJSON() as unknown)
      : [];
  if (Array.isArray(existing) && existing.includes(identifier)) {
    return { added: false, configPath };
  }

  if (current && 'items' in current) {
    current.flow = false;
    current.add(identifier);
  } else {
    doc.setIn(['trust', 'sources'], [identifier]);
    const seq = doc.getIn(['trust', 'sources']) as YAMLSeq | undefined;
    if (seq && 'flow' in seq) seq.flow = false;
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFileAtomic(configPath, String(doc));
  return { added: true, configPath };
}

export { sourceIdentifier };
