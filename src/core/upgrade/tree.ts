import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Tree helpers shared by the upgrade engine's on-disk copies — the
 * `--abort` backup (`.hex/upgrade-backup/`) and the pristine baseline
 * (`.hex/pristine/`).
 */

/**
 * Top-level directories never copied, merged, or rolled back. `.hex/` is
 * Hex's own metadata (lockfile, checklist, backup, baseline); `.git/` and
 * `node_modules/` are not part of the rendered artifact. The same set the
 * lockfile's `hashTree` skips, so every view of the tree agrees on what
 * the template owns.
 */
export const PROTECTED = new Set(['.hex', '.git', 'node_modules']);

/** Relative POSIX paths of every file under `dir`, skipping `PROTECTED` roots. */
export async function collectTreeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (prefix === '' && PROTECTED.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
    // symlinks / special files are intentionally skipped
  }
  await walk(dir, '');
  return out;
}

/**
 * Copy every file `collectTreeFiles` sees under `src` into `dest`.
 *
 * File by file rather than one `cp -r`: both callers write *into* a
 * subdirectory of their own source (`.hex/…` inside the app root), and
 * `cp` refuses a destination nested in its source.
 */
export async function copyTreeInto(src: string, dest: string): Promise<void> {
  for (const rel of await collectTreeFiles(src)) {
    const target = join(dest, rel);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(src, rel), target);
  }
}
