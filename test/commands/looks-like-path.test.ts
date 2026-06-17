import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { looksLikePath } from '../../src/commands/new.js';

let work: string;
let prevCwd: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-llp-'));
  prevCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(prevCwd);
  await rm(work, { recursive: true, force: true });
});

describe('looksLikePath (M15.4)', () => {
  it('treats explicit path forms as paths', () => {
    expect(looksLikePath('./foo')).toBe(true);
    expect(looksLikePath('../foo')).toBe(true);
    expect(looksLikePath('/abs/foo')).toBe(true);
    expect(looksLikePath('~/foo')).toBe(true);
  });

  it('does NOT treat a qualified catalogue address as a path (the M15.4 bug)', () => {
    // `acme/api` contains `/` but must fall through to catalogue resolution.
    expect(looksLikePath('acme/api')).toBe(false);
    expect(looksLikePath('acme/api@^1.0.0')).toBe(false);
  });

  it('does NOT treat a bare template name as a path', () => {
    expect(looksLikePath('vite-ts-spa')).toBe(false);
  });

  it('treats a slashed RELATIVE path as a path only when it exists on disk', async () => {
    await mkdir(join(work, 'pkgs', 'api'), { recursive: true });
    await writeFile(join(work, 'pkgs', 'api', 'marker'), 'x', 'utf8');
    process.chdir(work);
    // Relative, contains a separator, and exists → caught by existsSync.
    expect(looksLikePath('pkgs/api')).toBe(true);
    // Relative, contains a separator, but does NOT exist → not a loadable
    // path, so it falls through to discovery/catalogue (the M15.4 fix:
    // a slash alone is not a path signal).
    expect(looksLikePath('pkgs/missing')).toBe(false);
  });
});
