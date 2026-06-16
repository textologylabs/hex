import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPublish } from '../../src/commands/publish.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-cmd-publish-'));
  // Empty string is falsy → the action takes the "no token" path, without
  // depending on (or mutating) the ambient HEX_PUBLISH_TOKEN.
  vi.stubEnv('HEX_PUBLISH_TOKEN', '');
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(work, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('hex publish registration (M15.6 fence)', () => {
  it('is hidden from --help', () => {
    const program = new Command();
    registerPublish(program);
    const visible = program
      .createHelp()
      .visibleCommands(program)
      .map((c) => c.name());
    expect(visible).not.toContain('publish');
  });

  it('stays registered (hidden, not removed) and marked experimental', () => {
    const program = new Command();
    registerPublish(program);
    const publish = program.commands.find((c) => c.name() === 'publish');
    expect(publish).toBeDefined();
    expect(publish?.description()).toContain('[experimental]');
  });
});

describe('hex publish (action — fenced)', () => {
  it('prints the experimental notice and exits 1 when no token is available', async () => {
    let err = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      err += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });

    const program = new Command();
    program.exitOverride();
    registerPublish(program);
    await program.parseAsync(['node', 'hex', 'publish', work, '--registry', 'http://localhost:9'], {
      from: 'node',
    });

    expect(err).toContain('experimental hosted-registry model');
    expect(err).toContain('git-catalogue');
    expect(err).toContain('no publish token');
    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-bundle directory with a clear error (token present)', async () => {
    vi.stubEnv('HEX_PUBLISH_TOKEN', 'tok');
    let err = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      err += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
    // `work` has no .hex/manifest.yaml → not a valid bundle.
    await writeFile(join(work, 'placeholder.txt'), 'x', 'utf8');
    await mkdir(join(work, 'sub'), { recursive: true });

    const program = new Command();
    program.exitOverride();
    registerPublish(program);
    await program.parseAsync(['node', 'hex', 'publish', work, '--registry', 'http://localhost:9'], {
      from: 'node',
    });

    expect(err).toContain('is not a valid Hex bundle');
    expect(process.exitCode).toBe(1);
  });
});
