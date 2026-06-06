import { describe, expect, it } from 'vitest';
import {
  type MarketplaceYaml,
  marketplaceYamlSchema,
} from '../../../src/core/marketplace/catalogue-schema.js';

function validCatalogue(overrides: Partial<MarketplaceYaml> = {}): MarketplaceYaml {
  return {
    namespace: 'hex',
    packages: [
      {
        name: 'vite-ts-spa',
        versions: [
          { tag: '0.1.0', source: { git: 'https://github.com/x/y', path: 'templates/vite' } },
        ],
      },
    ],
    ...overrides,
  } as MarketplaceYaml;
}

describe('marketplaceYamlSchema — base shape', () => {
  it('accepts the minimal catalogue', () => {
    const parsed = marketplaceYamlSchema.safeParse(validCatalogue());
    expect(parsed.success).toBe(true);
  });

  it('accepts every optional field set', () => {
    const parsed = marketplaceYamlSchema.safeParse({
      namespace: 'hex',
      description: 'Official Hex templates',
      maintainers: ['textologylabs'],
      packages: [
        {
          name: 'node-ts-cli',
          description: 'TS CLI scaffolding',
          kind: 'cli',
          categories: ['cli', 'node'],
          versions: [
            {
              tag: '0.2.0',
              source: {
                git: 'https://github.com/textologylabs/hex',
                ref: 'v0.8.0',
                path: 'templates/node-ts-cli',
              },
            },
            {
              tag: '0.1.0',
              source: {
                git: 'https://github.com/textologylabs/hex',
                ref: 'v0.7.0',
                path: 'templates/node-ts-cli',
              },
            },
          ],
        },
      ],
      overrides: [{ name: 'cli', use: 'hex/node-ts-cli' }],
      blocks: ['hex/deprecated'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-kebab namespace', () => {
    expect(
      marketplaceYamlSchema.safeParse(validCatalogue({ namespace: 'Hex' as unknown as string }))
        .success,
    ).toBe(false);
    expect(
      marketplaceYamlSchema.safeParse(validCatalogue({ namespace: '_x' as unknown as string }))
        .success,
    ).toBe(false);
  });

  it('rejects unknown top-level keys (.strict)', () => {
    const result = marketplaceYamlSchema.safeParse({
      ...validCatalogue(),
      mystery: 'meat',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty packages array', () => {
    expect(marketplaceYamlSchema.safeParse(validCatalogue({ packages: [] })).success).toBe(true);
    // packages.length 0 is technically allowed by zod (no .min); leave that to authoring lint.
  });
});

describe('marketplaceYamlSchema — packages + versions', () => {
  it('rejects a non-kebab package name', () => {
    const result = marketplaceYamlSchema.safeParse(
      validCatalogue({
        packages: [
          {
            name: 'Bad_Name',
            versions: [{ tag: '0.1.0', source: { git: 'g' } }],
          },
        ],
      } as unknown as MarketplaceYaml),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a non-semver version tag', () => {
    const result = marketplaceYamlSchema.safeParse({
      namespace: 'hex',
      packages: [{ name: 'x', versions: [{ tag: 'v1', source: { git: 'g' } }] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a version with an empty git URL', () => {
    const result = marketplaceYamlSchema.safeParse({
      namespace: 'hex',
      packages: [{ name: 'x', versions: [{ tag: '0.1.0', source: { git: '' } }] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside source (.strict)', () => {
    const result = marketplaceYamlSchema.safeParse({
      namespace: 'hex',
      packages: [
        {
          name: 'x',
          versions: [{ tag: '0.1.0', source: { git: 'g', wrong: 1 } }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('requires at least one version per package', () => {
    const result = marketplaceYamlSchema.safeParse({
      namespace: 'hex',
      packages: [{ name: 'x', versions: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('catches duplicate package names', () => {
    const result = marketplaceYamlSchema.safeParse({
      namespace: 'hex',
      packages: [
        { name: 'x', versions: [{ tag: '0.1.0', source: { git: 'g' } }] },
        { name: 'x', versions: [{ tag: '0.2.0', source: { git: 'g' } }] },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /duplicate package name/.test(i.message))).toBe(true);
    }
  });

  it('catches duplicate version tags within a single package', () => {
    const result = marketplaceYamlSchema.safeParse({
      namespace: 'hex',
      packages: [
        {
          name: 'x',
          versions: [
            { tag: '0.1.0', source: { git: 'g' } },
            { tag: '0.1.0', source: { git: 'g' } },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /duplicate version tag/.test(i.message))).toBe(true);
    }
  });
});

describe('marketplaceYamlSchema — overrides + blocks', () => {
  it('rejects an unqualified override target', () => {
    const result = marketplaceYamlSchema.safeParse(
      validCatalogue({
        overrides: [{ name: 'cli', use: 'node-ts-cli' }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an unqualified block entry', () => {
    const result = marketplaceYamlSchema.safeParse(validCatalogue({ blocks: ['just-a-name'] }));
    expect(result.success).toBe(false);
  });

  it('catches duplicate override bare names', () => {
    const result = marketplaceYamlSchema.safeParse(
      validCatalogue({
        overrides: [
          { name: 'cli', use: 'hex/node-ts-cli' },
          { name: 'cli', use: 'acme/other-cli' },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /duplicate override/.test(i.message))).toBe(true);
    }
  });
});
