import { describe, expect, it } from 'vitest';
import { extractPair, mineCandidatePairs } from '../../../src/core/hexify/mine.js';
import type { ScannedFile } from '../../../src/core/hexify/pipeline.js';

const file = (rel: string, text: string): ScannedFile => ({
  rel,
  abs: `/x/${rel}`,
  binary: false,
  text,
});

describe('extractPair', () => {
  it('extracts a simple value pair', () => {
    expect(extractPair('  "name": "acme-portal",', '  "name": "zed-portal",')).toEqual({
      templateValue: 'acme-portal',
      instanceValue: 'zed-portal',
    });
  });

  it('widens the minimal span to word boundaries (the substitutability rule)', () => {
    // Minimal span is acme↔zed; the mined value must be the full run or
    // the substitution engine's boundary check would never match it.
    expect(extractPair('image: acme-portal-web:latest', 'image: zed-portal-web:latest')).toEqual({
      templateValue: 'acme-portal-web',
      instanceValue: 'zed-portal-web',
    });
  });

  it('widens numeric runs', () => {
    expect(extractPair('port: 3000', 'port: 3001')).toEqual({
      templateValue: '3000',
      instanceValue: '3001',
    });
  });

  it('rejects identical lines, short values, and whole-line rewrites', () => {
    expect(extractPair('same', 'same')).toBeNull();
    expect(extractPair('x: a', 'x: b')).toBeNull(); // too short
    expect(
      extractPair(
        'this line was completely rewritten by the team with new logic and meaning beyond a value',
        'entirely different content that shares almost nothing with the original template line at all',
      ),
    ).toBeNull(); // too long
  });
});

describe('mineCandidatePairs', () => {
  it('aggregates a consistent pair across files with evidence and file counts', () => {
    const template = [
      file('package.json', '{\n  "name": "acme-portal"\n}\n'),
      file('k8s/deploy.yaml', 'image: acme-portal:latest\nreplicas: 2\n'),
      file('README.md', 'unchanged\n'),
    ];
    const instance = [
      file('package.json', '{\n  "name": "zed-portal"\n}\n'),
      file('k8s/deploy.yaml', 'image: zed-portal:latest\nreplicas: 2\n'),
      file('README.md', 'unchanged\n'),
    ];
    const mined = mineCandidatePairs(template, instance);
    expect(mined).toHaveLength(1);
    expect(mined[0]).toEqual({
      templateValue: 'acme-portal',
      instanceValue: 'zed-portal',
      evidence: 2,
      files: 2,
    });
  });

  it('ignores insertions/deletions (drift), mining only 1:1 line replacements', () => {
    const template = [file('a.txt', 'keep\nname: acme-portal\n')];
    const instance = [file('a.txt', 'keep\nname: zed-portal\nteam added this line\nand this\n')];
    const mined = mineCandidatePairs(template, instance);
    expect(mined).toEqual([
      { templateValue: 'acme-portal', instanceValue: 'zed-portal', evidence: 1, files: 1 },
    ]);
  });

  it('mines filename pairs when the alignment is unambiguous', () => {
    const template = [file('src/acme-portal.config.ts', 'x\n')];
    const instance = [file('src/zed-portal.config.ts', 'x\n')];
    const mined = mineCandidatePairs(template, instance);
    expect(mined).toEqual([
      { templateValue: 'acme-portal', instanceValue: 'zed-portal', evidence: 1, files: 1 },
    ]);
  });

  it('skips ambiguous filename pairings (two candidates, same dir + ext)', () => {
    const template = [file('src/acme-portal.config.ts', 'x\n')];
    const instance = [
      file('src/zed-portal.config.ts', 'x\n'),
      file('src/other-thing.config.ts', 'y\n'),
    ];
    expect(mineCandidatePairs(template, instance)).toEqual([]);
  });

  it('skips binaries and sorts by evidence descending', () => {
    const template = [
      { rel: 'logo.png', abs: '/x/logo.png', binary: true } as ScannedFile,
      file('a.txt', 'acme-portal\nacme-portal\nowner: platform-team\n'),
    ];
    const instance = [
      { rel: 'logo.png', abs: '/y/logo.png', binary: true } as ScannedFile,
      file('a.txt', 'zed-portal\nzed-portal\nowner: checkout-squad\n'),
    ];
    const mined = mineCandidatePairs(template, instance);
    expect(mined.map((m) => m.templateValue)).toEqual(['acme-portal', 'platform-team']);
    expect(mined[0]?.evidence).toBe(2);
    expect(mined[1]?.evidence).toBe(1);
  });
});
