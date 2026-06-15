import { describe, expect, it } from 'vitest';
import {
  type ShouldCheckInput,
  compareVersions,
  fetchLatestVersion,
  isNewerVersion,
  shouldCheck,
} from '../src/update.js';

const base: ShouldCheckInput = {
  noUpdateEnv: false,
  stdinTTY: true,
  stdoutTTY: true,
  configCheckDisabled: false,
};

describe('shouldCheck', () => {
  it('runs only in an interactive TTY with no opt-out', () => {
    expect(shouldCheck(base)).toBe(true);
  });

  it('is disabled by HEX_NO_UPDATE_CHECK', () => {
    expect(shouldCheck({ ...base, noUpdateEnv: true })).toBe(false);
  });

  it('is disabled centrally by config (update.check === false)', () => {
    expect(shouldCheck({ ...base, configCheckDisabled: true })).toBe(false);
  });

  it('never runs when stdout is not a TTY (pipe / CI)', () => {
    expect(shouldCheck({ ...base, stdoutTTY: false })).toBe(false);
  });

  it('never runs when stdin is not a TTY (piped input)', () => {
    expect(shouldCheck({ ...base, stdinTTY: false })).toBe(false);
  });
});

describe('compareVersions / isNewerVersion', () => {
  it('orders by major.minor.patch', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBeLessThan(0);
  });

  it('isNewerVersion is strict (equal is not newer)', () => {
    expect(isNewerVersion('1.1.0', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.1.0')).toBe(false);
  });
});

describe('fetchLatestVersion — fails safe', () => {
  const ok = (version: unknown): Response =>
    ({ ok: true, json: async () => ({ version }) }) as unknown as Response;

  it('returns the version on a good response', async () => {
    const latest = await fetchLatestVersion(async () => ok('1.4.2'));
    expect(latest).toBe('1.4.2');
  });

  it('returns null on a non-2xx response', async () => {
    const latest = await fetchLatestVersion(async () => ({ ok: false }) as unknown as Response);
    expect(latest).toBeNull();
  });

  it('returns null when the network throws (offline / proxy refused)', async () => {
    const latest = await fetchLatestVersion(async () => {
      throw new Error('ENOTFOUND registry.npmjs.org');
    });
    expect(latest).toBeNull();
  });

  it('returns null when the body has no version field', async () => {
    const latest = await fetchLatestVersion(async () => ok(undefined));
    expect(latest).toBeNull();
  });

  it('returns null when the request is aborted (timeout)', async () => {
    const latest = await fetchLatestVersion(async (_url, init) => {
      // Simulate the AbortController firing: reject like a real aborted fetch.
      const signal = (init as RequestInit | undefined)?.signal;
      throw Object.assign(new Error('aborted'), { name: 'AbortError', signal });
    });
    expect(latest).toBeNull();
  });
});
