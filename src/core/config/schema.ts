import { z } from 'zod';

const pathSourceSchema = z.object({
  path: z.string().min(1),
});

const gitSourceSchema = z.object({
  git: z.string().min(1),
  ref: z.string().min(1).optional(),
});

// Catalogue sources (M13.2) — a git repo whose root carries a
// `marketplace.yaml` (M13.1). Same wire shape as `git:` plus a different
// discriminator, so a single config can mix catalogues and bare git
// template repos. Auth is whatever the user's `git` already does — no
// explicit auth field; if/when we add one it lands on both `git:` and
// `catalogue:` together.
const catalogueSourceSchema = z.object({
  catalogue: z.string().min(1),
  ref: z.string().min(1).optional(),
});

export const sourceRootSchema = z.union([pathSourceSchema, gitSourceSchema, catalogueSourceSchema]);

// Marketplace ids are address qualifiers (`<id>/<name>`) — same charset
// the addressing parser accepts (see `core/marketplace/address.ts`).
const MARKETPLACE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

const marketplaceSchema = z.object({
  id: z.string().regex(MARKETPLACE_ID_RE, 'marketplace id must be lowercase alphanumeric/.-_'),
  registry: z.string().min(1),
});

// Trust policy (M15.3). Governs whether a template's `run:` setup tasks
// may execute. `allowlist` overrides the built-in safe binary list (an
// empty array locks everything down — no auto-run); `sources` lists the
// remote (git/catalogue) source identifiers the user vouches for, whose
// `run:` tasks may auto-execute without the per-scaffold trust prompt.
const trustSchema = z.object({
  /** Override the run-command allowlist. `[]` = no command may auto-run. */
  allowlist: z.array(z.string().min(1)).optional(),
  /** Remote source URLs trusted to auto-run their setup tasks. */
  sources: z.array(z.string().min(1)).optional(),
});

// Self-update policy (M15.7). `check: false` disables the startup update
// check centrally — the enterprise / air-gapped knob a platform team can
// ship in a shared config, so disabling doesn't depend on every shell
// exporting `HEX_NO_UPDATE_CHECK=1`. Absent = enabled (still gated on a
// TTY and the env var).
const updateSchema = z.object({
  check: z.boolean().optional(),
});

export const hexConfigSchema = z
  .object({
    sources: z.array(sourceRootSchema).default([]),
    /**
     * Configured marketplaces, in resolution order. Order drives
     * bare-name precedence (first hit wins); qualified `<id>/<name>`
     * addresses disambiguate explicitly. See M9.4 / M9.5.
     */
    marketplaces: z.array(marketplaceSchema).default([]),
    /** Trust policy for `run:` setup-task execution (M15.3). */
    trust: trustSchema.optional(),
    /** Self-update policy (M15.7). `check: false` disables the startup check. */
    update: updateSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < cfg.marketplaces.length; i++) {
      const id = (cfg.marketplaces[i] as { id: string }).id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['marketplaces', i, 'id'],
          message: `duplicate marketplace id "${id}"`,
        });
      }
      seen.add(id);
    }
  });
