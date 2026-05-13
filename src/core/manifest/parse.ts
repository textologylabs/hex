import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { manifestSchema } from './schema.js';
import { desugarPrompts } from './shorthand.js';
import type { Manifest } from './types.js';

export class ManifestError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ManifestError';
  }
}

export async function parseManifestFile(path: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new ManifestError(
      `cannot read manifest: ${err instanceof Error ? err.message : String(err)}`,
      path,
    );
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new ManifestError(
      `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
      path,
    );
  }

  return parseManifestObject(data, path);
}

export function parseManifestObject(data: unknown, sourcePath?: string): Manifest {
  if (!data || typeof data !== 'object') {
    throw new ManifestError('manifest must be a mapping at the root', sourcePath);
  }

  const obj = { ...(data as Record<string, unknown>) };

  if ('prompts' in obj && obj.prompts !== undefined) {
    try {
      obj.prompts = desugarPrompts(obj.prompts);
    } catch (err) {
      throw new ManifestError(err instanceof Error ? err.message : String(err), sourcePath);
    }
  }

  if (obj.hooks && typeof obj.hooks === 'object' && !Array.isArray(obj.hooks)) {
    const hooksObj = obj.hooks as Record<string, unknown>;
    for (const lifecycle of ['pre_render', 'post_render'] as const) {
      const entries = hooksObj[lifecycle];
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, idx) => {
        if (!entry || typeof entry !== 'object' || !('js' in entry)) return;
        const e = entry as Record<string, unknown>;
        if (e.prompts === undefined) return;
        try {
          e.prompts = desugarPrompts(e.prompts);
        } catch (err) {
          throw new ManifestError(
            `hooks.${lifecycle}[${idx}].prompts: ${err instanceof Error ? err.message : String(err)}`,
            sourcePath,
          );
        }
      });
    }
  }

  const result = manifestSchema.safeParse(obj);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new ManifestError(`schema validation failed:\n${issues}`, sourcePath);
  }

  return result.data;
}
