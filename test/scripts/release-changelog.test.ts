import { describe, expect, it } from 'vitest';
// Release tooling lives in scripts/ (plain ESM, outside tsconfig), so it
// carries no type declarations — suppress the missing-types error on import.
// @ts-expect-error - plain JS release script, no .d.ts
import { releaseChangelog } from '../../scripts/release-changelog.mjs';

const fn = releaseChangelog as (text: string, version: string, date: string) => string;

const SAMPLE = `# Changelog

The format is based on Keep a Changelog.

## [Unreleased]

### Added

- a new thing
- another thing

## [0.9.0] — 2026-06-11

- old release
`;

describe('releaseChangelog', () => {
  it('moves Unreleased entries under a dated version heading and reseeds Unreleased', () => {
    const out = fn(SAMPLE, '1.0.0', '2026-06-14');
    // A fresh empty Unreleased stays on top...
    expect(out).toContain('## [Unreleased]\n\n## [1.0.0] — 2026-06-14');
    // ...the entries moved under the new version...
    expect(out).toMatch(/## \[1\.0\.0\] — 2026-06-14\n\n### Added\n\n- a new thing/);
    // ...and the prior release is untouched and still below.
    expect(out).toContain('## [0.9.0] — 2026-06-11');
    expect(out.indexOf('## [1.0.0]')).toBeLessThan(out.indexOf('## [0.9.0]'));
  });

  it('throws when there is nothing under Unreleased', () => {
    const empty = '# Changelog\n\n## [Unreleased]\n\n## [0.9.0] — 2026-06-11\n\n- old\n';
    expect(() => fn(empty, '1.0.0', '2026-06-14')).toThrow(/nothing to release/);
  });

  it('throws when there is no Unreleased section at all', () => {
    const none = '# Changelog\n\n## [0.9.0] — 2026-06-11\n\n- old\n';
    expect(() => fn(none, '1.0.0', '2026-06-14')).toThrow(/no .*Unreleased.* section/);
  });

  it('does not leave duplicate blank lines around the moved body', () => {
    const out = fn(SAMPLE, '1.0.0', '2026-06-14');
    expect(out).not.toContain('\n\n\n');
  });
});
