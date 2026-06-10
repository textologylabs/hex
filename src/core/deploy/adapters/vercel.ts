import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { DeployAdapter, DeployContext, DeployResult } from '../types.js';

/**
 * Vercel deploy adapter (M12.3). Shells out to the official `vercel`
 * CLI, parses the deploy URL from stdout, and surfaces stderr cleanly
 * when the CLI fails (auth error, build error, …).
 *
 * Manifest stanza:
 *
 * ```yaml
 * deploy:
 *   adapter: vercel
 *   prod: false   # default; true → pass --prod
 * ```
 *
 * Token is read from `VERCEL_TOKEN`. The Hex CLI never prompts on behalf
 * of vercel — we pass `--yes` so a project that's not already linked
 * does not hang the deploy waiting for stdin.
 *
 * **Invocation (M14.10).** We always go through `npx --yes vercel …`
 * rather than calling `vercel` directly so users don't need a global
 * `npm i -g vercel` first. The `--yes` on `npx` auto-confirms the
 * on-demand install; the `--yes` on the vercel sub-command (still
 * present) keeps suppressing vercel's own interactive link prompt.
 */

const NPX_BIN = 'npx';
const VERCEL_TOKEN_ENV = 'VERCEL_TOKEN';

const vercelConfigSchema = z
  .object({
    adapter: z.literal('vercel'),
    prod: z.boolean().optional(),
  })
  .strict();

export type VercelRunnerResult = { stdout: string; stderr: string };

/**
 * Process-runner shape — the adapter calls this instead of `execFile`
 * directly so tests can substitute a scripted runner. The default
 * implementation shells out to `vercel` and returns stdout/stderr.
 */
export type VercelRunner = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => Promise<VercelRunnerResult>;

export class VercelDeployError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'VercelDeployError';
  }
}

const execFileAsync = promisify(execFile);

const defaultRunner: VercelRunner = async (command, args, opts) => {
  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) {
    if (typeof v === 'string') filteredEnv[k] = v;
  }
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: opts.cwd,
    env: filteredEnv,
  });
  return { stdout, stderr };
};

export type CreateVercelAdapterOptions = {
  /** Override the process runner (test injection). */
  runner?: VercelRunner;
};

export function createVercelAdapter(opts: CreateVercelAdapterOptions = {}): DeployAdapter {
  const runner = opts.runner ?? defaultRunner;

  return {
    name: 'vercel',
    requiredEnv: [VERCEL_TOKEN_ENV],
    validateConfig(stanza) {
      const parsed = vercelConfigSchema.safeParse(stanza);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        throw new VercelDeployError(`invalid vercel deploy stanza: ${issues}`);
      }
      return parsed.data;
    },
    async deploy(ctx: DeployContext): Promise<DeployResult> {
      const config = vercelConfigSchema.parse(ctx.config);
      const token = ctx.env[VERCEL_TOKEN_ENV];
      if (!token) {
        throw new VercelDeployError(`${VERCEL_TOKEN_ENV} is not set`);
      }
      const args = ['--yes', 'vercel', 'deploy', '--yes', '--token', token];
      if (config.prod) args.push('--prod');

      let result: VercelRunnerResult;
      try {
        result = await runner(NPX_BIN, args, { cwd: ctx.appRoot, env: ctx.env });
      } catch (err) {
        const cliStderr = readStderr(err);
        throw new VercelDeployError(
          `vercel CLI failed: ${err instanceof Error ? err.message : String(err)}`,
          cliStderr,
        );
      }

      const url = extractDeployUrl(result.stdout);
      const logs = result.stderr ? `${result.stdout}\n${result.stderr}` : result.stdout;
      return url ? { url, logs } : { logs };
    },
  };
}

/**
 * Pull the deploy URL out of vercel CLI stdout. The CLI's "Preview:" or
 * "Production:" line carries an `https://…vercel.app` URL — we take the
 * last `https://` URL in stdout, which is robust across CLI versions.
 */
export function extractDeployUrl(stdout: string): string | undefined {
  const matches = stdout.match(/https:\/\/[^\s\]<>")]+/g);
  if (!matches || matches.length === 0) return undefined;
  return matches[matches.length - 1];
}

function readStderr(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { stderr?: unknown };
  if (typeof e.stderr === 'string') return e.stderr;
  if (Buffer.isBuffer(e.stderr)) return e.stderr.toString('utf8');
  return undefined;
}

/** Default singleton — registered into the deploy registry on bootstrap. */
export const vercelAdapter = createVercelAdapter();
