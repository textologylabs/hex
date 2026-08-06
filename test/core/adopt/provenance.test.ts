import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProvenanceError,
  materialiseRef,
  resolveProvenanceRef,
  splitEdited,
} from '../../../src/core/adopt/provenance.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('splitEdited', () => {
  const m = (entries: Record<string, string>): Map<string, string> =>
    new Map(Object.entries(entries));

  it('classifies the four cases: yours, stale, collided, absent-at-ref', () => {
    const edited = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    const split = splitEdited(
      edited,
      // ref tree: a matches template (team later changed it), b matches
      // HEAD (team never touched; template moved), c matches neither
      // (both moved), d absent (team introduced it post-copy).
      m({ 'a.ts': 'T', 'b.ts': 'H', 'c.ts': 'R' }),
      m({ 'a.ts': 'H1', 'b.ts': 'H', 'c.ts': 'H2', 'd.ts': 'H3' }),
      m({ 'a.ts': 'T', 'b.ts': 'T1', 'c.ts': 'T2', 'd.ts': 'T3' }),
    );
    expect(split).toEqual({
      editedByYou: ['a.ts', 'd.ts'],
      stale: ['b.ts'],
      collided: ['c.ts'],
    });
  });

  it('returns empty groups for an empty edited list and sorts outputs', () => {
    expect(splitEdited([], m({}), m({}), m({}))).toEqual({
      editedByYou: [],
      stale: [],
      collided: [],
    });
    const split = splitEdited(
      ['z.ts', 'a.ts'],
      m({ 'z.ts': 'T', 'a.ts': 'T' }),
      m({ 'z.ts': 'H', 'a.ts': 'H' }),
      m({ 'z.ts': 'T', 'a.ts': 'T' }),
    );
    expect(split.editedByYou).toEqual(['a.ts', 'z.ts']);
  });
});

describe('resolveProvenanceRef / materialiseRef (real git)', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'hex-provenance-'));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  async function scratchRepo(): Promise<string> {
    const repo = join(work, 'repo');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'index.ts'), 'v1\n', 'utf8');
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.email', 't@e.c');
    await git(repo, 'config', 'user.name', 't');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'first');
    await writeFile(join(repo, 'src', 'index.ts'), 'v2\n', 'utf8');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'second');
    return repo;
  }

  it('defaults to the root commit and materialises its tree', async () => {
    const repo = await scratchRepo();
    const resolved = await resolveProvenanceRef(repo, undefined);
    expect(resolved.ref).toBe('root commit');
    expect(resolved.sha).toBe(await git(repo, 'rev-list', '--max-parents=0', 'HEAD'));

    const dest = join(work, 'dest');
    await mkdir(dest, { recursive: true });
    const tree = await materialiseRef(repo, resolved.sha, dest);
    // The root commit's content, not HEAD's.
    expect(await readFile(join(tree, 'src', 'index.ts'), 'utf8')).toBe('v1\n');
  });

  it('materialises blobs as stored regardless of core.autocrlf (the Windows default)', async () => {
    const repo = await scratchRepo();
    // Reproduce the Windows-runner condition on any OS: with
    // autocrlf=true, `git archive` would CRLF-convert text output.
    await git(repo, 'config', 'core.autocrlf', 'true');
    const resolved = await resolveProvenanceRef(repo, undefined);
    const dest = join(work, 'dest-crlf');
    await mkdir(dest, { recursive: true });
    const tree = await materialiseRef(repo, resolved.sha, dest);
    expect(await readFile(join(tree, 'src', 'index.ts'), 'utf8')).toBe('v1\n');
  });

  it('resolves an explicit ref and rejects a bogus one', async () => {
    const repo = await scratchRepo();
    const head = await resolveProvenanceRef(repo, 'HEAD');
    expect(head.ref).toBe('HEAD');
    expect(head.sha).toBe(await git(repo, 'rev-parse', 'HEAD'));

    await expect(resolveProvenanceRef(repo, 'no-such-ref')).rejects.toThrowError(ProvenanceError);
  });

  it('fails with ProvenanceError outside a git repository', async () => {
    const plain = join(work, 'plain');
    await mkdir(plain, { recursive: true });
    await expect(resolveProvenanceRef(plain, undefined)).rejects.toThrowError(ProvenanceError);
  });
});
