import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getCicdProvider, getDeployAdapter } from './registry.js';
import type { CicdContext } from './types.js';

/**
 * Emit the CI/CD workflow files a template's `cicd:` stanza declares
 * (M12.4 wiring). This is the seam that was missing: `hex new` pinned the
 * `cicd` stanza into the lockfile but never invoked the provider, so the
 * promised `.github/workflows/deploy.yml` was never written and the deploy
 * story only half-worked. Called from the render pipeline once the tree is
 * on disk.
 *
 * The workflow is written as a generated *artifact* — after the pristine
 * baseline is captured, so it is intentionally NOT part of the lockfile's
 * tracked-file table or the `hex upgrade` merge base. It is the developer's
 * to own and edit once scaffolded; Hex does not re-emit or reconcile it on
 * upgrade.
 *
 * Returns the repo-relative paths written (for the render summary), or `[]`
 * when the manifest declares no `cicd` stanza.
 */
export async function emitCicdWorkflows(params: {
  cicd?: Record<string, unknown>;
  deploy?: Record<string, unknown>;
  outputDir: string;
}): Promise<string[]> {
  const { cicd, deploy, outputDir } = params;
  if (!cicd) return [];

  const provider = getCicdProvider(String(cicd.provider ?? ''));

  const deployAdapterName = typeof deploy?.adapter === 'string' ? deploy.adapter : undefined;
  const deployRequiredEnv = deployAdapterName
    ? getDeployAdapter(deployAdapterName).requiredEnv
    : undefined;

  const ctx: CicdContext = {
    appRoot: outputDir,
    config: cicd,
    deployAdapter: deployAdapterName,
    deployRequiredEnv,
  };

  const written: string[] = [];
  for (const file of provider.emitWorkflow(ctx)) {
    const abs = join(outputDir, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, 'utf8');
    written.push(file.path);
  }
  return written;
}
