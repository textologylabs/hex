import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { create } from 'tar';
import { brand } from '../brand/colors.js';
import { loadFromPath } from '../core/sources/file-source.js';

/**
 * `hex publish` (M9.9) — publish a component/recipe to a marketplace.
 *
 * The developer uploads the *unsigned* bundle directory as a gzipped
 * tar; the registry validates it, signs it with the marketplace key,
 * and ingests it (marketplace-as-signer — see M9.1). Authentication is
 * a bearer publish token, not a signing key: developers hold no keys.
 *
 * M15.6 — FENCED as experimental for 1.0. The hosted-registry model is
 * parked (no registry is hosted by default), so the command is hidden
 * from `--help` and prints an experimental notice on run, pointing at
 * the supported git-catalogue model (`hex hive` + a `marketplace.yaml`
 * repo). It still works against a `--registry` you run yourself.
 */

const EXCLUDED = new Set(['.git', 'node_modules', 'dist']);

const EXPERIMENTAL_NOTICE =
  'hex publish targets the experimental hosted-registry model, which is parked for 1.0 — no registry is hosted by default. ' +
  'To share templates today, use a git-catalogue: see docs/guides/catalogue-for-your-org.md. ' +
  'Continuing against the --registry you provided.';

/**
 * Pack a bundle directory into a gzipped tar buffer, skipping `.git`,
 * `node_modules`, and `dist`. The registry re-walks and re-hashes the
 * contents anyway; this just keeps the upload small.
 */
export async function createBundleTarball(dir: string): Promise<Buffer> {
  const scratch = await mkdtemp(join(tmpdir(), 'hex-pub-'));
  const tarPath = join(scratch, 'bundle.tgz');
  try {
    await create(
      {
        gzip: true,
        file: tarPath,
        cwd: dir,
        portable: true,
        filter: (path) => !path.split('/').some((seg) => EXCLUDED.has(seg)),
      },
      ['.'],
    );
    return await readFile(tarPath);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function registerPublish(program: Command): void {
  program
    // M15.6: hidden from `--help` while the hosted registry is parked — the
    // git-catalogue model (`hex hive`) is the supported sharing path for 1.0.
    .command('publish', { hidden: true })
    .description(
      '[experimental] publish a component or recipe to a hosted marketplace registry (parked — see docs/guides/catalogue-for-your-org.md)',
    )
    .argument('<dir>', 'component or recipe directory to publish')
    .requiredOption('--registry <url>', 'registry base URL (e.g. https://registry.hex.dev/)')
    .option('--token <token>', 'publish token (or set HEX_PUBLISH_TOKEN)')
    .option('--description <text>', 'one-line description for the catalogue')
    .option('--category <name...>', 'browse category (repeatable)')
    .action(
      async (
        dir: string,
        opts: {
          registry: string;
          token?: string;
          description?: string;
          category?: string[];
        },
      ) => {
        process.stderr.write(`${brand.dim(EXPERIMENTAL_NOTICE)}\n`);

        const token = opts.token ?? process.env.HEX_PUBLISH_TOKEN;
        if (!token) {
          process.stderr.write(
            `${brand.error('error: no publish token — pass --token or set HEX_PUBLISH_TOKEN')}\n`,
          );
          process.exitCode = 1;
          return;
        }

        // Validate the bundle locally before uploading — a fast, clear
        // failure beats a round-trip to the registry.
        try {
          await loadFromPath(dir);
        } catch (err) {
          process.stderr.write(
            `${brand.error(`error: ${dir} is not a valid Hex bundle: ${err instanceof Error ? err.message : String(err)}`)}\n`,
          );
          process.exitCode = 1;
          return;
        }

        const tarball = await createBundleTarball(dir);
        const url = new URL(
          'publish',
          opts.registry.endsWith('/') ? opts.registry : `${opts.registry}/`,
        );

        const headers: Record<string, string> = {
          authorization: `Bearer ${token}`,
          'content-type': 'application/gzip',
        };
        if (opts.description) headers['x-hex-description'] = opts.description;
        if (opts.category && opts.category.length > 0) {
          headers['x-hex-categories'] = opts.category.join(',');
        }

        let res: Response;
        try {
          res = await fetch(url, { method: 'POST', headers, body: tarball });
        } catch (err) {
          process.stderr.write(
            `${brand.error(`error: could not reach registry ${opts.registry}: ${err instanceof Error ? err.message : String(err)}`)}\n`,
          );
          process.exitCode = 1;
          return;
        }

        const payload = (await res.json().catch(() => ({}))) as {
          published?: { name: string; version: string };
          error?: string;
        };

        if (!res.ok) {
          process.stderr.write(
            `${brand.error(`publish failed (HTTP ${res.status}): ${payload.error ?? res.statusText}`)}\n`,
          );
          process.exitCode = 1;
          return;
        }

        const p = payload.published;
        process.stdout.write(
          `${brand.bold('published')} ${p?.name ?? '?'}@${p?.version ?? '?'} to ${opts.registry}\n`,
        );
      },
    );
}
