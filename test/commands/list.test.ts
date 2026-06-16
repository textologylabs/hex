import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerList } from '../../src/commands/list.js';

let work: string;
let cfgDir: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-cmd-list-'));
  cfgDir = join(work, 'cfg');
  await mkdir(cfgDir, { recursive: true });
  vi.stubEnv('HEX_CONFIG_DIR', cfgDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Run `hex list` (with optional flags) and capture everything written to stdout. */
async function runList(args: string[] = []): Promise<string> {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  });
  const program = new Command();
  program.exitOverride();
  registerList(program);
  await program.parseAsync(['node', 'hex', 'list', ...args], { from: 'node' });
  return out;
}

async function writeComponent(dir: string, name: string): Promise<void> {
  const hexDir = join(dir, '.hex');
  await mkdir(hexDir, { recursive: true });
  await writeFile(
    join(hexDir, 'manifest.yaml'),
    `type: component\nname: ${name}\nversion: 0.1.0\nkind: demo\n`,
    'utf8',
  );
}

describe('hex list (action)', () => {
  it('prints the guidance block when no source roots are configured', async () => {
    const out = await runList();
    expect(out).toContain('No source roots configured');
    expect(out).toContain('sources:');
  });

  it('lists templates discovered across a configured path source', async () => {
    const templatesDir = join(work, 'templates');
    await writeComponent(join(templatesDir, 'alpha'), 'alpha');
    await writeFile(join(cfgDir, 'config.yaml'), `sources:\n  - path: ${templatesDir}\n`, 'utf8');

    const out = await runList();
    expect(out).toContain('alpha');
    expect(out).toContain('@0.1.0');
  });

  it('--json emits a machine-readable shape with templates + warnings', async () => {
    const templatesDir = join(work, 'templates');
    await writeComponent(join(templatesDir, 'beta'), 'beta');
    await writeFile(join(cfgDir, 'config.yaml'), `sources:\n  - path: ${templatesDir}\n`, 'utf8');

    const out = await runList(['--json']);
    const parsed = JSON.parse(out) as {
      templates: Array<{ name: string; version: string }>;
      catalogueEntries: unknown[];
      warnings: unknown[];
    };
    expect(parsed.templates.some((t) => t.name === 'beta')).toBe(true);
    expect(Array.isArray(parsed.catalogueEntries)).toBe(true);
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });

  it('reports "No templates found" for a configured-but-empty source', async () => {
    const emptyDir = join(work, 'empty');
    await mkdir(emptyDir, { recursive: true });
    await writeFile(join(cfgDir, 'config.yaml'), `sources:\n  - path: ${emptyDir}\n`, 'utf8');

    const out = await runList();
    expect(out).toContain('No templates found');
  });
});
