/**
 * Deploy + CI/CD plugin interfaces (M12.1).
 *
 * `DeployAdapter` knows how to ship a single component to a hosting target.
 * `CicdProvider` knows how to emit CI/CD workflow files that invoke the
 * deploy adapter on push. Both are independent axes — `vercel` × `github-actions`,
 * `cloudflare-pages` × `gitlab-ci`, and so on are all valid combinations.
 *
 * Concrete implementations land in M12.3 (Vercel) and M12.4 (github-actions).
 * Recipe-level orchestration over composed children is Phase 3 / M5.
 */

export type DeployContext = {
  /** Absolute path of the generated app's root. */
  appRoot: string;
  /** The validated `deploy:` stanza from the manifest. */
  config: Record<string, unknown>;
  /** Process env at invocation time — adapters read tokens from here. */
  env: Record<string, string | undefined>;
  /** When true, the adapter should describe what it would do and not act. */
  dryRun?: boolean;
};

export type DeployResult = {
  /** The URL where the app is now live (omitted when there's nothing to surface, e.g. the null adapter). */
  url?: string;
  /** Raw CLI output captured during the deploy, for logging. */
  logs?: string;
};

export type DeployAdapter = {
  /** Canonical name as written in the manifest stanza (kebab-case). */
  name: string;
  /** Env vars required for a real deploy (e.g. `['VERCEL_TOKEN']`). */
  requiredEnv: readonly string[];
  /**
   * Validate + normalize the adapter-specific portion of the manifest stanza.
   * Throws on invalid input. The returned object is what `DeployContext.config`
   * carries into `deploy()`.
   */
  validateConfig(stanza: Record<string, unknown>): Record<string, unknown>;
  /** Perform the deploy. */
  deploy(ctx: DeployContext): Promise<DeployResult>;
};

export type EmittedFile = {
  /** Path relative to `CicdContext.appRoot`. */
  path: string;
  /** File content (utf-8). */
  content: string;
};

export type CicdContext = {
  /** Absolute path of the generated app's root. */
  appRoot: string;
  /** The validated `cicd:` stanza from the manifest. */
  config: Record<string, unknown>;
  /** Name of the deploy adapter the workflow should invoke (if any). */
  deployAdapter?: string;
  /** Env vars the deploy adapter expects (e.g. `['VERCEL_TOKEN']`) — surfaced to the workflow yaml. */
  deployRequiredEnv?: readonly string[];
};

export type CicdProvider = {
  /** Canonical name as written in the manifest stanza (kebab-case). */
  name: string;
  /**
   * Validate + normalize the provider-specific portion of the manifest stanza.
   * Throws on invalid input.
   */
  validateConfig(stanza: Record<string, unknown>): Record<string, unknown>;
  /** Produce the workflow files for this provider. */
  emitWorkflow(ctx: CicdContext): EmittedFile[];
};
