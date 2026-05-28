import { describe, expect, it } from 'vitest';
import {
  LOCKFILE_SCHEMA_VERSION,
  type LockChild,
  type Lockfile,
  lockfileSchema,
} from '../../../src/core/lockfile/index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** A valid composed child — the baseline for child-level cases. */
function validChild(): LockChild {
  return {
    key: 'api',
    name: 'hex/api-fastify',
    version: '0.1.0',
    type: 'component',
    stub: false,
    source: {
      kind: 'marketplace',
      registry: 'https://registry.hex.dev/',
      name: 'api-fastify',
    },
  };
}

/** A complete, valid recipe lockfile, with optional field overrides. */
function validRecipeLockfile(overrides: Partial<Lockfile> = {}): Lockfile {
  return {
    schema_version: LOCKFILE_SCHEMA_VERSION,
    hex_version: '0.7.0',
    generated_at: '2026-05-17T09:00:00.000Z',
    root: {
      name: 'hex/node-ts-fullstack',
      version: '0.1.0',
      type: 'recipe',
      source: {
        kind: 'marketplace',
        registry: 'https://registry.hex.dev/',
        name: 'node-ts-fullstack',
      },
    },
    children: [validChild()],
    answers: { app_name: 'my-app', api: { port: 3000 } },
    files: [
      { path: 'package.json', sha256: HASH_A },
      { path: 'api/src/index.ts', sha256: HASH_B },
    ],
    ...overrides,
  };
}

describe('lockfileSchema — shape', () => {
  it('accepts a complete recipe lockfile', () => {
    expect(lockfileSchema.safeParse(validRecipeLockfile()).success).toBe(true);
  });

  it('accepts a standalone component — a root with no children', () => {
    const lock = validRecipeLockfile({
      root: {
        name: 'db-postgres',
        version: '2.0.0',
        type: 'component',
        source: { kind: 'file', path: '/srv/templates/db-postgres' },
      },
      children: [],
    });
    expect(lockfileSchema.safeParse(lock).success).toBe(true);
  });

  it('accepts every source-spec variant', () => {
    for (const source of [
      { kind: 'file', path: '/templates/x' },
      { kind: 'git', url: 'https://github.com/acme/x.git', ref: 'v1' },
      { kind: 'git', url: 'https://github.com/acme/x.git' },
      { kind: 'marketplace', registry: 'https://registry.hex.dev/', name: 'x' },
    ] as const) {
      const lock = validRecipeLockfile({
        root: { name: 'x', version: '1.0.0', type: 'recipe', source },
      });
      expect(lockfileSchema.safeParse(lock).success).toBe(true);
    }
  });

  it('rejects an unknown source-spec kind', () => {
    const lock = {
      ...validRecipeLockfile(),
      root: {
        name: 'x',
        version: '1.0.0',
        type: 'recipe',
        source: { kind: 'ftp', path: '/x' },
      },
    };
    expect(lockfileSchema.safeParse(lock).success).toBe(false);
  });

  it('rejects a non-kebab child key', () => {
    const lock = validRecipeLockfile({
      children: [{ ...validChild(), key: 'Api_Layer' }],
    });
    expect(lockfileSchema.safeParse(lock).success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { root: _root, ...withoutRoot } = validRecipeLockfile();
    expect(lockfileSchema.safeParse(withoutRoot).success).toBe(false);
  });

  it('rejects a zero or negative schema_version', () => {
    for (const v of [0, -1]) {
      expect(lockfileSchema.safeParse(validRecipeLockfile({ schema_version: v })).success).toBe(
        false,
      );
    }
  });
});

describe('lockfileSchema — nested children', () => {
  it('accepts a recipe child carrying its own children', () => {
    const lock = validRecipeLockfile({
      children: [{ ...validChild(), key: 'platform', type: 'recipe', children: [validChild()] }],
    });
    expect(lockfileSchema.safeParse(lock).success).toBe(true);
  });

  it('validates recursively — a malformed grandchild is rejected', () => {
    const lock = validRecipeLockfile({
      children: [
        {
          ...validChild(),
          key: 'platform',
          type: 'recipe',
          children: [{ ...validChild(), key: 'Bad_Key' }],
        },
      ],
    });
    expect(lockfileSchema.safeParse(lock).success).toBe(false);
  });
});

describe('lockfileSchema — tampered hashes', () => {
  it('rejects a sha256 that is not 64 lowercase hex characters', () => {
    for (const bad of ['', 'abc', HASH_A.toUpperCase(), `${HASH_A}f`, 'z'.repeat(64)]) {
      const lock = validRecipeLockfile({ files: [{ path: 'package.json', sha256: bad }] });
      expect(lockfileSchema.safeParse(lock).success).toBe(false);
    }
  });

  it('accepts a well-formed 64-hex-char sha256', () => {
    const lock = validRecipeLockfile({ files: [{ path: 'package.json', sha256: HASH_B }] });
    expect(lockfileSchema.safeParse(lock).success).toBe(true);
  });
});

describe('lockfileSchema — deploy + cicd (M12.2)', () => {
  it('accepts an optional deploy stanza with adapter-specific passthrough keys', () => {
    const lock = validRecipeLockfile({
      deploy: { adapter: 'vercel', prod: true, project: 'foo' },
    });
    const parsed = lockfileSchema.safeParse(lock);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.deploy).toEqual({ adapter: 'vercel', prod: true, project: 'foo' });
    }
  });

  it('accepts an optional cicd stanza with provider-specific passthrough keys', () => {
    const lock = validRecipeLockfile({
      cicd: { provider: 'github-actions', 'node-version': '20' },
    });
    const parsed = lockfileSchema.safeParse(lock);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cicd).toEqual({
        provider: 'github-actions',
        'node-version': '20',
      });
    }
  });

  it('omitting both fields remains valid (back-compat)', () => {
    const lock = validRecipeLockfile();
    expect(lockfileSchema.safeParse(lock).success).toBe(true);
  });

  it('rejects a non-kebab adapter name', () => {
    const lock = validRecipeLockfile({ deploy: { adapter: 'Vercel_Pro' } });
    expect(lockfileSchema.safeParse(lock).success).toBe(false);
  });
});
