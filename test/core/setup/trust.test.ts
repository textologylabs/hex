import { describe, expect, it } from 'vitest';
import type { SetupTask } from '../../../src/core/manifest/types.js';
import {
  RUN_COMMAND_ALLOWLIST,
  SetupExecutorError,
  validateSetupTasksAllowlist,
} from '../../../src/core/setup/run.js';
import {
  classifySource,
  isSourceTrusted,
  resolveTrustPolicy,
} from '../../../src/core/setup/trust.js';

describe('resolveTrustPolicy', () => {
  it('defaults to the built-in allowlist and no trusted sources', () => {
    const p = resolveTrustPolicy();
    expect(p.allowlist).toEqual(RUN_COMMAND_ALLOWLIST);
    expect(p.trustedSources).toEqual([]);
  });

  it('honours a config override of the allowlist (including empty)', () => {
    expect(resolveTrustPolicy({ trust: { allowlist: ['npm', 'git'] } }).allowlist).toEqual([
      'npm',
      'git',
    ]);
    expect(resolveTrustPolicy({ trust: { allowlist: [] } }).allowlist).toEqual([]);
  });

  it('reads trusted sources from config', () => {
    const p = resolveTrustPolicy({ trust: { sources: ['https://x.test/cat'] } });
    expect(p.trustedSources).toEqual(['https://x.test/cat']);
  });
});

describe('isSourceTrusted', () => {
  const policy = resolveTrustPolicy({ trust: { sources: ['https://x.test/cat'] } });
  it('matches a listed source', () => {
    expect(isSourceTrusted(policy, 'https://x.test/cat')).toBe(true);
  });
  it('rejects an unlisted or missing identifier', () => {
    expect(isSourceTrusted(policy, 'https://other.test')).toBe(false);
    expect(isSourceTrusted(policy, undefined)).toBe(false);
    expect(isSourceTrusted(policy, '')).toBe(false);
  });
});

describe('classifySource', () => {
  const policy = resolveTrustPolicy({ trust: { sources: ['https://trusted.test/cat'] } });

  it('treats a file source as trusted', () => {
    expect(classifySource({ sourceKind: 'file', identifier: undefined, policy })).toEqual({
      kind: 'trusted',
    });
  });

  it('treats a trusted remote source as trusted', () => {
    expect(
      classifySource({ sourceKind: 'git', identifier: 'https://trusted.test/cat', policy }),
    ).toEqual({ kind: 'trusted' });
  });

  it('treats an unlisted remote source as untrusted, carrying the identifier', () => {
    expect(
      classifySource({ sourceKind: 'git', identifier: 'https://stranger.test/cat', policy }),
    ).toEqual({ kind: 'untrusted', identifier: 'https://stranger.test/cat' });
  });

  it('falls back to a placeholder identifier when none is known', () => {
    expect(classifySource({ sourceKind: 'git', identifier: undefined, policy })).toEqual({
      kind: 'untrusted',
      identifier: '(unknown source)',
    });
  });
});

describe('validateSetupTasksAllowlist — configurable allowlist (M15.3)', () => {
  const task = (run: string): SetupTask => ({ id: 't', title: 'T', run });

  it('accepts a binary on a custom allowlist and rejects one off it', () => {
    expect(() =>
      validateSetupTasksAllowlist([task('make build')], {
        sourceKind: 'git',
        trustLocal: false,
        allowlist: ['make'],
      }),
    ).not.toThrow();
    expect(() =>
      validateSetupTasksAllowlist([task('npm install')], {
        sourceKind: 'git',
        trustLocal: false,
        allowlist: ['make'],
      }),
    ).toThrow(SetupExecutorError);
  });

  it('an empty allowlist blocks every run: task', () => {
    expect(() =>
      validateSetupTasksAllowlist([task('npm install')], {
        sourceKind: 'git',
        trustLocal: false,
        allowlist: [],
      }),
    ).toThrow(/empty/);
  });

  it('still defaults to the built-in allowlist when none is passed', () => {
    expect(() =>
      validateSetupTasksAllowlist([task('npm install')], {
        sourceKind: 'git',
        trustLocal: false,
      }),
    ).not.toThrow();
  });

  it('file + trust-local still bypasses regardless of allowlist', () => {
    expect(() =>
      validateSetupTasksAllowlist([task('whatever --wild')], {
        sourceKind: 'file',
        trustLocal: true,
        allowlist: [],
      }),
    ).not.toThrow();
  });
});
