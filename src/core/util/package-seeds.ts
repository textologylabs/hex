import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Answers } from '../prompts/types.js';

/**
 * package.json seed values — the answers a manually-maintained project
 * carries in-band. Read by hexify (auto parameterisation candidates,
 * agent briefing) and by adopt (A3 answer bootstrap: prompt defaults).
 */
export type PackageSeeds = {
  name?: string;
  description?: string;
  author?: string;
  license?: string;
};

export async function readPackageSeeds(repoRoot: string): Promise<PackageSeeds> {
  try {
    const raw = await readFile(join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const author =
      typeof pkg.author === 'object' && pkg.author !== null
        ? str((pkg.author as Record<string, unknown>).name)
        : str(pkg.author);
    return {
      name: str(pkg.name),
      description: str(pkg.description),
      author,
      license: str(pkg.license),
    };
  } catch {
    return {};
  }
}

/**
 * The seed→prompt-name convention, in ONE place so hexify's generated
 * prompts and adopt's bootstrap defaults can never drift apart:
 * hexify names its auto candidates project_name / description / author /
 * license, so a hexified template's prompts match these keys exactly.
 */
export function seedDefaults(seeds: PackageSeeds): Answers {
  const out: Answers = {};
  if (seeds.name !== undefined) out.project_name = seeds.name;
  if (seeds.description !== undefined) out.description = seeds.description;
  if (seeds.author !== undefined) out.author = seeds.author;
  if (seeds.license !== undefined) out.license = seeds.license;
  return out;
}
