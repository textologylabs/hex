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

export const hexConfigSchema = z
  .object({
    sources: z.array(sourceRootSchema).default([]),
    /**
     * Configured marketplaces, in resolution order. Order drives
     * bare-name precedence (first hit wins); qualified `<id>/<name>`
     * addresses disambiguate explicitly. See M9.4 / M9.5.
     */
    marketplaces: z.array(marketplaceSchema).default([]),
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
