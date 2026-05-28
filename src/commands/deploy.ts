import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import {
  type DeployAdapter,
  type DeployResult,
  NULL_ADAPTER_NAME,
  getDeployAdapter,
} from '../core/deploy/index.js';
import { type LoadedLockfile, readLockfileUpward } from '../core/lockfile/index.js';

/**
 * `hex deploy` (M12.2). Resolves the deploy adapter pinned in the
 * generated app's `.hex/lockfile.yaml`, validates its config and required
 * env, then invokes it. Effects-injection mirrors `hex setup` so the
 * action callback's branches are testable end-to-end without touching
 * `process` or the real adapter.
 */
export type DeployCommandOptions = {
  dryRun?: boolean;
};

export type DeployCommandEffects = {
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  setExitCode: (code: number) => void;
  env: Record<string, string | undefined>;
  /**
   * Resolver indirection — production reads from the process-wide
   * registry; tests substitute a scripted adapter without registering
   * it into the singleton.
   */
  resolveAdapter: (name: string) => DeployAdapter;
};

export const defaultDeployCommandEffects: DeployCommandEffects = {
  stdout: process.stdout,
  stderr: process.stderr,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  env: process.env,
  resolveAdapter: getDeployAdapter,
};

export function registerDeploy(program: Command): void {
  program
    .command('deploy')
    .description('deploy the current project via its configured deploy adapter')
    .option('--dry-run', 'describe the planned invocation without running it')
    .action(async (opts: { dryRun?: boolean }) => {
      await runDeployCommand(process.cwd(), defaultDeployCommandEffects, {
        dryRun: opts.dryRun === true,
      });
    });
}

export async function runDeployCommand(
  cwd: string,
  effects: DeployCommandEffects,
  opts: DeployCommandOptions = {},
): Promise<void> {
  const loaded = await readLockfileUpward(cwd);
  if (!loaded) {
    effects.stderr.write(
      `${brand.error('No .hex/lockfile.yaml found in the current directory or any ancestor.')}\n`,
    );
    effects.setExitCode(1);
    return;
  }

  const deploy = loaded.lockfile.deploy;
  if (!deploy || deploy.adapter === NULL_ADAPTER_NAME) {
    effects.stdout.write(`${brand.dim('No deploy adapter configured — nothing to do.')}\n`);
    return;
  }

  let adapter: DeployAdapter;
  try {
    adapter = effects.resolveAdapter(deploy.adapter);
  } catch (err) {
    effects.stderr.write(`${brand.error(err instanceof Error ? err.message : String(err))}\n`);
    effects.setExitCode(1);
    return;
  }

  let config: Record<string, unknown>;
  try {
    config = adapter.validateConfig(deploy);
  } catch (err) {
    effects.stderr.write(
      `${brand.error(`invalid deploy config: ${err instanceof Error ? err.message : String(err)}`)}\n`,
    );
    effects.setExitCode(1);
    return;
  }

  if (opts.dryRun) {
    printDryRun(effects, adapter, loaded);
    return;
  }

  const missing = adapter.requiredEnv.filter((name) => !effects.env[name]);
  if (missing.length > 0) {
    effects.stderr.write(`${brand.error(`missing required env vars: ${missing.join(', ')}`)}\n`);
    effects.setExitCode(1);
    return;
  }

  let result: DeployResult;
  try {
    result = await adapter.deploy({
      appRoot: loaded.rootDir,
      config,
      env: effects.env,
    });
  } catch (err) {
    effects.stderr.write(
      `${brand.error(`deploy failed: ${err instanceof Error ? err.message : String(err)}`)}\n`,
    );
    effects.setExitCode(1);
    return;
  }

  printResult(effects, adapter, result);
}

function printDryRun(
  effects: DeployCommandEffects,
  adapter: DeployAdapter,
  loaded: LoadedLockfile,
): void {
  effects.stdout.write(`${brand.honeyBold(' hex deploy ')}\n`);
  effects.stdout.write(`adapter: ${adapter.name}\n`);
  effects.stdout.write(`appRoot: ${loaded.rootDir}\n`);
  if (adapter.requiredEnv.length > 0) {
    const present = adapter.requiredEnv.map((name) =>
      effects.env[name] ? `${name}=<set>` : `${name}=<missing>`,
    );
    effects.stdout.write(`requiredEnv: ${present.join(', ')}\n`);
  }
  effects.stdout.write(`${brand.dim('--dry-run: not actually deploying.')}\n`);
}

function printResult(
  effects: DeployCommandEffects,
  adapter: DeployAdapter,
  result: DeployResult,
): void {
  if (result.url) {
    effects.stdout.write(`${brand.done(`Deployed via ${adapter.name}: ${result.url}`)}\n`);
    return;
  }
  effects.stdout.write(`${brand.done(`Deployed via ${adapter.name}.`)}\n`);
}
