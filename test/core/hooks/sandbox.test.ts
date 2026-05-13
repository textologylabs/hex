import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectFs } from '../../../src/core/hooks/project-fs.js';
import { SandboxError, createSandbox } from '../../../src/core/hooks/sandbox.js';

describe('createSandbox', () => {
  it('evaluates a no-op script and returns undefined', async () => {
    const sandbox = await createSandbox();
    try {
      expect(sandbox.runScript('undefined')).toBeUndefined();
    } finally {
      sandbox.dispose();
    }
  });

  it('returns primitive values from evaluated scripts', async () => {
    const sandbox = await createSandbox();
    try {
      expect(sandbox.runScript('1 + 1')).toBe(2);
      expect(sandbox.runScript('"hello"')).toBe('hello');
      expect(sandbox.runScript('true')).toBe(true);
    } finally {
      sandbox.dispose();
    }
  });

  it('returns plain object literals via dump', async () => {
    const sandbox = await createSandbox();
    try {
      expect(sandbox.runScript('({ a: 1, b: [2, 3] })')).toEqual({ a: 1, b: [2, 3] });
    } finally {
      sandbox.dispose();
    }
  });

  it('exposes no Node primitives inside the sandbox', async () => {
    const sandbox = await createSandbox();
    try {
      expect(sandbox.runScript('typeof require')).toBe('undefined');
      expect(sandbox.runScript('typeof process')).toBe('undefined');
      expect(sandbox.runScript('typeof globalThis.fs')).toBe('undefined');
    } finally {
      sandbox.dispose();
    }
  });

  it('throws SandboxError when the script throws', async () => {
    const sandbox = await createSandbox();
    try {
      expect(() => sandbox.runScript('throw new Error("boom")')).toThrow(SandboxError);
      expect(() => sandbox.runScript('throw new Error("boom")')).toThrow(/boom/);
    } finally {
      sandbox.dispose();
    }
  });

  it('remains usable after a script throws', async () => {
    const sandbox = await createSandbox();
    try {
      expect(() => sandbox.runScript('throw new Error("first")')).toThrow(SandboxError);
      expect(sandbox.runScript('1 + 1')).toBe(2);
    } finally {
      sandbox.dispose();
    }
  });

  it('runs many scripts within a single sandbox lifecycle', async () => {
    const sandbox = await createSandbox();
    try {
      for (let i = 0; i < 10; i += 1) {
        expect(sandbox.runScript(`${i} * 2`)).toBe(i * 2);
      }
    } finally {
      sandbox.dispose();
    }
  });

  it('trips the CPU budget on a tight loop', async () => {
    const sandbox = await createSandbox({ cpuMs: 50 });
    try {
      expect(() => sandbox.runScript('while (true) {}')).toThrow(SandboxError);
    } finally {
      sandbox.dispose();
    }
  });

  it('trips the memory limit on an unbounded allocation', async () => {
    const sandbox = await createSandbox({ memoryBytes: 1 * 1024 * 1024 });
    try {
      expect(() =>
        sandbox.runScript('const a = []; while (true) { a.push(new Array(10000).fill(0)); }'),
      ).toThrow(SandboxError);
    } finally {
      sandbox.dispose();
    }
  });

  it('rejects further runScript calls after dispose', async () => {
    const sandbox = await createSandbox();
    sandbox.dispose();
    expect(() => sandbox.runScript('1')).toThrow(/disposed/);
  });

  it('is safe to dispose twice', async () => {
    const sandbox = await createSandbox();
    sandbox.dispose();
    expect(() => sandbox.dispose()).not.toThrow();
  });

  it('supports dispose-then-re-init for fresh isolated runtimes', async () => {
    const first = await createSandbox();
    first.runScript('globalThis.leaked = 42');
    first.dispose();

    const second = await createSandbox();
    try {
      expect(second.runScript('typeof globalThis.leaked')).toBe('undefined');
    } finally {
      second.dispose();
    }
  });

  it('resets the CPU deadline between calls so long-lived sandboxes do not trip on cumulative time', async () => {
    const sandbox = await createSandbox({ cpuMs: 1_000 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sandbox.runScript('1 + 1')).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sandbox.runScript('2 + 2')).toBe(4);
    } finally {
      sandbox.dispose();
    }
  });
});

describe('Sandbox.installProjectFs', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'hex-sandbox-pfs-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('exposes project.read inside the sandbox', async () => {
    await writeFile(join(work, 'note.txt'), 'hi', 'utf8');
    const sandbox = await createSandbox();
    try {
      sandbox.installProjectFs(new ProjectFs(work));
      expect(sandbox.runScript("project.read('note.txt')")).toBe('hi');
    } finally {
      sandbox.dispose();
    }
  });

  it('exposes project.write inside the sandbox', async () => {
    const sandbox = await createSandbox();
    try {
      const fs = new ProjectFs(work);
      sandbox.installProjectFs(fs);
      sandbox.runScript("project.write('out.txt', 'from-hook')");
      expect(fs.read('out.txt')).toBe('from-hook');
    } finally {
      sandbox.dispose();
    }
  });

  it('exposes project.exists, project.list, project.delete inside the sandbox', async () => {
    await writeFile(join(work, 'a.txt'), '', 'utf8');
    await writeFile(join(work, 'b.txt'), '', 'utf8');
    const sandbox = await createSandbox();
    try {
      sandbox.installProjectFs(new ProjectFs(work));
      expect(sandbox.runScript("project.exists('a.txt')")).toBe(true);
      expect(sandbox.runScript("project.exists('missing')")).toBe(false);
      const listed = sandbox.runScript("project.list('.').sort()") as string[];
      expect(listed).toEqual(['a.txt', 'b.txt']);
      sandbox.runScript("project.delete('a.txt')");
      expect(sandbox.runScript("project.exists('a.txt')")).toBe(false);
    } finally {
      sandbox.dispose();
    }
  });

  it('surfaces traversal rejection as a JS error inside the hook (catchable)', async () => {
    const sandbox = await createSandbox();
    try {
      sandbox.installProjectFs(new ProjectFs(work));
      const result = sandbox.runScript(`
        try {
          project.read('../escape');
          'no throw';
        } catch (e) {
          e.message;
        }
      `);
      expect(result).toMatch(/escapes project root/);
    } finally {
      sandbox.dispose();
    }
  });

  it('surfaces an absolute-path rejection as a JS error inside the hook', async () => {
    const sandbox = await createSandbox();
    try {
      sandbox.installProjectFs(new ProjectFs(work));
      const result = sandbox.runScript(`
        try {
          project.read('/etc/passwd');
          'no throw';
        } catch (e) {
          e.message;
        }
      `);
      expect(result).toMatch(/absolute paths are not allowed/);
    } finally {
      sandbox.dispose();
    }
  });

  it('propagates an uncaught project error as a SandboxError on the host', async () => {
    const sandbox = await createSandbox();
    try {
      sandbox.installProjectFs(new ProjectFs(work));
      expect(() => sandbox.runScript("project.read('../escape')")).toThrow(SandboxError);
    } finally {
      sandbox.dispose();
    }
  });

  it('rejects installProjectFs on a disposed sandbox', async () => {
    const sandbox = await createSandbox();
    sandbox.dispose();
    expect(() => sandbox.installProjectFs(new ProjectFs(work))).toThrow(/disposed/);
  });
});
