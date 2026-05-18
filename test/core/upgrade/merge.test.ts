import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeTrees, threeWayMerge } from '../../../src/core/upgrade/merge.js';
import {
  UpgradeStateError,
  clearUpgradeState,
  readUpgradeState,
  writeUpgradeState,
} from '../../../src/core/upgrade/state.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-merge-test-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** Materialise a tree from a path→content map and return its directory. */
async function makeTree(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(work, name);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

async function read(dir: string, rel: string): Promise<string> {
  return readFile(join(dir, rel), 'utf8');
}

describe('threeWayMerge', () => {
  it('merges a non-conflicting change cleanly', () => {
    const base = 'line1\nline2\nline3\n';
    const ours = 'line1\nline2\nline3\n'; // user untouched
    const theirs = 'line1\nCHANGED\nline3\n';
    const result = threeWayMerge(base, ours, theirs);
    expect(result.clean).toBe(true);
    expect(result.content).toBe(theirs);
  });

  it('emits git-style conflict markers when both sides changed the same lines', () => {
    const base = 'line1\nbase\nline3\n';
    const ours = 'line1\nMINE\nline3\n';
    const theirs = 'line1\nTHEIRS\nline3\n';
    const result = threeWayMerge(base, ours, theirs, { ours: 'your changes', theirs: 'hex 2.0.0' });
    expect(result.clean).toBe(false);
    expect(result.content).toContain('<<<<<<< your changes');
    expect(result.content).toContain('=======');
    expect(result.content).toContain('>>>>>>> hex 2.0.0');
    expect(result.content).toContain('MINE');
    expect(result.content).toContain('THEIRS');
    // git's default style — no `|||||||` base section.
    expect(result.content).not.toContain('|||||||');
  });
});

describe('mergeTrees — clean apply', () => {
  it('applies adds, clean updates, and deletes without conflicts', async () => {
    const pristineOld = await makeTree('old', {
      'keep.txt': 'unchanged\n',
      'update.txt': 'v1\n',
      'gone.txt': 'remove me\n',
    });
    const pristineNew = await makeTree('new', {
      'keep.txt': 'unchanged\n',
      'update.txt': 'v2\n',
      'fresh.txt': 'brand new\n',
    });
    const userTree = await makeTree('user', {
      'keep.txt': 'unchanged\n',
      'update.txt': 'v1\n', // user never edited it
      'gone.txt': 'remove me\n', // user never edited it
    });

    const result = await mergeTrees({ pristineOld, pristineNew, userTree });

    expect(result.clean).toBe(true);
    expect(result.conflicted).toEqual([]);
    expect(result.added).toEqual(['fresh.txt']);
    expect(result.merged).toEqual(['update.txt']);
    expect(result.deleted).toEqual(['gone.txt']);
    expect(result.unchanged).toEqual(['keep.txt']);

    expect(await read(userTree, 'update.txt')).toBe('v2\n');
    expect(await read(userTree, 'fresh.txt')).toBe('brand new\n');
    expect(existsSync(join(userTree, 'gone.txt'))).toBe(false);
  });

  it('preserves a user edit the template did not touch', async () => {
    const pristineOld = await makeTree('old', { 'a.txt': 'original\n' });
    const pristineNew = await makeTree('new', { 'a.txt': 'original\n' });
    const userTree = await makeTree('user', { 'a.txt': 'USER EDITED\n' });

    const result = await mergeTrees({ pristineOld, pristineNew, userTree });
    expect(result.clean).toBe(true);
    expect(result.unchanged).toEqual(['a.txt']);
    expect(await read(userTree, 'a.txt')).toBe('USER EDITED\n');
  });

  it('3-way merges a user edit with a non-overlapping template change', async () => {
    const pristineOld = await makeTree('old', { 'a.txt': 'top\nmiddle\nbottom\n' });
    const pristineNew = await makeTree('new', { 'a.txt': 'TOP\nmiddle\nbottom\n' });
    const userTree = await makeTree('user', { 'a.txt': 'top\nmiddle\nBOTTOM\n' });

    const result = await mergeTrees({ pristineOld, pristineNew, userTree });
    expect(result.clean).toBe(true);
    expect(result.merged).toEqual(['a.txt']);
    expect(await read(userTree, 'a.txt')).toBe('TOP\nmiddle\nBOTTOM\n');
  });
});

describe('mergeTrees — conflicts', () => {
  it('writes conflict markers and reports the file as conflicted', async () => {
    const pristineOld = await makeTree('old', { 'a.txt': 'line1\nbase\nline3\n' });
    const pristineNew = await makeTree('new', { 'a.txt': 'line1\nfrom-template\nline3\n' });
    const userTree = await makeTree('user', { 'a.txt': 'line1\nfrom-user\nline3\n' });

    const result = await mergeTrees({
      pristineOld,
      pristineNew,
      userTree,
      theirsLabel: 'hex 2.0.0',
    });

    expect(result.clean).toBe(false);
    expect(result.conflicted).toEqual(['a.txt']);
    const merged = await read(userTree, 'a.txt');
    expect(merged).toContain('<<<<<<<');
    expect(merged).toContain('>>>>>>> hex 2.0.0');
    expect(merged).toContain('from-user');
    expect(merged).toContain('from-template');
  });

  it('keeps a user-edited file the template removed (orphan)', async () => {
    const pristineOld = await makeTree('old', { 'doomed.txt': 'generated\n' });
    const pristineNew = await makeTree('new', {});
    const userTree = await makeTree('user', { 'doomed.txt': 'I EDITED THIS\n' });

    const result = await mergeTrees({ pristineOld, pristineNew, userTree });
    expect(result.deleted).toEqual([]);
    expect(result.orphaned).toEqual(['doomed.txt']);
    expect(existsSync(join(userTree, 'doomed.txt'))).toBe(true);
  });

  it('deletes an orphan when the onOrphan callback elects to', async () => {
    const pristineOld = await makeTree('old', { 'doomed.txt': 'generated\n' });
    const pristineNew = await makeTree('new', {});
    const userTree = await makeTree('user', { 'doomed.txt': 'I EDITED THIS\n' });

    const result = await mergeTrees({
      pristineOld,
      pristineNew,
      userTree,
      onOrphan: async () => 'delete',
    });
    expect(result.orphaned).toEqual([]);
    expect(result.deleted).toEqual(['doomed.txt']);
    expect(existsSync(join(userTree, 'doomed.txt'))).toBe(false);
  });

  it('never touches the .hex/ metadata folder', async () => {
    const pristineOld = await makeTree('old', { 'a.txt': 'v1\n' });
    const pristineNew = await makeTree('new', { 'a.txt': 'v2\n' });
    const userTree = await makeTree('user', {
      'a.txt': 'v1\n',
      '.hex/lockfile.yaml': 'schema_version: 1\n',
    });

    const result = await mergeTrees({ pristineOld, pristineNew, userTree });
    expect([...result.added, ...result.deleted, ...result.merged]).not.toContain(
      '.hex/lockfile.yaml',
    );
    expect(await read(userTree, '.hex/lockfile.yaml')).toBe('schema_version: 1\n');
  });
});

describe('upgrade state file', () => {
  it('round-trips through write and read', async () => {
    const rootDir = await makeTree('app', { 'a.txt': 'x\n' });
    const path = await writeUpgradeState(rootDir, {
      schema_version: 1,
      from: '1.0.0',
      to: '2.0.0',
      conflicts: ['src/index.ts', 'package.json'],
    });
    expect(path).toBe(join(rootDir, '.hex', 'upgrade-state.yaml'));

    const state = await readUpgradeState(rootDir);
    expect(state).toEqual({
      schema_version: 1,
      from: '1.0.0',
      to: '2.0.0',
      conflicts: ['src/index.ts', 'package.json'],
      user_tree_changes: [],
      orphans: [],
    });
  });

  it('returns null when no upgrade is in flight', async () => {
    const rootDir = await makeTree('app', { 'a.txt': 'x\n' });
    expect(await readUpgradeState(rootDir)).toBeNull();
  });

  it('clearUpgradeState removes the file — the abort path', async () => {
    const rootDir = await makeTree('app', { 'a.txt': 'x\n' });
    await writeUpgradeState(rootDir, {
      schema_version: 1,
      from: '1.0.0',
      to: '2.0.0',
      conflicts: [],
    });
    expect(await readUpgradeState(rootDir)).not.toBeNull();

    await clearUpgradeState(rootDir);
    expect(await readUpgradeState(rootDir)).toBeNull();
    // Clearing again is a harmless no-op.
    await clearUpgradeState(rootDir);
  });

  it('rejects a malformed state file', async () => {
    const rootDir = await makeTree('app', { '.hex/upgrade-state.yaml': 'from: 1.0.0\n' });
    await expect(readUpgradeState(rootDir)).rejects.toThrow(UpgradeStateError);
  });
});
