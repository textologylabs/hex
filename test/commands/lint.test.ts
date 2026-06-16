import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLint } from '../../src/commands/lint.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-cmd-lint-'));
  process.exitCode = undefined;
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** Run `hex lint <path>`, capturing console.log output. */
async function runLint(path: string): Promise<string> {
  let out = '';
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out += `${args.join(' ')}\n`;
  });
  const program = new Command();
  program.exitOverride();
  registerLint(program);
  await program.parseAsync(['node', 'hex', 'lint', path], { from: 'node' });
  return out;
}

async function writeManifest(dir: string, body: string): Promise<void> {
  const hexDir = join(dir, '.hex');
  await mkdir(hexDir, { recursive: true });
  await writeFile(join(hexDir, 'manifest.yaml'), body, 'utf8');
}

describe('hex lint (action)', () => {
  it('reports "nothing to lint" for a real-only component (no stub block)', async () => {
    const dir = join(work, 'plain');
    await writeManifest(dir, 'type: component\nname: plain\nversion: 0.1.0\n');
    const out = await runLint(dir);
    expect(out).toContain('declares no `stub:` block');
    expect(process.exitCode).not.toBe(1);
  });

  it('skips a recipe with the "components only" note', async () => {
    const dir = join(work, 'rcp');
    await writeManifest(dir, 'type: recipe\nname: rcp\nversion: 0.1.0\n');
    const out = await runLint(dir);
    expect(out).toContain('stub lint applies to components only');
    expect(process.exitCode).not.toBe(1);
  });

  it('fails (exit 1) for a stub component that violates the prod-clean conventions', async () => {
    // Declares pg-mem as a stub engine but ships it as a *production* dependency
    // (and no separate dev entry point) — the lint should flag it.
    const dir = join(work, 'badstub');
    await writeManifest(
      dir,
      'type: component\nname: badstub\nversion: 0.1.0\nkind: db\nstub:\n  engine: pg-mem\n',
    );
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'badstub', dependencies: { 'pg-mem': '^3.0.0' } }, null, 2),
      'utf8',
    );
    const out = await runLint(dir);
    expect(out).toContain('stub engine: pg-mem');
    expect(out).toContain('prod-clean: ✗');
    expect(process.exitCode).toBe(1);
  });
});
