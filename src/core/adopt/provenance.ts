import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { extract } from 'tar';

/**
 * Provenance materialisation for `hex adopt --provenance` (Hex 2.0 /
 * A7 — the Captain's three-trees insight): the adopting project's own
 * git history holds the state it was copied in, so materialising an
 * early ref gives a third tree that splits the fit report's mushy
 * "edited" bucket into honest causes — the team changed it, the
 * template moved on, or both.
 *
 * ADVISORY by design: teams squash, or commit their first tweaks
 * together with the copy, so the ref is a hint, never trusted truth.
 * Nothing here influences what adopt writes.
 */
export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceError';
  }
}

const execFileAsync = promisify(execFile);

async function git(projectRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectRoot, ...args], {
      env: process.env,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = e.stderr?.trim() || e.message || String(err);
    throw new ProvenanceError(`git ${args.join(' ')} failed: ${detail}`);
  }
}

/**
 * Resolve the provenance ref to a commit sha. An explicit ref is
 * validated as-is; without one the default is the instance's ROOT
 * commit — the oldest state its history records, closest to the
 * moment of the hand-copy.
 */
export async function resolveProvenanceRef(
  projectRoot: string,
  ref: string | undefined,
): Promise<{ ref: string; sha: string }> {
  if (ref !== undefined) {
    const sha = (await git(projectRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    return { ref, sha };
  }
  const roots = (await git(projectRoot, ['rev-list', '--max-parents=0', '--reverse', 'HEAD']))
    .trim()
    .split('\n')
    .filter((l) => l !== '');
  const sha = roots[0];
  if (!sha) throw new ProvenanceError('no root commit found — is the history empty?');
  return { ref: 'root commit', sha };
}

/**
 * Materialise `sha`'s tree into `destDir/tree` via `git archive` + the
 * tar package (no shell tar). The result carries no `.git`, so hashing
 * it compares apples-to-apples with the working tree walk (which skips
 * `.git` itself).
 */
export async function materialiseRef(
  projectRoot: string,
  sha: string,
  destDir: string,
): Promise<string> {
  const tarPath = join(destDir, 'ref.tar');
  const treeDir = join(destDir, 'tree');
  await mkdir(treeDir, { recursive: true });
  // Suppress end-of-line conversion: with core.autocrlf=true (the
  // Git-for-Windows default) `git archive` would emit CRLF for text
  // files, making every hash differ from the LF blobs and misclassifying
  // the whole tree as "touched".
  await git(projectRoot, [
    '-c',
    'core.autocrlf=false',
    'archive',
    '--format=tar',
    '-o',
    tarPath,
    sha,
  ]);
  try {
    await extract({ file: tarPath, cwd: treeDir });
  } catch (err) {
    throw new ProvenanceError(
      `extracting ${sha} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return treeDir;
}

export type ProvenanceSplit = {
  /** The team changed it; the template did not move — a true user edit. */
  editedByYou: string[];
  /** The team never touched it; the template improved — upgrade refreshes it. */
  stale: string[];
  /** Both moved — the genuine future merge conflicts, known up front. */
  collided: string[];
};

/**
 * Split the fit report's `edited` paths (instance@HEAD ≠ template
 * render, by construction) using the third tree. Per path:
 * touched = ref≠HEAD, moved = ref≠template. A path absent at the ref
 * was introduced by the team after the copy — edited-by-you.
 * Pure — three hash maps in, three sorted lists out.
 */
export function splitEdited(
  edited: string[],
  refHashes: Map<string, string>,
  headHashes: Map<string, string>,
  templateHashes: Map<string, string>,
): ProvenanceSplit {
  const editedByYou: string[] = [];
  const stale: string[] = [];
  const collided: string[] = [];
  for (const path of edited) {
    const ref = refHashes.get(path);
    if (ref === undefined) {
      editedByYou.push(path);
      continue;
    }
    const touched = ref !== headHashes.get(path);
    const moved = ref !== templateHashes.get(path);
    if (touched && moved) collided.push(path);
    else if (touched) editedByYou.push(path);
    else stale.push(path);
  }
  editedByYou.sort();
  stale.sort();
  collided.sort();
  return { editedByYou, stale, collided };
}
