import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanFileError, loadPlanFile, parsePlanFile } from '../../../src/core/hexify/plan-file.js';

describe('parsePlanFile', () => {
  it('parses a full plan with template identity and descriptions', () => {
    const plan = parsePlanFile(
      [
        'template:',
        '  name: acme-portal',
        '  kind: webapp',
        'params:',
        '  - name: project_name',
        '    value: acme-portal',
        '    description: Project name',
        '  - name: service_name',
        '    value: acme-portal-svc',
      ].join('\n'),
    );
    expect(plan.template).toEqual({ name: 'acme-portal', kind: 'webapp' });
    expect(plan.params).toEqual([
      { name: 'project_name', value: 'acme-portal', description: 'Project name' },
      { name: 'service_name', value: 'acme-portal-svc', description: 'service name' },
    ]);
  });

  it('defaults a missing description to the humanised name and trims values', () => {
    const plan = parsePlanFile('params:\n  - name: db_name\n    value: "  acme_db  "\n');
    expect(plan.params).toEqual([{ name: 'db_name', value: 'acme_db', description: 'db name' }]);
  });

  it('accepts multi-word and punctuated values (the engine treats them as plain substrings)', () => {
    const plan = parsePlanFile('params:\n  - name: company\n    value: Acme Portal Ltd\n');
    expect(plan.params[0]?.value).toBe('Acme Portal Ltd');
  });

  it('rejects bad YAML, non-mapping roots, and empty params', () => {
    expect(() => parsePlanFile('{{nope')).toThrowError(PlanFileError);
    expect(() => parsePlanFile('')).toThrowError(/mapping with a `params:` list/);
    expect(() => parsePlanFile('- a\n- b\n')).toThrowError(/mapping with a `params:` list/);
    expect(() => parsePlanFile('params: []\n')).toThrowError(/at least one parameter/);
  });

  it('rejects invalid names, short values, and unknown keys via the schema', () => {
    expect(() => parsePlanFile('params:\n  - name: Bad-Name\n    value: acme\n')).toThrowError(
      /lower_snake_case/,
    );
    expect(() => parsePlanFile('params:\n  - name: ok_name\n    value: ab\n')).toThrowError(
      /at least 3 characters/,
    );
    // Whitespace padding must not defeat the length floor.
    expect(() => parsePlanFile('params:\n  - name: ok_name\n    value: " ab "\n')).toThrowError(
      /at least 3 characters/,
    );
    // A typoed key fails loudly instead of being silently ignored.
    expect(() =>
      parsePlanFile('params:\n  - name: ok_name\n    value: acme\n    evidence: 3\n'),
    ).toThrowError(PlanFileError);
    expect(() => parsePlanFile('parameters:\n  - name: a_b\n    value: acme\n')).toThrowError(
      PlanFileError,
    );
  });

  it('rejects duplicate names and duplicate values', () => {
    expect(() =>
      parsePlanFile('params:\n  - name: one\n    value: acme\n  - name: one\n    value: other\n'),
    ).toThrowError(/duplicate param name: one/);
    expect(() =>
      parsePlanFile('params:\n  - name: one\n    value: acme\n  - name: two\n    value: acme\n'),
    ).toThrowError(/duplicate param value: "acme"/);
  });
});

describe('loadPlanFile', () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'hex-plan-file-'));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('reads and parses a plan from disk', async () => {
    const path = join(work, 'hexify.plan.yaml');
    await writeFile(path, 'params:\n  - name: project_name\n    value: acme-portal\n', 'utf8');
    const plan = await loadPlanFile(path);
    expect(plan.params).toHaveLength(1);
  });

  it('prefixes parse errors with the path and surfaces unreadable files', async () => {
    const path = join(work, 'bad.yaml');
    await writeFile(path, 'params: []\n', 'utf8');
    await expect(loadPlanFile(path)).rejects.toThrowError(/bad\.yaml[\s\S]*parameter/);
    await expect(loadPlanFile(join(work, 'missing.yaml'))).rejects.toThrowError(
      /cannot read plan file/,
    );
  });
});
