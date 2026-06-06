import { z } from 'zod';

/**
 * `marketplace.yaml` — the on-disk catalogue format (M13.1). A catalogue
 * is a git repo whose root carries a `marketplace.yaml` listing every
 * package the catalogue ships, where to fetch each version from, and any
 * block/override policy the catalogue's maintainers want to enforce.
 *
 * This is the *git-catalogue* model — orthogonal to the hosted-registry
 * model the `MarketplaceSource` speaks (parked in M9.9). A catalogue can
 * point its packages at any git repo + ref + subdir; companies host one
 * `marketplace.yaml` in their own git infra and curate by PR.
 *
 * The schema is deliberately strict at the obvious places (kebab-case
 * names + namespaces, semver-triplet tags, non-empty package lists) and
 * lenient where the catalogue's authoring workflow naturally enforces
 * correctness (description/maintainer copy, category strings).
 */

const NAMESPACE_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const PACKAGE_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const KIND_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const QUALIFIED_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const VERSION_TAG_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

const versionSourceSchema = z
  .object({
    /** The git repo to fetch this version from. */
    git: z.string().min(1),
    /** Optional git ref (branch / tag / SHA). Defaults to the repo's default branch. */
    ref: z.string().min(1).optional(),
    /** Optional subdirectory inside the cloned repo where the bundle lives. */
    path: z.string().min(1).optional(),
  })
  .strict();

const packageVersionSchema = z
  .object({
    tag: z.string().regex(VERSION_TAG_RE, 'version tag must be semver (MAJOR.MINOR.PATCH)'),
    source: versionSourceSchema,
  })
  .strict();

const packageSchema = z
  .object({
    name: z
      .string()
      .regex(
        PACKAGE_NAME_RE,
        'package name must be kebab-case ([a-z0-9._-], no leading/trailing punctuation)',
      ),
    description: z.string().min(1).optional(),
    kind: z
      .string()
      .regex(KIND_RE, 'kind must be kebab-case ([a-z0-9_-], no leading/trailing punctuation)')
      .optional(),
    categories: z.array(z.string().min(1)).optional(),
    versions: z.array(packageVersionSchema).min(1, 'package must declare at least one version'),
  })
  .strict();

const overrideEntrySchema = z
  .object({
    /** Bare name to redirect when resolution walks marketplaces. */
    name: z.string().regex(PACKAGE_NAME_RE, 'override name must be kebab-case'),
    /** Qualified target (`<namespace>/<name>`). */
    use: z
      .string()
      .regex(
        QUALIFIED_NAME_RE,
        'override target must be qualified (`<namespace>/<name>`, kebab-case)',
      ),
  })
  .strict();

export const marketplaceYamlSchema = z
  .object({
    /** Marketplace namespace — appears as the qualifier in `<namespace>/<name>`. */
    namespace: z.string().regex(NAMESPACE_RE, 'namespace must be kebab-case ([a-z0-9._-])'),
    /** One-line catalogue description. Informational. */
    description: z.string().min(1).optional(),
    /** Catalogue maintainers (GitHub usernames / org names). Informational. */
    maintainers: z.array(z.string().min(1)).optional(),
    /** Every package this catalogue ships. */
    packages: z.array(packageSchema),
    /** Bare-name redirects this catalogue contributes to aggregate policy. */
    overrides: z.array(overrideEntrySchema).optional(),
    /** Qualified names this catalogue blocks (`<other-ns>/<name>`). */
    blocks: z
      .array(
        z
          .string()
          .regex(QUALIFIED_NAME_RE, 'block entry must be a qualified name (`<namespace>/<name>`)'),
      )
      .optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Map<string, number>();
    doc.packages.forEach((pkg, idx) => {
      const prior = seen.get(pkg.name);
      if (prior !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['packages', idx, 'name'],
          message: `duplicate package name "${pkg.name}" (also at index ${prior})`,
        });
        return;
      }
      seen.set(pkg.name, idx);

      const seenVersions = new Map<string, number>();
      pkg.versions.forEach((v, vIdx) => {
        const previous = seenVersions.get(v.tag);
        if (previous !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['packages', idx, 'versions', vIdx, 'tag'],
            message: `duplicate version tag "${v.tag}" (also at index ${previous})`,
          });
          return;
        }
        seenVersions.set(v.tag, vIdx);
      });
    });

    const seenOverrides = new Set<string>();
    (doc.overrides ?? []).forEach((o, idx) => {
      if (seenOverrides.has(o.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['overrides', idx, 'name'],
          message: `duplicate override for bare name "${o.name}"`,
        });
      }
      seenOverrides.add(o.name);
    });
  });

export type MarketplaceYaml = z.infer<typeof marketplaceYamlSchema>;
export type CataloguePackage = MarketplaceYaml['packages'][number];
export type CataloguePackageVersion = CataloguePackage['versions'][number];
export type CataloguePackageSource = CataloguePackageVersion['source'];
export type CatalogueOverride = NonNullable<MarketplaceYaml['overrides']>[number];

export const MARKETPLACE_YAML_FILENAME = 'marketplace.yaml';
