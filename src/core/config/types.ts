import type { MarketplaceConfig } from '../marketplace/address.js';

// Source roots can point at a local filesystem path or a git remote.
// The wire form (in `~/.hex/config.yaml`) is `{ path: ... }` or
// `{ git: ..., ref?: ... }` — see `schema.ts`. Internally we tag each
// entry with a `kind` discriminator so consumers (discovery, the future
// resolver) can switch on it without re-sniffing field presence.
export type FileSourceRoot = { kind: 'path'; path: string };
export type GitSourceRoot = { kind: 'git'; url: string; ref?: string };
/**
 * Catalogue source (M13.2) — a git repo whose root carries a
 * `marketplace.yaml`. Resolved through `CatalogueSource` (M13.1), which
 * delegates the actual fetch to the `GitSource` machinery.
 */
export type CatalogueSourceRoot = { kind: 'catalogue'; url: string; ref?: string };
export type SourceRootEntry = FileSourceRoot | GitSourceRoot | CatalogueSourceRoot;

/**
 * Trust policy (M15.3) — governs whether a template's `run:` setup
 * tasks may auto-execute. `allowlist` overrides the built-in safe binary
 * list (`[]` locks everything down); `sources` lists remote source URLs
 * the user vouches for. Both optional; absent fields fall back to
 * defaults in `resolveTrustPolicy`.
 */
export type TrustConfig = {
  allowlist?: string[];
  sources?: string[];
};

export type HexConfig = {
  sources: SourceRootEntry[];
  /**
   * Configured marketplaces in resolution order (M9.5). Optional so
   * hand-built partial configs (mostly tests) need not spell it out;
   * `loadConfig` always populates it — read it as `?? []`.
   */
  marketplaces?: MarketplaceConfig[];
  /** Trust policy for `run:` setup-task execution (M15.3). Optional. */
  trust?: TrustConfig;
};
