import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectFs, ProjectFsError } from '../../../src/core/hooks/project-fs.js';

let work: string;
let outside: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-project-fs-'));
  outside = await mkdtemp(join(tmpdir(), 'hex-project-fs-outside-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('ProjectFs', () => {
  describe('happy paths', () => {
    it('read returns file content', async () => {
      await writeFile(join(work, 'a.txt'), 'hello', 'utf8');
      const fs = new ProjectFs(work);
      expect(fs.read('a.txt')).toBe('hello');
    });

    it('write creates parent directories', () => {
      const fs = new ProjectFs(work);
      fs.write('nested/deeper/b.txt', 'world');
      expect(existsSync(join(work, 'nested/deeper/b.txt'))).toBe(true);
    });

    it('write content round-trips through read', () => {
      const fs = new ProjectFs(work);
      fs.write('round.txt', 'trip');
      expect(fs.read('round.txt')).toBe('trip');
    });

    it('delete removes a file', async () => {
      await writeFile(join(work, 'gone.txt'), '', 'utf8');
      const fs = new ProjectFs(work);
      fs.delete('gone.txt');
      expect(existsSync(join(work, 'gone.txt'))).toBe(false);
    });

    it('delete recursively removes a directory', async () => {
      await mkdir(join(work, 'dir'), { recursive: true });
      await writeFile(join(work, 'dir/inside.txt'), '', 'utf8');
      const fs = new ProjectFs(work);
      fs.delete('dir');
      expect(existsSync(join(work, 'dir'))).toBe(false);
    });

    it('delete on a missing path is a no-op', () => {
      const fs = new ProjectFs(work);
      expect(() => fs.delete('not-there.txt')).not.toThrow();
    });

    it('exists distinguishes present from absent', async () => {
      await writeFile(join(work, 'here.txt'), '', 'utf8');
      const fs = new ProjectFs(work);
      expect(fs.exists('here.txt')).toBe(true);
      expect(fs.exists('not-here.txt')).toBe(false);
    });

    it('list returns directory entries', async () => {
      await mkdir(join(work, 'subdir'), { recursive: true });
      await writeFile(join(work, 'subdir/x.txt'), '', 'utf8');
      await writeFile(join(work, 'subdir/y.txt'), '', 'utf8');
      const fs = new ProjectFs(work);
      expect(fs.list('subdir').sort()).toEqual(['x.txt', 'y.txt']);
    });

    it('list at root works with "."', () => {
      const fs = new ProjectFs(work);
      fs.write('a', '');
      fs.write('b', '');
      expect(fs.list('.').sort()).toEqual(['a', 'b']);
    });

    it('list throws if target is not a directory', async () => {
      await writeFile(join(work, 'file.txt'), '', 'utf8');
      const fs = new ProjectFs(work);
      expect(() => fs.list('file.txt')).toThrow(ProjectFsError);
    });
  });

  describe('path guard', () => {
    it('rejects absolute paths', () => {
      const fs = new ProjectFs(work);
      expect(() => fs.read('/etc/passwd')).toThrow(/absolute paths are not allowed/);
      expect(() => fs.write('/tmp/x', 'y')).toThrow(/absolute paths are not allowed/);
      expect(() => fs.exists('/anything')).toThrow(/absolute paths are not allowed/);
    });

    it('rejects "../" traversal escaping the root', () => {
      const fs = new ProjectFs(work);
      expect(() => fs.read('../escape.txt')).toThrow(/escapes project root/);
    });

    it('rejects multi-segment traversal that lands outside via "/.."', () => {
      const fs = new ProjectFs(work);
      fs.write('legit/a.txt', 'ok');
      expect(() => fs.read('legit/../../outside.txt')).toThrow(/escapes project root/);
    });

    it('rejects a symlink that points outside the root', async () => {
      await writeFile(join(outside, 'secret.txt'), 'top secret', 'utf8');
      await symlink(outside, join(work, 'escape'));
      const fs = new ProjectFs(work);
      expect(() => fs.read('escape/secret.txt')).toThrow(/escapes project root/);
    });

    it('rejects writing through a symlink that points outside the root', async () => {
      await symlink(outside, join(work, 'escape'));
      const fs = new ProjectFs(work);
      expect(() => fs.write('escape/sneaky.txt', 'planted')).toThrow(/escapes project root/);
    });

    it('rejects empty path', () => {
      const fs = new ProjectFs(work);
      expect(() => fs.read('')).toThrow(/path cannot be empty/);
    });

    it('rejects non-string path', () => {
      const fs = new ProjectFs(work);
      expect(() => fs.read(123 as unknown as string)).toThrow(/path must be a string/);
    });

    it('write rejects non-string content', () => {
      const fs = new ProjectFs(work);
      expect(() => fs.write('a.txt', 42 as unknown as string)).toThrow(/content must be a string/);
    });
  });

  describe('construction', () => {
    it('throws if the root does not exist', () => {
      expect(() => new ProjectFs(join(work, 'does-not-exist'))).toThrow(
        /project root does not exist/,
      );
    });

    it('canonicalises the root via realpath so symlinked roots still work', async () => {
      const real = await mkdtemp(join(tmpdir(), 'hex-pfs-real-'));
      const linked = join(work, 'aliased');
      await symlink(real, linked);
      await writeFile(join(real, 'r.txt'), 'real', 'utf8');
      try {
        const fs = new ProjectFs(linked);
        expect(fs.read('r.txt')).toBe('real');
      } finally {
        await rm(real, { recursive: true, force: true });
      }
    });
  });
});
