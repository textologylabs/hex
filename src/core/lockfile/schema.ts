import { z } from 'zod';
import { KEBAB_KEY_RE, cicdSchema, deploySchema } from '../manifest/schema.js';

/**
 * The lockfile schema (M10.1) — the zod shape of `.hex/lockfile.yaml`.
 *
 * A generated app's lockfile records *what was scaffolded*: the recipe
 * (or standalone component) at its root, every composed child, the full
 * answers tree, and a per-file content-hash table of the rendered tree.
 * Together that is exactly the `{recipe, components+versions, answers,
 * hashes}` set `idea.md` §11 calls out as "enough to reconstruct
 * `pristine_old`" — the single enabler for the M11 upgrade engine.
 *
 * This module is the schema only. Writing the lockfile is M10.2;
 * reading it back and verifying integrity is M10.3.
 */

/**
 * The lockfile-format version this build of Hex writes. Bumped only on a
 * breaking change to the shape. The schema accepts any positive integer
 * here on purpose — a reader (M10.3) compares against this constant so a
 * future-version file fails with an upgrade hint, not a schema error.
 */
export const LOCKFILE_SCHEMA_VERSION = 1;

/** A lowercase-hex sha256 digest — 64 hex characters. */
export const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * How to re-fetch an artifact for pristine reconstruction. One variant
 * per `Source` implementation — a local path (M1), a git repo (M3), or
 * a marketplace coordinate (M9).
 */
const fileSourceSpecSchema = z.object({
  kind: z.literal('file'),
  /** Absolute or config-relative directory the bundle was read from. */
  path: z.string().min(1),
});

const gitSourceSpecSchema = z.object({
  kind: z.literal('git'),
  url: z.string().min(1),
  /** Branch / tag / commit; absent means the repo default. */
  ref: z.string().min(1).optional(),
});

const marketplaceSourceSpecSchema = z.object({
  kind: z.literal('marketplace'),
  /** Registry base URL the package was fetched from. */
  registry: z.string().min(1),
  /** Package name within that registry. */
  name: z.string().min(1),
});

export const sourceSpecSchema = z.discriminatedUnion('kind', [
  fileSourceSpecSchema,
  gitSourceSpecSchema,
  marketplaceSourceSpecSchema,
]);

/** Identity of one scaffolding artifact — the recipe root or a child. */
export const lockArtifactSchema = z.object({
  /** Qualified (`hex/api-fastify`) or bare name, as resolved. */
  name: z.string().min(1),
  /** The exact resolved version that was rendered. */
  version: z.string().min(1),
  type: z.union([z.literal('component'), z.literal('recipe')]),
  /** How to re-fetch this exact artifact during an upgrade. */
  source: sourceSpecSchema,
});

/** Identity + source spec of one scaffolding artifact. */
export type LockArtifact = z.infer<typeof lockArtifactSchema>;

/**
 * A recipe's composed child — an artifact plus its `composes:` slot key,
 * stub flag, and, when the child is *itself a recipe*, its own composed
 * children. The tree is recorded recursively so the M11 upgrade engine
 * has the whole shape it needs to reconstruct `pristine_old`.
 *
 * `children` is omitted entirely for a component child (a leaf); a
 * recipe child carries its descendants.
 */
export type LockChild = LockArtifact & {
  key: string;
  stub: boolean;
  children?: LockChild[];
};

export const lockChildSchema: z.ZodType<LockChild> = z.lazy(() =>
  lockArtifactSchema.extend({
    /** The recipe's `composes:` slot key this child filled. */
    key: z
      .string()
      .min(1)
      .regex(KEBAB_KEY_RE, 'child key must be kebab-case ([a-z0-9-], no leading/trailing dash)'),
    /** Whether this child was rendered in stub mode (`idea.md` §6). */
    stub: z.boolean(),
    /** A recipe child's own composed children; absent for a component. */
    children: z.array(lockChildSchema).optional(),
  }),
);

/** One rendered file and the sha256 of its bytes at generation time. */
export const lockFileEntrySchema = z.object({
  /** POSIX-style path, relative to the generated app root. */
  path: z.string().min(1),
  /** Lowercase-hex sha256 of the file's bytes as Hex rendered them. */
  sha256: z.string().regex(SHA256_RE, 'sha256 must be 64 lowercase hex characters'),
});

export const lockfileSchema = z.object({
  /** Format version — see `LOCKFILE_SCHEMA_VERSION`. */
  schema_version: z.number().int().positive(),
  /** Version of Hex that wrote the file. Informational. */
  hex_version: z.string().min(1).optional(),
  /** ISO-8601 timestamp of the render. Informational. */
  generated_at: z.string().min(1).optional(),
  /** The recipe — or, for a standalone component scaffold, the component. */
  root: lockArtifactSchema,
  /** Composed children. Empty for a standalone component. */
  children: z.array(lockChildSchema),
  /** The full answers tree exactly as the render consumed it. */
  answers: z.record(z.string(), z.unknown()),
  /** Per-file content hashes of the rendered tree, sorted by `path`. */
  files: z.array(lockFileEntrySchema),
  /**
   * Orphaned files (M11.7) — files the user edited that a template
   * upgrade removed, kept in place rather than deleted. POSIX-style
   * paths relative to the app root. Omitted when there are none.
   */
  orphans: z.array(z.string().min(1)).optional(),
  /**
   * Deploy stanza captured from the source manifest at render time
   * (M12.2). Pinned here so `hex deploy` has a single source of truth
   * regardless of whether the source bundle is still reachable.
   */
  deploy: deploySchema.optional(),
  /**
   * CI/CD stanza captured from the source manifest at render time
   * (M12.2). Same pinning rationale as `deploy`.
   */
  cicd: cicdSchema.optional(),
});
