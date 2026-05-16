import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RenderError, renderBundle } from '../../../src/core/render/engine.js';
import { loadFromPath } from '../../../src/core/sources/file-source.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-render-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeFileEnsure(path: string, body: string | Buffer): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
}

async function buildTemplate(spec: {
  manifest: string;
  files?: Record<string, string | Buffer>;
  hexignore?: string;
}): Promise<string> {
  const root = join(work, 'template');
  await mkdir(join(root, '.hex'), { recursive: true });
  await writeFile(join(root, '.hex', 'manifest.yaml'), spec.manifest, 'utf8');
  if (spec.hexignore) {
    await writeFile(join(root, '.hexignore'), spec.hexignore, 'utf8');
  }
  for (const [rel, body] of Object.entries(spec.files ?? {})) {
    await writeFileEnsure(join(root, rel), body);
  }
  return root;
}

describe('renderBundle — basic', () => {
  it('renders file contents and writes to the output path', async () => {
    const root = await buildTemplate({
      manifest: `type: component
name: demo
version: 0.1.0
`,
      files: {
        'README.md': 'Hello, {{ name }}!',
      },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    const result = await renderBundle(bundle, out, { name: 'World' });
    expect(result.written).toEqual(['README.md']);
    expect(await readFile(join(out, 'README.md'), 'utf8')).toBe('Hello, World!');
  });

  it('renders templated filenames', async () => {
    const root = await buildTemplate({
      manifest: `type: component
name: demo
version: 0.1.0
`,
      files: {
        'src/{{ project_name }}.ts': '// generated for {{ project_name }}',
      },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await renderBundle(bundle, out, { project_name: 'cli' });
    expect(await readFile(join(out, 'src', 'cli.ts'), 'utf8')).toBe('// generated for cli');
  });

  it('skips the .hex/ directory itself', async () => {
    const root = await buildTemplate({
      manifest: `type: component
name: demo
version: 0.1.0
`,
      files: {
        'index.ts': 'ok',
        '.hex/extra.txt': 'should not be emitted',
      },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    const result = await renderBundle(bundle, out, {});
    expect(result.written).toEqual(['index.ts']);
  });

  it('honours .hexignore', async () => {
    const root = await buildTemplate({
      manifest: `type: component
name: demo
version: 0.1.0
`,
      files: {
        'src/index.ts': 'keep',
        'node_modules/foo/index.js': 'should be ignored',
        'dist/x.js': 'also ignored',
      },
      hexignore: 'node_modules/\ndist/\n',
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    const result = await renderBundle(bundle, out, {});
    expect(result.written.sort()).toEqual(['src/index.ts']);
  });
});

describe('renderBundle — output directory policy', () => {
  it('refuses to render into a non-empty target without force', async () => {
    const root = await buildTemplate({
      manifest: `type: component
name: demo
version: 0.1.0
`,
      files: { 'a.txt': 'A' },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'preexisting'), 'hi', 'utf8');
    await expect(renderBundle(bundle, out, {})).rejects.toThrow(RenderError);
  });

  it('allows --force to render into a non-empty directory', async () => {
    const root = await buildTemplate({
      manifest: `type: component
name: demo
version: 0.1.0
`,
      files: { 'a.txt': 'A' },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'preexisting'), 'hi', 'utf8');
    await renderBundle(bundle, out, {}, { force: true });
    expect(await readFile(join(out, 'a.txt'), 'utf8')).toBe('A');
    expect(await readFile(join(out, 'preexisting'), 'utf8')).toBe('hi');
  });

  it('refuses to render into a path that exists and is a file', async () => {
    const root = await buildTemplate({
      manifest: `type: component
name: demo
version: 0.1.0
`,
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out-file');
    await writeFile(out, 'hi', 'utf8');
    await expect(renderBundle(bundle, out, {})).rejects.toThrow(/not a directory/);
  });
});

describe('renderBundle — include rules', () => {
  it('skips a file when its include rule when: is false', async () => {
    const root = await buildTemplate({
      manifest: `type: component
name: demo
version: 0.1.0
include:
  - { path: Dockerfile, when: containerize }
`,
      files: {
        'index.ts': 'ok',
        Dockerfile: 'FROM node:20',
      },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    const result = await renderBundle(bundle, out, { containerize: false });
    expect(result.written.sort()).toEqual(['index.ts']);
  });

  it('emits a file when its include rule when: is true', async () => {
    const root = await buildTemplate({
      manifest: `type: component
name: demo
version: 0.1.0
include:
  - { path: Dockerfile, when: containerize }
`,
      files: {
        'index.ts': 'ok',
        Dockerfile: 'FROM node:20',
      },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    const result = await renderBundle(bundle, out, { containerize: true });
    expect(result.written.sort()).toEqual(['Dockerfile', 'index.ts']);
  });

  it('honours glob-style include rules', async () => {
    const root = await buildTemplate({
      manifest: `type: component
name: demo
version: 0.1.0
include:
  - { glob: 'src/main.vue', when: 'framework == "vue"' }
  - { glob: 'src/main.react.tsx', when: 'framework == "react"' }
`,
      files: {
        'src/main.vue': 'vue',
        'src/main.react.tsx': 'react',
        'src/main.svelte': 'svelte',
      },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    const result = await renderBundle(bundle, out, { framework: 'react' });
    expect(result.written.sort()).toEqual(['src/main.react.tsx', 'src/main.svelte']);
  });
});

describe('renderBundle — binary files', () => {
  it('copies binary files verbatim without trying to render them', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
    const root = await buildTemplate({
      manifest: `type: component
name: demo
version: 0.1.0
`,
      files: { 'logo.png': binary },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await renderBundle(bundle, out, {});
    const written = await readFile(join(out, 'logo.png'));
    expect(written.equals(binary)).toBe(true);
  });
});

describe('renderBundle — JS hooks (M7.4 lifecycle wiring)', () => {
  async function buildWithJsHook(opts: {
    lifecycle: 'pre_render' | 'post_render';
    hookSource: string;
    hookFilename?: string;
    when?: string;
    extraFiles?: Record<string, string>;
    /** Extra YAML entries to append to the same lifecycle array. */
    sameLifecycleExtras?: string[];
  }): Promise<string> {
    const filename = opts.hookFilename ?? `${opts.lifecycle}.js`;
    const whenSuffix = opts.when ? `, when: "${opts.when}"` : '';
    const extras = (opts.sameLifecycleExtras ?? []).map((e) => `    - ${e}`).join('\n');
    const manifest = `type: component
name: demo
version: 0.1.0
hooks:
  ${opts.lifecycle}:
    - { js: ${filename}${whenSuffix} }${extras ? `\n${extras}` : ''}
`;
    const root = await buildTemplate({ manifest, files: opts.extraFiles });
    await mkdir(join(root, '.hex', 'hooks'), { recursive: true });
    await writeFile(join(root, '.hex', 'hooks', filename), opts.hookSource, 'utf8');
    return root;
  }

  it('runs pre_render before the render walk (hook writes a file, walk then writes alongside it)', async () => {
    const root = await buildWithJsHook({
      lifecycle: 'pre_render',
      hookSource: "project.write('from-hook.txt', 'pre');",
      extraFiles: { 'from-walk.txt': 'walked' },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await renderBundle(bundle, out, {});
    expect(await readFile(join(out, 'from-hook.txt'), 'utf8')).toBe('pre');
    expect(await readFile(join(out, 'from-walk.txt'), 'utf8')).toBe('walked');
  });

  it('a throwing pre_render hook aborts the render before any file is walked', async () => {
    const root = await buildWithJsHook({
      lifecycle: 'pre_render',
      hookSource: "throw new Error('abort');",
      extraFiles: { 'unwanted.txt': 'should not exist' },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await expect(renderBundle(bundle, out, {})).rejects.toThrow(
      /pre_render hook "pre_render.js" failed/,
    );
    await expect(readFile(join(out, 'unwanted.txt'), 'utf8')).rejects.toThrow();
  });

  it('runs post_render after the render walk (hook can rewrite a freshly-rendered file)', async () => {
    const root = await buildWithJsHook({
      lifecycle: 'post_render',
      hookSource: "project.write('greeting.txt', project.read('greeting.txt').toUpperCase());",
      extraFiles: { 'greeting.txt': 'hello, {{ name }}!' },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await renderBundle(bundle, out, { name: 'world' });
    expect(await readFile(join(out, 'greeting.txt'), 'utf8')).toBe('HELLO, WORLD!');
  });

  it('runs post_render JS hooks AFTER the declarative hooks at the same lifecycle', async () => {
    // Declarative rename `gitignore` → `.gitignore`, then JS hook
    // observes the renamed file via project.read and rewrites it.
    const root = await buildWithJsHook({
      lifecycle: 'post_render',
      hookSource: "project.write('.gitignore', project.read('.gitignore') + '\\n# extended');",
      extraFiles: { gitignore: 'node_modules/' },
      sameLifecycleExtras: ['{ rename: { from: gitignore, to: .gitignore } }'],
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await renderBundle(bundle, out, {});
    expect(await readFile(join(out, '.gitignore'), 'utf8')).toBe('node_modules/\n# extended');
  });

  it('skips JS hooks whose when: expression is falsy', async () => {
    const root = await buildWithJsHook({
      lifecycle: 'pre_render',
      hookSource: "project.write('flag.txt', 'on');",
      when: 'enabled',
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await renderBundle(bundle, out, { enabled: false });
    await expect(readFile(join(out, 'flag.txt'), 'utf8')).rejects.toThrow();
  });

  it('exposes answers, recipe (null for standalone), and log to JS hooks', async () => {
    const sink: Array<{ level: string; msg: string }> = [];
    const root = await buildWithJsHook({
      lifecycle: 'pre_render',
      hookSource: `log.info('answers.name=' + answers.name + ' recipe=' + (recipe === null ? 'none' : recipe.name));`,
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await renderBundle(
      bundle,
      out,
      { name: 'demo' },
      {
        hookLog: {
          info: (msg) => sink.push({ level: 'info', msg }),
          warn: (msg) => sink.push({ level: 'warn', msg }),
          error: (msg) => sink.push({ level: 'error', msg }),
        },
      },
    );
    expect(sink).toEqual([{ level: 'info', msg: 'answers.name=demo recipe=none' }]);
  });

  it('fires a pre_render hook prompt and surfaces the answer to the render walk via answers.hooks.<name>', async () => {
    const manifest = `type: component
name: demo
version: 0.1.0
hooks:
  pre_render:
    - js: configure.js
      name: configure
      prompts:
        - replicas: { type: string, default: "1" }
`;
    const root = join(work, 'template');
    await mkdir(join(root, '.hex', 'hooks'), { recursive: true });
    await writeFile(join(root, '.hex', 'manifest.yaml'), manifest, 'utf8');
    await writeFile(
      join(root, '.hex', 'hooks', 'configure.js'),
      "log.info('hooked at replicas=' + answers.hooks.configure.replicas);",
      'utf8',
    );
    await writeFile(join(root, 'config.yaml'), 'replicas: {{ hooks.configure.replicas }}', 'utf8');
    const sink: string[] = [];
    const prompter = {
      async text(opts: { message: string }) {
        return opts.message === 'replicas' ? '4' : '';
      },
      async confirm() {
        return false;
      },
      async select() {
        return '';
      },
      async multiselect() {
        return [];
      },
      async password() {
        return '';
      },
    };
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await renderBundle(
      bundle,
      out,
      {},
      {
        prompter,
        hookLog: {
          info: (msg) => sink.push(msg),
          warn: () => {},
          error: () => {},
        },
      },
    );
    expect(await readFile(join(out, 'config.yaml'), 'utf8')).toBe('replicas: 4');
    expect(sink).toEqual(['hooked at replicas=4']);
  });

  it('honours --trust-local for a FileSource bundle (warning emitted, hook runs unsandboxed)', async () => {
    const root = await buildWithJsHook({
      lifecycle: 'pre_render',
      hookSource: "project.write('marker.txt', 'unsandboxed');",
    });
    const bundle = await loadFromPath(root);
    expect(bundle.sourceKind).toBe('file');
    const out = join(work, 'out');
    const warnings: string[] = [];
    await renderBundle(
      bundle,
      out,
      {},
      {
        trustLocal: true,
        hookLog: {
          info: () => {},
          warn: (msg) => warnings.push(msg),
          error: () => {},
        },
      },
    );
    expect(await readFile(join(out, 'marker.txt'), 'utf8')).toBe('unsandboxed');
    expect(warnings).toContain(
      'running unsandboxed pre_render hook "pre_render.js" (trust-local active)',
    );
  });

  it('ignores --trust-local for a git-sourced bundle (sandboxed regardless)', async () => {
    const root = await buildWithJsHook({
      lifecycle: 'pre_render',
      hookSource: "project.write('marker.txt', 'sandboxed');",
    });
    const bundle = await loadFromPath(root, 'git');
    expect(bundle.sourceKind).toBe('git');
    const out = join(work, 'out');
    const warnings: string[] = [];
    await renderBundle(
      bundle,
      out,
      {},
      {
        trustLocal: true,
        hookLog: {
          info: () => {},
          warn: (msg) => warnings.push(msg),
          error: () => {},
        },
      },
    );
    expect(await readFile(join(out, 'marker.txt'), 'utf8')).toBe('sandboxed');
    // No "running unsandboxed" warning — the git origin overrides the user's intent.
    expect(warnings.filter((w) => w.includes('unsandboxed'))).toEqual([]);
  });

  it('exposes recipe metadata to JS hooks when RenderOptions.recipe is set', async () => {
    const sink: Array<{ level: string; msg: string }> = [];
    const root = await buildWithJsHook({
      lifecycle: 'pre_render',
      hookSource: "log.info(recipe.name + '@' + recipe.version);",
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await renderBundle(
      bundle,
      out,
      {},
      {
        recipe: { name: 'node-ts-monorepo', version: '1.2.3' },
        hookLog: {
          info: (msg) => sink.push({ level: 'info', msg }),
          warn: () => {},
          error: () => {},
        },
      },
    );
    expect(sink).toEqual([{ level: 'info', msg: 'node-ts-monorepo@1.2.3' }]);
  });
});

describe('renderBundle — stub fixtures (M8.4)', () => {
  const stubManifest = `type: component
name: db-postgres
version: 2.0.0
kind: db
stub:
  engine: pg-mem
  fixtures: fixtures
`;

  it('renders the fixtures directory into <out>/fixtures/ when stub mode is on', async () => {
    const root = await buildTemplate({
      manifest: stubManifest,
      files: {
        'src/index.ts': '// {{ name }}',
        'fixtures/seed.sql': "insert into app values ('{{ name }}');",
      },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    const result = await renderBundle(bundle, out, { name: 'demo' }, { stubEnabled: true });

    expect(await readFile(join(out, 'fixtures', 'seed.sql'), 'utf8')).toBe(
      "insert into app values ('demo');",
    );
    expect(await readFile(join(out, 'src', 'index.ts'), 'utf8')).toBe('// demo');
    expect(result.written).toContain('fixtures/seed.sql');
  });

  it('omits the fixtures directory entirely when stub mode is off', async () => {
    const root = await buildTemplate({
      manifest: stubManifest,
      files: {
        'src/index.ts': '// {{ name }}',
        'fixtures/seed.sql': 'noop',
      },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    const result = await renderBundle(bundle, out, { name: 'demo' });

    expect(result.written).toEqual(['src/index.ts']);
    await expect(readFile(join(out, 'fixtures', 'seed.sql'), 'utf8')).rejects.toThrow();
  });

  it('does not emit the fixtures source dir as plain template files', async () => {
    // Even with stub off, the walk must skip the declared fixtures dir —
    // it is never a plain template file.
    const root = await buildTemplate({
      manifest: stubManifest,
      files: { 'fixtures/seed.sql': 'noop', 'keep.txt': 'kept' },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    const result = await renderBundle(bundle, out, {});
    expect(result.written).toEqual(['keep.txt']);
  });

  it('renders templated fixture filenames through Nunjucks', async () => {
    const root = await buildTemplate({
      manifest: stubManifest,
      files: { 'fixtures/{{ name }}.json': '{ "for": "{{ name }}" }' },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await renderBundle(bundle, out, { name: 'orders' }, { stubEnabled: true });
    expect(await readFile(join(out, 'fixtures', 'orders.json'), 'utf8')).toBe(
      '{ "for": "orders" }',
    );
  });

  it('throws RenderError when the declared fixtures directory is missing', async () => {
    const root = await buildTemplate({ manifest: stubManifest, files: { 'src/index.ts': 'x' } });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    await expect(renderBundle(bundle, out, {}, { stubEnabled: true })).rejects.toThrow(
      /stub fixtures directory declared in manifest but not found/,
    );
  });

  it('does nothing for a component with no stub block', async () => {
    const root = await buildTemplate({
      manifest: `type: component
name: plain
version: 1.0.0
`,
      files: { 'index.ts': 'ok' },
    });
    const bundle = await loadFromPath(root);
    const out = join(work, 'out');
    const result = await renderBundle(bundle, out, {}, { stubEnabled: true });
    expect(result.written).toEqual(['index.ts']);
  });
});
