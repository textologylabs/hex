import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { validateMarketplaceFile } from '../../src/commands/marketplace.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-cmd-marketplace-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const validYaml = (overrides: Record<string, unknown> = {}) => ({
  namespace: 'acme',
  description: 'Acme catalogue',
  maintainers: ['acme-platform'],
  packages: [
    {
      name: 'demo',
      versions: [{ tag: '1.0.0', source: { git: 'https://example.test/x.git' } }],
    },
  ],
  ...overrides,
});

describe('validateMarketplaceFile', () => {
  it('accepts a valid marketplace.yaml and reports namespace + packageCount', async () => {
    const path = join(work, 'marketplace.yaml');
    await writeFile(path, stringifyYaml(validYaml()), 'utf8');
    const result = await validateMarketplaceFile(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.namespace).toBe('acme');
      expect(result.packageCount).toBe(1);
    }
  });

  it('reports a `read` failure for a missing file', async () => {
    const result = await validateMarketplaceFile(join(work, 'no-such-file.yaml'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('read');
    }
  });

  it('reports a `yaml` failure for malformed YAML', async () => {
    const path = join(work, 'marketplace.yaml');
    await writeFile(path, 'this: is: not: valid: yaml:::\n', 'utf8');
    const result = await validateMarketplaceFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('yaml');
    }
  });

  it('reports a `schema` failure with per-field issues for an invalid document', async () => {
    const path = join(work, 'marketplace.yaml');
    await writeFile(
      path,
      stringifyYaml({
        namespace: 'NOT VALID',
        packages: [],
      }),
      'utf8',
    );
    const result = await validateMarketplaceFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'schema') {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.path === 'namespace')).toBe(true);
    }
  });

  it('reports duplicate-package issues via superRefine', async () => {
    const path = join(work, 'marketplace.yaml');
    await writeFile(
      path,
      stringifyYaml(
        validYaml({
          packages: [
            { name: 'demo', versions: [{ tag: '1.0.0', source: { git: 'x' } }] },
            { name: 'demo', versions: [{ tag: '2.0.0', source: { git: 'x' } }] },
          ],
        }),
      ),
      'utf8',
    );
    const result = await validateMarketplaceFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'schema') {
      expect(result.issues.some((i) => i.message.includes('duplicate package'))).toBe(true);
    }
  });

  it('accepts a catalogue with zero packages (a freshly-rendered starter)', async () => {
    const path = join(work, 'marketplace.yaml');
    await writeFile(
      path,
      stringifyYaml({
        namespace: 'acme',
        maintainers: ['acme-platform'],
        packages: [],
      }),
      'utf8',
    );
    const result = await validateMarketplaceFile(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.packageCount).toBe(0);
  });
});
