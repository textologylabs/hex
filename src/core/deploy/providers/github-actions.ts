import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { CicdContext, CicdProvider, EmittedFile } from '../types.js';

/**
 * GitHub Actions CI/CD provider (M12.4). Emits
 * `.github/workflows/deploy.yml` — a workflow that runs the standard
 * build pipeline (install → typecheck → test → lint → build) and then
 * dispatches to whichever deploy adapter the manifest pins.
 *
 * Manifest stanza:
 *
 * ```yaml
 * cicd:
 *   provider: github-actions
 *   node-version: '20'        # default
 *   deploy-on: push-main      # default; later: tag, manual
 * ```
 *
 * The deploy step is adapter-aware: a known adapter (e.g. `vercel`)
 * gets its native CLI invocation, with the right secret name in `env`.
 * Unknown adapters are rejected at emit time — pinning per-adapter
 * yaml here keeps M12 minimal; future adapters extend the dispatch in
 * `renderDeployStep`. The richer "step contribution" model from
 * idea.md §10 lives in Phase 3.
 */

const WORKFLOW_PATH = '.github/workflows/deploy.yml';

export const GITHUB_ACTIONS_PROVIDER_NAME = 'github-actions';

const DEPLOY_ON_VALUES = ['push-main', 'manual'] as const;
type DeployOn = (typeof DEPLOY_ON_VALUES)[number];

const githubActionsConfigSchema = z
  .object({
    provider: z.literal(GITHUB_ACTIONS_PROVIDER_NAME),
    'node-version': z.string().min(1).optional(),
    'deploy-on': z.enum(DEPLOY_ON_VALUES).optional(),
  })
  .strict();

export class GithubActionsProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubActionsProviderError';
  }
}

type ResolvedConfig = {
  nodeVersion: string;
  deployOn: DeployOn;
};

function resolveConfig(stanza: Record<string, unknown>): ResolvedConfig {
  const parsed = githubActionsConfigSchema.safeParse(stanza);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new GithubActionsProviderError(`invalid github-actions stanza: ${issues}`);
  }
  return {
    nodeVersion: parsed.data['node-version'] ?? '20',
    deployOn: parsed.data['deploy-on'] ?? 'push-main',
  };
}

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};

export function createGithubActionsProvider(): CicdProvider {
  return {
    name: GITHUB_ACTIONS_PROVIDER_NAME,
    validateConfig(stanza) {
      const parsed = githubActionsConfigSchema.safeParse(stanza);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        throw new GithubActionsProviderError(`invalid github-actions stanza: ${issues}`);
      }
      return parsed.data;
    },
    emitWorkflow(ctx: CicdContext): EmittedFile[] {
      const config = resolveConfig(ctx.config);
      if (!ctx.deployAdapter) {
        throw new GithubActionsProviderError(
          'cicd provider github-actions requires a deploy adapter to be configured',
        );
      }
      const deployStep = renderDeployStep(ctx.deployAdapter, ctx.deployRequiredEnv ?? []);

      const workflow = {
        name: 'Deploy',
        on: triggerFor(config.deployOn),
        permissions: { contents: 'read' },
        jobs: {
          deploy: {
            'runs-on': 'ubuntu-latest',
            steps: [
              { uses: 'actions/checkout@v4' },
              {
                uses: 'actions/setup-node@v4',
                with: { 'node-version': config.nodeVersion, cache: 'npm' },
              },
              { run: 'npm ci' },
              { run: 'npm run typecheck' },
              { run: 'npm run test' },
              { run: 'npm run lint' },
              { run: 'npm run build' },
              deployStep,
            ] satisfies WorkflowStep[],
          },
        },
      };

      const content = stringifyYaml(workflow);
      return [{ path: WORKFLOW_PATH, content }];
    },
  };
}

function triggerFor(mode: DeployOn): Record<string, unknown> {
  if (mode === 'manual') {
    return { workflow_dispatch: {} };
  }
  return { push: { branches: ['main'] } };
}

function renderDeployStep(adapterName: string, requiredEnv: readonly string[]): WorkflowStep {
  switch (adapterName) {
    case 'vercel': {
      const env: Record<string, string> = {};
      for (const name of requiredEnv) {
        env[name] = `\${{ secrets.${name} }}`;
      }
      return {
        name: 'Deploy via vercel',
        env,
        run: 'npx --yes vercel@latest deploy --yes --prod --token "$VERCEL_TOKEN"',
      };
    }
    case 'none':
      return {
        name: 'No-op deploy',
        run: 'echo "no deploy adapter configured"',
      };
    default:
      throw new GithubActionsProviderError(
        `github-actions provider does not yet know how to deploy via adapter "${adapterName}"`,
      );
  }
}

export const githubActionsProvider = createGithubActionsProvider();
