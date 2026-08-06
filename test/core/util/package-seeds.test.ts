import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPackageSeeds, seedDefaults } from '../../../src/core/util/package-seeds.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-pkg-seeds-'));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('readPackageSeeds', () => {
  it('reads the four seed fields, including the author object form', async () => {
    await writeFile(
      join(work, 'package.json'),
      JSON.stringify({
        name: 'acme-portal',
        description: 'The Acme portal',
        author: { name: 'Platform Team', email: 'x@y.z' },
        license: 'MIT',
      }),
      'utf8',
    );
    expect(await readPackageSeeds(work)).toEqual({
      name: 'acme-portal',
      description: 'The Acme portal',
      author: 'Platform Team',
      license: 'MIT',
    });
  });

  it('returns {} for missing or malformed package.json and drops non-strings', async () => {
    expect(await readPackageSeeds(work)).toEqual({});
    await writeFile(join(work, 'package.json'), 'not json', 'utf8');
    expect(await readPackageSeeds(work)).toEqual({});
    await writeFile(
      join(work, 'package.json'),
      JSON.stringify({ name: 42, license: 'MIT' }),
      'utf8',
    );
    expect(await readPackageSeeds(work)).toEqual({
      name: undefined,
      description: undefined,
      author: undefined,
      license: 'MIT',
    });
  });
});

describe('seedDefaults', () => {
  it('maps seeds onto the hexify prompt-name convention, dropping absent keys', () => {
    expect(seedDefaults({ name: 'my-app', license: 'MIT' })).toEqual({
      project_name: 'my-app',
      license: 'MIT',
    });
    expect(seedDefaults({})).toEqual({});
  });
});
