import type { HexConfig } from '../config/types.js';
import { RUN_COMMAND_ALLOWLIST } from './run.js';

/**
 * Trust policy for `run:` setup-task execution (M15.3).
 *
 * The allowlist alone is weak protection against a hostile remote
 * template — `npx <anything>`, `npm install` (install scripts),
 * `node -e`, and `git` hooks all reach arbitrary code through an
 * allowlisted binary. So execution is gated by *where the template came
 * from*, not just *which binary it runs*:
 *
 *   - **file** sources (a local path you pointed `hex new` at) are
 *     trusted to auto-run; the allowlist still applies (and
 *     `--trust-local` lifts it, per M7.6).
 *   - **remote** sources (git / catalogue / marketplace) auto-run only
 *     when their identifier is in `trust.sources`. Otherwise the caller
 *     asks the user how to proceed (trust / review-each / skip) and
 *     never silently executes remote code — and in a non-interactive
 *     context, doesn't run them at all.
 *
 * The allowlist itself is configurable (`trust.allowlist`) so an org can
 * tighten it (an empty list = nothing auto-runs) or extend it.
 */

export type TrustPolicy = {
  /** The effective run-command allowlist (config override or the default). */
  allowlist: readonly string[];
  /** Remote source identifiers the user has vouched for. */
  trustedSources: readonly string[];
};

/** Build the effective trust policy from config (defaults when unset). */
export function resolveTrustPolicy(config?: Pick<HexConfig, 'trust'>): TrustPolicy {
  const trust = config?.trust;
  return {
    allowlist: trust?.allowlist ?? RUN_COMMAND_ALLOWLIST,
    trustedSources: trust?.sources ?? [],
  };
}

/** True if `identifier` is in the trusted-sources list. */
export function isSourceTrusted(policy: TrustPolicy, identifier: string | undefined): boolean {
  if (identifier === undefined || identifier.length === 0) return false;
  return policy.trustedSources.includes(identifier);
}

/** How a source's `run:` tasks should be treated for auto-execution. */
export type SourceTrust = { kind: 'trusted' } | { kind: 'untrusted'; identifier: string };

/**
 * Classify a template source for auto-execution. `file` sources are
 * trusted (you chose the local path); a remote source is trusted only
 * when its identifier is on the trusted list, otherwise `untrusted` —
 * which the caller turns into the trust / review / skip prompt.
 */
export function classifySource(opts: {
  sourceKind: 'file' | 'git';
  identifier: string | undefined;
  policy: TrustPolicy;
}): SourceTrust {
  if (opts.sourceKind === 'file') return { kind: 'trusted' };
  if (isSourceTrusted(opts.policy, opts.identifier)) return { kind: 'trusted' };
  return { kind: 'untrusted', identifier: opts.identifier ?? '(unknown source)' };
}
