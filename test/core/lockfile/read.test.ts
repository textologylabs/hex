import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCKFILE_REL_PATH,
  type Lockfile,
  LockfileError,
  buildLockfile,
  checkLockfileIntegrity,
  readLockfileUpward,
  writeLockfile,
} from '../../../src/core/lockfile/index.js';
import type { ComponentBundle } from '../../../src/core/sources/file-source.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-lockfile-read-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeFileEnsure(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body, 'utf8');
}

/** A minimal component bundle — `buildLockfile` only reads identity + rootPath. */
function fakeBundle(): ComponentBundle {
  return {
    manifest: { type: 'component', name: 'app', version: '1.0.0' },
    rootPath: '/srv/templates/app',
    jsHookSources: {},
    sourceKind: 'file',
  };
}

/**
 * Materialise a generated-app tree with the given files and write a
 * matching lockfile into its `.hex/`. Returns the root dir + lockfile.
 */
async function makeApp(files: Record<string, string>): Promise<{
  rootDir: string;
  lockfile: Lockfile;
}> {
  const rootDir = await mkdtemp(join(work, 'app-'));
  for (const [rel, body] of Object.entries(files)) {
    await writeFileEnsure(join(rootDir, rel), body);
  }
  const lockfile = await buildLockfile({ bundle: fakeBundle(), answers: {}, outputDir: rootDir });
  await writeLockfile(rootDir, lockfile);
  return { rootDir, lockfile };
}

describe('readLockfileUpward', () => {
  it('loads a lockfile from the app root', async () => {
    const { rootDir } = await makeApp({ 'package.json': '{}\n', 'src/index.ts': 'export {};\n' });
    const loaded = await readLockfileUpward(rootDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.rootDir).toBe(rootDir);
    expect(loaded?.path).toBe(join(rootDir, LOCKFILE_REL_PATH));
    expect(loaded?.lockfile.root.name).toBe('app');
    expect(loaded?.lockfile.files.map((f) => f.path)).toEqual(['package.json', 'src/index.ts']);
  });

  it('walks upward from a nested subdirectory', async () => {
    const { rootDir } = await makeApp({ 'src/deep/nested/file.ts': 'export {};\n' });
    const loaded = await readLockfileUpward(join(rootDir, 'src', 'deep', 'nested'));
    expect(loaded?.rootDir).toBe(rootDir);
  });

  it('returns null when no lockfile exists in any ancestor', async () => {
    const bare = await mkdtemp(join(work, 'bare-'));
    expect(await readLockfileUpward(bare)).toBeNull();
  });

  it('refuses a future-version lockfile with an upgrade hint', async () => {
    const { rootDir, lockfile } = await makeApp({ 'a.txt': 'a\n' });
    // schema_version is any positive int to the schema — the *reader*
    // rejects one newer than this build supports.
    await writeLockfile(rootDir, { ...lockfile, schema_version: 99 });
    await expect(readLockfileUpward(rootDir)).rejects.toThrow(LockfileError);
    await expect(readLockfileUpward(rootDir)).rejects.toThrow(/schema_version 99.*upgrade Hex/s);
  });

  it('rejects a structurally invalid lockfile', async () => {
    const { rootDir } = await makeApp({ 'a.txt': 'a\n' });
    await writeFile(join(rootDir, LOCKFILE_REL_PATH), 'root: not-an-object\n', 'utf8');
    await expect(readLockfileUpward(rootDir)).rejects.toThrow(LockfileError);
  });
});

describe('checkLockfileIntegrity', () => {
  it('reports a clean tree as ok', async () => {
    const { rootDir, lockfile } = await makeApp({
      'package.json': '{}\n',
      'src/index.ts': 'export {};\n',
    });
    const result = await checkLockfileIntegrity(rootDir, lockfile);
    expect(result).toEqual({ ok: true, modified: [], missing: [], added: [], eolOnly: [] });
  });

  it('lists a file edited since generation as modified', async () => {
    const { rootDir, lockfile } = await makeApp({ 'a.txt': 'original\n', 'b.txt': 'b\n' });
    await writeFile(join(rootDir, 'a.txt'), 'EDITED\n', 'utf8');
    const result = await checkLockfileIntegrity(rootDir, lockfile);
    expect(result.ok).toBe(false);
    expect(result.modified).toEqual(['a.txt']);
    expect(result.missing).toEqual([]);
    expect(result.added).toEqual([]);
  });

  it('lists a recorded file removed since generation as missing', async () => {
    const { rootDir, lockfile } = await makeApp({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await rm(join(rootDir, 'b.txt'));
    const result = await checkLockfileIntegrity(rootDir, lockfile);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['b.txt']);
  });

  it('lists a file created since generation as added', async () => {
    const { rootDir, lockfile } = await makeApp({ 'a.txt': 'a\n' });
    await writeFileEnsure(join(rootDir, 'src', 'new.ts'), 'export {};\n');
    const result = await checkLockfileIntegrity(rootDir, lockfile);
    expect(result.ok).toBe(false);
    expect(result.added).toEqual(['src/new.ts']);
  });

  it('never counts the .hex/ metadata folder as a divergence', async () => {
    const { rootDir, lockfile } = await makeApp({ 'a.txt': 'a\n' });
    // The lockfile itself lives under .hex/ — it must not show as `added`.
    const result = await checkLockfileIntegrity(rootDir, lockfile);
    expect(result.added).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('checkLockfileIntegrity — CRLF tolerance (A5b)', () => {
  /** A reference tree holding the template-side bytes (LF, as rendered). */
  async function makeReference(files: Record<string, string | Buffer>): Promise<string> {
    const ref = await mkdtemp(join(work, 'ref-'));
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(join(ref, rel, '..'), { recursive: true });
      await writeFile(join(ref, rel), body);
    }
    return ref;
  }

  const LF = 'line one\nline two\n';
  const CRLF = 'line one\r\nline two\r\n';

  it('demotes a CRLF-only checkout to eolOnly when a reference tree is given', async () => {
    const { rootDir, lockfile } = await makeApp({ 'a.txt': LF, 'b.txt': 'same\n' });
    await writeFile(join(rootDir, 'a.txt'), CRLF, 'utf8');
    const reference = await makeReference({ 'a.txt': LF, 'b.txt': 'same\n' });

    const result = await checkLockfileIntegrity(rootDir, lockfile, { referenceTree: reference });
    expect(result).toEqual({ ok: true, modified: [], missing: [], added: [], eolOnly: ['a.txt'] });
  });

  it('keeps today’s behaviour without a reference tree', async () => {
    const { rootDir, lockfile } = await makeApp({ 'a.txt': LF });
    await writeFile(join(rootDir, 'a.txt'), CRLF, 'utf8');
    const result = await checkLockfileIntegrity(rootDir, lockfile);
    expect(result.modified).toEqual(['a.txt']);
    expect(result.eolOnly).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('a genuine edit stays modified even when also CRLF-converted', async () => {
    const { rootDir, lockfile } = await makeApp({ 'a.txt': LF });
    await writeFile(join(rootDir, 'a.txt'), 'line one\r\nEDITED\r\n', 'utf8');
    const reference = await makeReference({ 'a.txt': LF });
    const result = await checkLockfileIntegrity(rootDir, lockfile, { referenceTree: reference });
    expect(result.modified).toEqual(['a.txt']);
    expect(result.eolOnly).toEqual([]);
  });

  it('never normalises binaries — a 0D0A byte pair is data, not a newline', async () => {
    const rootDir = await mkdtemp(join(work, 'bin-app-'));
    await writeFile(join(rootDir, 'blob.bin'), Buffer.from([0x00, 0x0d, 0x0a, 0x42]));
    const lockfile = await buildLockfile({ bundle: fakeBundle(), answers: {}, outputDir: rootDir });
    await writeLockfile(rootDir, lockfile);
    // Project's copy differs exactly by the \r — normalised text WOULD match.
    await writeFile(join(rootDir, 'blob.bin'), Buffer.from([0x00, 0x0a, 0x42]));
    const reference = await makeReference({ 'blob.bin': Buffer.from([0x00, 0x0d, 0x0a, 0x42]) });
    const result = await checkLockfileIntegrity(rootDir, lockfile, { referenceTree: reference });
    expect(result.modified).toEqual(['blob.bin']);
    expect(result.eolOnly).toEqual([]);
  });

  it('a file absent from the reference tree stays modified', async () => {
    const { rootDir, lockfile } = await makeApp({ 'a.txt': LF });
    await writeFile(join(rootDir, 'a.txt'), CRLF, 'utf8');
    const reference = await makeReference({});
    const result = await checkLockfileIntegrity(rootDir, lockfile, { referenceTree: reference });
    expect(result.modified).toEqual(['a.txt']);
  });
});
