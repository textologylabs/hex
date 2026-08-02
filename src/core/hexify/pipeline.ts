import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { looksBinary, renderBundle } from '../render/engine.js';
import { walkTemplate } from '../render/walk.js';
import { loadFromPath } from '../sources/file-source.js';
import type { HexifyParam } from './substitute.js';
import { countValueOccurrences, substitutePath, substituteText } from './substitute.js';

/**
 * The hexify pipeline (Hex 2.0 / H1): scan → plan → shadow build →
 * round-trip gate → in-place apply. The ordering is the safety story:
 * the hexified template is materialised in a throwaway SHADOW dir and
 * rendered back with the original values as answers; only when that
 * render byte-matches the original tree does anything touch the repo.
 * Gate fails ⇒ zero writes — git never even needed for the undo.
 */

export type ScannedFile = {
  /** POSIX-relative path within the repo. */
  rel: string;
  /** Absolute path on disk. */
  abs: string;
  binary: boolean;
  /** UTF-8 contents — text files only. */
  text?: string;
};

/**
 * Walk the repo exactly as the render engine will walk the finished
 * template: same walker, with the would-be `.hexignore` patterns
 * injected programmatically (the file does not exist yet). Binary
 * detection uses the engine's own rule (NUL byte in the first 8 KiB).
 */
export async function scanRepo(root: string, ignorePatterns: string[]): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  for await (const f of walkTemplate(root, { extraIgnorePatterns: ignorePatterns })) {
    const data = await readFile(f.absolutePath);
    if (looksBinary(data)) {
      files.push({ rel: f.relativePath, abs: f.absolutePath, binary: true });
    } else {
      files.push({
        rel: f.relativePath,
        abs: f.absolutePath,
        binary: false,
        text: data.toString('utf8'),
      });
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return files;
}

export type OccurrenceCount = {
  /** Content hits + path hits. */
  total: number;
  /** Files with at least one content hit. */
  files: number;
  /** Paths with at least one hit. */
  paths: number;
};

export type PlanFile = {
  /** Original POSIX-relative path. */
  rel: string;
  /** Absolute path of the original file on disk. */
  abs: string;
  /** Path in the hexified template — may contain `{{ … }}`. */
  newRel: string;
  renamed: boolean;
  /** True when the hexified text differs from the original (substitution or escape-only). */
  contentChanged: boolean;
  binary: boolean;
  /** Hexified contents — text files only. */
  hexified?: string;
};

export type HexifyPlan = {
  params: HexifyParam[];
  files: PlanFile[];
  manifestYaml: string;
  hexignore: string;
  ignorePatterns: string[];
  /** Actual replacement counts per param, from the same pass that produced the files. */
  paramStats: Record<string, OccurrenceCount>;
};

/** Pure: apply the substitution engine to every scanned file. */
export function buildPlan(
  files: ScannedFile[],
  params: HexifyParam[],
  manifestYaml: string,
  hexignore: string,
  ignorePatterns: string[],
): HexifyPlan {
  const paramStats: Record<string, OccurrenceCount> = {};
  for (const p of params) paramStats[p.name] = { total: 0, files: 0, paths: 0 };

  const planFiles: PlanFile[] = files.map((f) => {
    const path = substitutePath(f.rel, params);
    for (const [name, n] of path.hits) {
      const stat = paramStats[name];
      if (stat && n > 0) {
        stat.total += n;
        stat.paths += 1;
      }
    }
    if (f.binary) {
      return {
        rel: f.rel,
        abs: f.abs,
        newRel: path.out,
        renamed: path.out !== f.rel,
        contentChanged: false,
        binary: true,
      };
    }
    const text = f.text ?? '';
    const content = substituteText(text, params);
    for (const [name, n] of content.hits) {
      const stat = paramStats[name];
      if (stat && n > 0) {
        stat.total += n;
        stat.files += 1;
      }
    }
    return {
      rel: f.rel,
      abs: f.abs,
      newRel: path.out,
      renamed: path.out !== f.rel,
      contentChanged: content.out !== text,
      binary: false,
      hexified: content.out,
    };
  });

  return { params, files: planFiles, manifestYaml, hexignore, ignorePatterns, paramStats };
}

function toNative(root: string, posixRel: string): string {
  return join(root, ...posixRel.split('/'));
}

/**
 * Materialise the complete hexified template into an empty directory:
 * every planned file at its (possibly templated) new path, plus the
 * generated `.hex/manifest.yaml` and `.hexignore`.
 */
export async function writeShadowTemplate(
  plan: HexifyPlan,
  shadowTemplateDir: string,
): Promise<void> {
  for (const f of plan.files) {
    const target = toNative(shadowTemplateDir, f.newRel);
    await mkdir(dirname(target), { recursive: true });
    if (f.binary) {
      await copyFile(f.abs, target);
    } else {
      await writeText(target, f.hexified ?? '');
    }
  }
  const hexDir = join(shadowTemplateDir, '.hex');
  await mkdir(hexDir, { recursive: true });
  await writeText(join(hexDir, 'manifest.yaml'), plan.manifestYaml);
  await writeText(join(shadowTemplateDir, '.hexignore'), plan.hexignore);
}

async function writeText(target: string, content: string): Promise<void> {
  await writeFile(target, content, 'utf8');
}

export type RoundTripResult = {
  ok: boolean;
  /** Files present on both sides and compared. */
  checked: number;
  /** Compared files whose bytes differ. */
  mismatched: string[];
  /** In the original tree but not the render. */
  onlyInOriginal: string[];
  /** In the render but not the original tree. */
  onlyInRendered: string[];
};

/**
 * THE gate: load the shadow template with the real source loader,
 * render it with the original values as answers, and byte-compare
 * against the original repo. Both sides are hashed via `walkTemplate`
 * so the comparison honours the same ignore filter the template will —
 * the original side gets the generated patterns injected, the rendered
 * side is already pure (its walk skips nothing extra).
 */
export async function verifyRoundTrip(
  shadowTemplateDir: string,
  originalRoot: string,
  plan: HexifyPlan,
  renderShadowDir: string,
): Promise<RoundTripResult> {
  const bundle = await loadFromPath(shadowTemplateDir, 'file');
  const answers = Object.fromEntries(plan.params.map((p) => [p.name, p.value]));
  await mkdir(renderShadowDir, { recursive: true });
  await renderBundle(bundle, renderShadowDir, answers, { force: false });

  const original = await hashViaWalk(originalRoot, plan.ignorePatterns);
  const rendered = await hashViaWalk(renderShadowDir, []);

  const mismatched: string[] = [];
  const onlyInOriginal: string[] = [];
  const onlyInRendered: string[] = [];
  let checked = 0;
  for (const [rel, sha] of original) {
    const other = rendered.get(rel);
    if (other === undefined) {
      onlyInOriginal.push(rel);
    } else {
      checked++;
      if (other !== sha) mismatched.push(rel);
    }
  }
  for (const rel of rendered.keys()) {
    if (!original.has(rel)) onlyInRendered.push(rel);
  }
  mismatched.sort();
  onlyInOriginal.sort();
  onlyInRendered.sort();
  return {
    ok: mismatched.length === 0 && onlyInOriginal.length === 0 && onlyInRendered.length === 0,
    checked,
    mismatched,
    onlyInOriginal,
    onlyInRendered,
  };
}

async function hashViaWalk(root: string, ignorePatterns: string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for await (const f of walkTemplate(root, { extraIgnorePatterns: ignorePatterns })) {
    const data = await readFile(f.absolutePath);
    hashes.set(f.relativePath, createHash('sha256').update(data).digest('hex'));
  }
  return hashes;
}

/**
 * In-place apply — called ONLY after the gate passed. Writes the
 * manifest and `.hexignore`, rewrites changed files, and performs
 * renames (write new path, remove old, prune emptied directories).
 * Untouched files are never written.
 */
export async function applyPlan(repoRoot: string, plan: HexifyPlan): Promise<void> {
  await mkdir(join(repoRoot, '.hex'), { recursive: true });
  await writeText(join(repoRoot, '.hex', 'manifest.yaml'), plan.manifestYaml);
  await writeText(join(repoRoot, '.hexignore'), plan.hexignore);

  for (const f of plan.files) {
    if (f.renamed) {
      const target = toNative(repoRoot, f.newRel);
      await mkdir(dirname(target), { recursive: true });
      if (f.binary) {
        await copyFile(f.abs, target);
      } else {
        await writeText(target, f.hexified ?? '');
      }
      await rm(f.abs, { force: true });
      await pruneEmptyAncestors(repoRoot, f.rel);
    } else if (f.contentChanged && !f.binary) {
      await writeText(toNative(repoRoot, f.rel), f.hexified ?? '');
    }
  }
}

/** Best-effort removal of directories emptied by a rename. */
async function pruneEmptyAncestors(root: string, posixRel: string): Promise<void> {
  let rel = dirname(posixRel);
  while (rel && rel !== '.' && rel !== '/') {
    const abs = join(root, ...rel.split('/'));
    try {
      const entries = await readdir(abs);
      if (entries.length > 0) return;
      await rmdir(abs);
    } catch {
      return;
    }
    rel = dirname(rel);
  }
}

/**
 * Count what a single candidate value would hit across the scanned
 * tree — shown to the user BEFORE they confirm the parameter. Uses the
 * same boundary rules as the substitution itself.
 */
export function countOccurrencesAcross(files: ScannedFile[], value: string): OccurrenceCount {
  let total = 0;
  let inFiles = 0;
  let inPaths = 0;
  for (const f of files) {
    const pathHits = countValueOccurrences(f.rel, value);
    if (pathHits > 0) {
      inPaths++;
      total += pathHits;
    }
    if (!f.binary) {
      const contentHits = countValueOccurrences(f.text ?? '', value);
      if (contentHits > 0) {
        inFiles++;
        total += contentHits;
      }
    }
  }
  return { total, files: inFiles, paths: inPaths };
}
