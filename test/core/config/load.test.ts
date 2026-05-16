import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/core/config/load.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hex-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns empty sources when the config file is absent', async () => {
    const cfg = await loadConfig({ configDir: dir });
    expect(cfg).toEqual({ sources: [], marketplaces: [] });
  });

  it('returns empty sources when the config file is empty', async () => {
    await writeFile(join(dir, 'config.yaml'), '', 'utf8');
    const cfg = await loadConfig({ configDir: dir });
    expect(cfg).toEqual({ sources: [], marketplaces: [] });
  });

  it('parses a config with multiple absolute source roots', async () => {
    await writeFile(
      join(dir, 'config.yaml'),
      'sources:\n  - path: /opt/templates\n  - path: /tmp/templates\n',
      'utf8',
    );
    const cfg = await loadConfig({ configDir: dir });
    expect(cfg.sources).toEqual([
      { kind: 'path', path: '/opt/templates' },
      { kind: 'path', path: '/tmp/templates' },
    ]);
  });

  it('resolves relative source paths against the config directory', async () => {
    await mkdir(join(dir, 'templates'), { recursive: true });
    await writeFile(join(dir, 'config.yaml'), 'sources:\n  - path: templates\n', 'utf8');
    const cfg = await loadConfig({ configDir: dir });
    const first = cfg.sources[0];
    expect(first?.kind).toBe('path');
    if (first?.kind === 'path') expect(first.path).toBe(join(dir, 'templates'));
  });

  it('expands ~ in source paths to the home directory', async () => {
    await writeFile(join(dir, 'config.yaml'), 'sources:\n  - path: ~/dev/templates\n', 'utf8');
    const cfg = await loadConfig({ configDir: dir });
    const first = cfg.sources[0];
    expect(first?.kind).toBe('path');
    if (first?.kind === 'path') {
      expect(first.path).toMatch(/dev\/templates$/);
      expect(first.path).not.toContain('~');
    }
  });

  it('honours HEX_CONFIG_DIR over default ~/.hex', async () => {
    await writeFile(join(dir, 'config.yaml'), 'sources:\n  - path: /x\n', 'utf8');
    const before = process.env.HEX_CONFIG_DIR;
    process.env.HEX_CONFIG_DIR = dir;
    try {
      const cfg = await loadConfig();
      expect(cfg.sources).toEqual([{ kind: 'path', path: '/x' }]);
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, 'HEX_CONFIG_DIR');
      else process.env.HEX_CONFIG_DIR = before;
    }
  });

  it('parses a git source root with a ref', async () => {
    await writeFile(
      join(dir, 'config.yaml'),
      'sources:\n  - git: https://github.com/acme/templates\n    ref: v1.2.0\n',
      'utf8',
    );
    const cfg = await loadConfig({ configDir: dir });
    expect(cfg.sources).toEqual([
      { kind: 'git', url: 'https://github.com/acme/templates', ref: 'v1.2.0' },
    ]);
  });

  it('parses a git source root without a ref (defaults to upstream HEAD later)', async () => {
    await writeFile(
      join(dir, 'config.yaml'),
      'sources:\n  - git: git@github.com:acme/templates.git\n',
      'utf8',
    );
    const cfg = await loadConfig({ configDir: dir });
    expect(cfg.sources).toEqual([
      { kind: 'git', url: 'git@github.com:acme/templates.git', ref: undefined },
    ]);
  });

  it('parses a config with mixed path and git sources, preserving order', async () => {
    await writeFile(
      join(dir, 'config.yaml'),
      'sources:\n' +
        '  - path: /opt/templates\n' +
        '  - git: https://github.com/acme/templates\n' +
        '    ref: main\n' +
        '  - path: /tmp/templates\n',
      'utf8',
    );
    const cfg = await loadConfig({ configDir: dir });
    expect(cfg.sources).toEqual([
      { kind: 'path', path: '/opt/templates' },
      { kind: 'git', url: 'https://github.com/acme/templates', ref: 'main' },
      { kind: 'path', path: '/tmp/templates' },
    ]);
  });

  it('rejects a source entry that has neither path nor git', async () => {
    await writeFile(join(dir, 'config.yaml'), 'sources:\n  - { ref: main }\n', 'utf8');
    await expect(loadConfig({ configDir: dir })).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError on malformed YAML', async () => {
    await writeFile(join(dir, 'config.yaml'), 'sources: [\n  not-a-mapping\n', 'utf8');
    await expect(loadConfig({ configDir: dir })).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError on schema violation', async () => {
    await writeFile(join(dir, 'config.yaml'), 'sources:\n  - { wrong_field: value }\n', 'utf8');
    await expect(loadConfig({ configDir: dir })).rejects.toThrow(ConfigError);
  });

  it('parses a marketplaces block in declared order', async () => {
    await writeFile(
      join(dir, 'config.yaml'),
      `marketplaces:
  - id: hex
    registry: https://registry.hex.dev/
  - id: acme
    registry: https://mkt.acme.internal/
`,
      'utf8',
    );
    const cfg = await loadConfig({ configDir: dir });
    expect(cfg.marketplaces).toEqual([
      { id: 'hex', registry: 'https://registry.hex.dev/' },
      { id: 'acme', registry: 'https://mkt.acme.internal/' },
    ]);
  });

  it('defaults marketplaces to empty when the block is absent', async () => {
    await writeFile(join(dir, 'config.yaml'), 'sources:\n  - path: /x\n', 'utf8');
    const cfg = await loadConfig({ configDir: dir });
    expect(cfg.marketplaces).toEqual([]);
  });

  it('rejects a duplicate marketplace id', async () => {
    await writeFile(
      join(dir, 'config.yaml'),
      `marketplaces:
  - id: hex
    registry: https://a/
  - id: hex
    registry: https://b/
`,
      'utf8',
    );
    await expect(loadConfig({ configDir: dir })).rejects.toThrow(/duplicate marketplace id/);
  });

  it('rejects an invalid marketplace id', async () => {
    await writeFile(
      join(dir, 'config.yaml'),
      'marketplaces:\n  - { id: "Bad ID", registry: https://a/ }\n',
      'utf8',
    );
    await expect(loadConfig({ configDir: dir })).rejects.toThrow(ConfigError);
  });
});
