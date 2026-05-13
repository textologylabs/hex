import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManifestError } from '../../../src/core/manifest/parse.js';
import { SourceError, loadFromPath } from '../../../src/core/sources/file-source.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-file-source-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeManifest(
  rootPath: string,
  body: string,
  fileName = 'manifest.yaml',
): Promise<void> {
  await mkdir(join(rootPath, '.hex'), { recursive: true });
  await writeFile(join(rootPath, '.hex', fileName), body, 'utf8');
}

describe('FileSource — loadFromPath', () => {
  it('loads a valid template bundle', async () => {
    await writeManifest(
      work,
      `type: component
name: demo
version: 0.1.0
prompts:
  - project_name: { type: string, required: true }
`,
    );
    const bundle = await loadFromPath(work);
    expect(bundle.rootPath).toBe(work);
    expect(bundle.manifest.name).toBe('demo');
    expect(bundle.manifest.prompts?.[0]?.name).toBe('project_name');
  });

  it('also accepts manifest.yml as an alternative extension', async () => {
    await writeManifest(
      work,
      `type: component
name: demo
version: 0.1.0
`,
      'manifest.yml',
    );
    const bundle = await loadFromPath(work);
    expect(bundle.manifest.name).toBe('demo');
  });

  it('rejects a non-existent path', async () => {
    await expect(loadFromPath(join(work, 'does-not-exist'))).rejects.toThrow(SourceError);
  });

  it('rejects a path that is not a directory', async () => {
    const filePath = join(work, 'just-a-file.txt');
    await writeFile(filePath, 'hello', 'utf8');
    await expect(loadFromPath(filePath)).rejects.toThrow(SourceError);
  });

  it('rejects a directory missing .hex/manifest.yaml', async () => {
    await expect(loadFromPath(work)).rejects.toThrow(SourceError);
  });

  it('propagates manifest validation errors', async () => {
    await writeManifest(
      work,
      `type: component
name: demo
version: not-a-version
`,
    );
    await expect(loadFromPath(work)).rejects.toThrow(ManifestError);
  });

  it('resolves a relative path against cwd', async () => {
    await writeManifest(
      work,
      `type: component
name: demo
version: 0.1.0
`,
    );
    const cwd = process.cwd();
    process.chdir(work);
    try {
      const bundle = await loadFromPath('.');
      expect(bundle.manifest.name).toBe('demo');
    } finally {
      process.chdir(cwd);
    }
  });

  it('defaults jsHookSources to an empty record when the manifest declares no JS hooks', async () => {
    await writeManifest(
      work,
      `type: component
name: demo
version: 0.1.0
`,
    );
    const bundle = await loadFromPath(work);
    expect(bundle.jsHookSources).toEqual({});
  });

  it('reads every JS hook referenced by the manifest into jsHookSources', async () => {
    await writeManifest(
      work,
      `type: component
name: demo
version: 0.1.0
hooks:
  pre_render:
    - { js: prep.js }
  post_render:
    - { js: post_render.js }
    - { rename: { from: gitignore, to: .gitignore } }
`,
    );
    await mkdir(join(work, '.hex', 'hooks'), { recursive: true });
    await writeFile(join(work, '.hex', 'hooks', 'prep.js'), '/* prep */', 'utf8');
    await writeFile(join(work, '.hex', 'hooks', 'post_render.js'), '/* post */', 'utf8');
    const bundle = await loadFromPath(work);
    expect(bundle.jsHookSources).toEqual({
      'prep.js': '/* prep */',
      'post_render.js': '/* post */',
    });
  });

  it('deduplicates JS hooks referenced from multiple lifecycles', async () => {
    await writeManifest(
      work,
      `type: component
name: demo
version: 0.1.0
hooks:
  pre_render:
    - { js: shared.js }
  post_render:
    - { js: shared.js }
`,
    );
    await mkdir(join(work, '.hex', 'hooks'), { recursive: true });
    await writeFile(join(work, '.hex', 'hooks', 'shared.js'), '/* shared */', 'utf8');
    const bundle = await loadFromPath(work);
    expect(bundle.jsHookSources).toEqual({ 'shared.js': '/* shared */' });
  });

  it('throws a clear authoring error when a manifest-declared JS hook is missing', async () => {
    await writeManifest(
      work,
      `type: component
name: demo
version: 0.1.0
hooks:
  post_render:
    - { js: missing.js }
`,
    );
    await expect(loadFromPath(work)).rejects.toThrow(
      /post_render hook "missing.js" declared in manifest but file not found/,
    );
  });
});
