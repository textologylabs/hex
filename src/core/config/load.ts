import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { hexConfigSchema } from './schema.js';
import type { HexConfig } from './types.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ConfigError';
  }
}

export type LoadConfigOpts = {
  configDir?: string;
};

const CONFIG_FILE = 'config.yaml';

/**
 * Resolve the effective config directory:
 *   1. explicit `configDir` arg (test injection),
 *   2. HEX_CONFIG_DIR env var (test isolation without monkey-patching $HOME),
 *   3. ~/.hex/ (production default).
 */
export function getDefaultConfigDir(opts?: LoadConfigOpts): string {
  if (opts?.configDir) return opts.configDir;
  const envDir = process.env.HEX_CONFIG_DIR;
  if (envDir && envDir.length > 0) return envDir;
  return join(homedir(), '.hex');
}

export function getDefaultConfigPath(opts?: LoadConfigOpts): string {
  return join(getDefaultConfigDir(opts), CONFIG_FILE);
}

/**
 * Load `<configDir>/config.yaml`. Missing file is not an error — first
 * run returns an empty source list. Malformed YAML or schema violations
 * raise `ConfigError` with the file path attached.
 *
 * Source-root paths are normalised: `~` is home-expanded, and relatives
 * resolve against the config file's directory so a portable config can
 * ship alongside the dotfiles repo without depending on `$PWD`.
 */
export async function loadConfig(opts?: LoadConfigOpts): Promise<HexConfig> {
  const configPath = getDefaultConfigPath(opts);
  const configDir = dirname(configPath);

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { sources: [], marketplaces: [] };
    }
    throw new ConfigError(
      `cannot read config: ${err instanceof Error ? err.message : String(err)}`,
      configPath,
    );
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(
      `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
      configPath,
    );
  }

  // Empty file → empty config. yaml.parse returns null for an empty doc.
  if (data === null || data === undefined) return { sources: [], marketplaces: [] };

  const result = hexConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`schema validation failed:\n${issues}`, configPath);
  }

  return {
    sources: result.data.sources.map((s) => {
      if ('path' in s) {
        return { kind: 'path' as const, path: normalisePath(s.path, configDir) };
      }
      return { kind: 'git' as const, url: s.git, ref: s.ref };
    }),
    marketplaces: result.data.marketplaces.map((m) => ({ id: m.id, registry: m.registry })),
  };
}

function normalisePath(p: string, configDir: string): string {
  if (p.startsWith('~/') || p === '~') {
    return p === '~' ? homedir() : join(homedir(), p.slice(2));
  }
  if (isAbsolute(p)) return p;
  return resolve(configDir, p);
}
