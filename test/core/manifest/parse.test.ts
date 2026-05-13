import { describe, expect, it } from 'vitest';
import { ManifestError, parseManifestObject } from '../../../src/core/manifest/parse.js';

const baseManifest = {
  type: 'component' as const,
  name: 'demo',
  version: '0.1.0',
};

describe('parseManifestObject — base shape', () => {
  it('accepts the minimal manifest', () => {
    const m = parseManifestObject(baseManifest);
    expect(m.type).toBe('component');
    expect(m.name).toBe('demo');
    expect(m.version).toBe('0.1.0');
    expect(m.prompts).toBeUndefined();
  });

  it('rejects non-semver versions', () => {
    expect(() => parseManifestObject({ ...baseManifest, version: '1.0' })).toThrow(ManifestError);
  });

  it('rejects unknown top-level types', () => {
    expect(() => parseManifestObject({ ...baseManifest, type: 'plugin' })).toThrow(ManifestError);
  });

  it('rejects a non-object root', () => {
    expect(() => parseManifestObject('not a manifest')).toThrow(ManifestError);
  });
});

describe('parseManifestObject — prompts (long form)', () => {
  it('accepts a string prompt', () => {
    const m = parseManifestObject({
      ...baseManifest,
      prompts: [{ project_name: { type: 'string', required: true } }],
    });
    expect(m.prompts).toEqual([{ name: 'project_name', def: { type: 'string', required: true } }]);
  });

  it('accepts an integer prompt with min/max', () => {
    const m = parseManifestObject({
      ...baseManifest,
      prompts: [{ port: { type: 'integer', default: 3000, min: 1, max: 65535 } }],
    });
    expect(m.prompts?.[0]?.def).toMatchObject({
      type: 'integer',
      default: 3000,
      min: 1,
      max: 65535,
    });
  });

  it('accepts a boolean prompt', () => {
    const m = parseManifestObject({
      ...baseManifest,
      prompts: [{ containerize: { type: 'boolean', default: true } }],
    });
    expect(m.prompts?.[0]?.def).toEqual({ type: 'boolean', default: true });
  });

  it('accepts an enum prompt with choices and default', () => {
    const m = parseManifestObject({
      ...baseManifest,
      prompts: [
        {
          license: {
            type: 'enum',
            choices: ['MIT', 'Apache-2.0', 'BSD-3-Clause'],
            default: 'MIT',
          },
        },
      ],
    });
    expect(m.prompts?.[0]?.def).toMatchObject({
      type: 'enum',
      choices: ['MIT', 'Apache-2.0', 'BSD-3-Clause'],
      default: 'MIT',
    });
  });

  it('rejects an enum prompt with empty choices', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        prompts: [{ license: { type: 'enum', choices: [] } }],
      }),
    ).toThrow(ManifestError);
  });

  it('accepts a multi prompt', () => {
    const m = parseManifestObject({
      ...baseManifest,
      prompts: [{ features: { type: 'multi', choices: ['a', 'b', 'c'], default: ['a'] } }],
    });
    expect(m.prompts?.[0]?.def).toMatchObject({ type: 'multi' });
  });

  it('accepts a password prompt', () => {
    const m = parseManifestObject({
      ...baseManifest,
      prompts: [{ token: { type: 'password' } }],
    });
    expect(m.prompts?.[0]?.def).toEqual({ type: 'password' });
  });

  it('rejects an unknown prompt type', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        prompts: [{ project_name: { type: 'date' } }],
      }),
    ).toThrow(ManifestError);
  });
});

describe('parseManifestObject — prompts (shorthand)', () => {
  it('desugars an array → enum, first item is default', () => {
    const m = parseManifestObject({
      ...baseManifest,
      prompts: [{ framework: ['react', 'vue', 'svelte'] }],
    });
    expect(m.prompts?.[0]).toEqual({
      name: 'framework',
      def: { type: 'enum', choices: ['react', 'vue', 'svelte'], default: 'react' },
    });
  });

  it('desugars a bare boolean → boolean prompt', () => {
    const m = parseManifestObject({ ...baseManifest, prompts: [{ debug: false }] });
    expect(m.prompts?.[0]).toEqual({
      name: 'debug',
      def: { type: 'boolean', default: false },
    });
  });

  it('desugars a bare number → integer prompt', () => {
    const m = parseManifestObject({ ...baseManifest, prompts: [{ replicas: 3 }] });
    expect(m.prompts?.[0]).toEqual({
      name: 'replicas',
      def: { type: 'integer', default: 3 },
    });
  });

  it('desugars a bare string → string prompt', () => {
    const m = parseManifestObject({ ...baseManifest, prompts: [{ name: 'demo' }] });
    expect(m.prompts?.[0]).toEqual({
      name: 'name',
      def: { type: 'string', default: 'demo' },
    });
  });

  it('rejects empty enum shorthand', () => {
    expect(() => parseManifestObject({ ...baseManifest, prompts: [{ framework: [] }] })).toThrow(
      ManifestError,
    );
  });

  it('rejects a multi-key prompt entry', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        prompts: [{ a: 'x', b: 'y' }],
      }),
    ).toThrow(ManifestError);
  });
});

describe('parseManifestObject — hooks', () => {
  it('accepts a rename hook', () => {
    const m = parseManifestObject({
      ...baseManifest,
      hooks: { post_render: [{ rename: { from: 'gitignore', to: '.gitignore' } }] },
    });
    expect(m.hooks?.post_render?.[0]).toEqual({
      rename: { from: 'gitignore', to: '.gitignore' },
    });
  });

  it('accepts a delete hook with path', () => {
    const m = parseManifestObject({
      ...baseManifest,
      hooks: { post_render: [{ delete: { path: 'src/legacy.ts' } }] },
    });
    expect(m.hooks?.post_render?.[0]).toEqual({ delete: { path: 'src/legacy.ts' } });
  });

  it('accepts a delete hook with glob and when:', () => {
    const m = parseManifestObject({
      ...baseManifest,
      hooks: {
        post_render: [{ delete: { glob: 'src/examples/**', when: '!include_examples' } }],
      },
    });
    expect(m.hooks?.post_render?.[0]).toEqual({
      delete: { glob: 'src/examples/**', when: '!include_examples' },
    });
  });

  it('accepts a post_render JS hook with declarative hooks alongside', () => {
    const m = parseManifestObject({
      ...baseManifest,
      hooks: {
        post_render: [
          { rename: { from: 'gitignore', to: '.gitignore' } },
          { js: 'post_render.js' },
          { delete: { path: 'tmp.txt' } },
        ],
      },
    });
    expect(m.hooks?.post_render).toEqual([
      { rename: { from: 'gitignore', to: '.gitignore' } },
      { js: 'post_render.js' },
      { delete: { path: 'tmp.txt' } },
    ]);
  });

  it('accepts a pre_render JS hook with when:', () => {
    const m = parseManifestObject({
      ...baseManifest,
      hooks: {
        pre_render: [{ js: 'prep.js', when: 'use_react' }],
      },
    });
    expect(m.hooks?.pre_render?.[0]).toEqual({ js: 'prep.js', when: 'use_react' });
  });

  it('rejects a JS hook whose filename contains a path separator', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        hooks: { post_render: [{ js: 'sub/post_render.js' }] },
      }),
    ).toThrow(/no path separators/);
  });

  it('rejects a JS hook whose filename traverses upward', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        hooks: { post_render: [{ js: '../escape.js' }] },
      }),
    ).toThrow(/no `\.\.`/);
  });

  it('rejects a JS hook whose filename does not end in .js', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        hooks: { post_render: [{ js: 'post_render.ts' }] },
      }),
    ).toThrow(/plain `\.js` filename/);
  });

  it('rejects an empty JS hook filename', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        hooks: { post_render: [{ js: '' }] },
      }),
    ).toThrow();
  });
});

describe('parseManifestObject — include rules', () => {
  it('accepts a path-based include rule', () => {
    const m = parseManifestObject({
      ...baseManifest,
      include: [{ path: 'Dockerfile', when: 'containerize' }],
    });
    expect(m.include?.[0]).toEqual({ path: 'Dockerfile', when: 'containerize' });
  });

  it('accepts a glob-based include rule', () => {
    const m = parseManifestObject({
      ...baseManifest,
      include: [{ glob: 'src/**/*.vue', when: 'framework == "vue"' }],
    });
    expect(m.include?.[0]).toEqual({ glob: 'src/**/*.vue', when: 'framework == "vue"' });
  });
});

describe('parseManifestObject — sections', () => {
  const promptsFixture = [
    { name: { type: 'string' } },
    { description: { type: 'string', default: '' } },
    { license: { type: 'enum', choices: ['MIT', 'Apache-2.0'], default: 'MIT' } },
  ];

  it('accepts a manifest with sections covering every prompt', () => {
    const m = parseManifestObject({
      ...baseManifest,
      prompts: promptsFixture,
      sections: [
        { title: 'Basics', prompts: ['name', 'description'] },
        { title: 'Licence', prompts: ['license'] },
      ],
    });
    expect(m.sections).toHaveLength(2);
    expect(m.sections?.[0]?.title).toBe('Basics');
  });

  it('accepts a manifest without sections (flat list still works)', () => {
    const m = parseManifestObject({ ...baseManifest, prompts: promptsFixture });
    expect(m.sections).toBeUndefined();
  });

  it('rejects a section that references an unknown prompt', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        prompts: promptsFixture,
        sections: [
          { title: 'Basics', prompts: ['name', 'ghost'] },
          { title: 'Licence', prompts: ['description', 'license'] },
        ],
      }),
    ).toThrow(ManifestError);
  });

  it('rejects an orphan prompt when sections are declared', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        prompts: promptsFixture,
        sections: [{ title: 'Basics', prompts: ['name', 'description'] }],
      }),
    ).toThrow(/license.*not assigned/);
  });

  it('rejects a prompt mentioned in two sections', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        prompts: promptsFixture,
        sections: [
          { title: 'A', prompts: ['name', 'description'] },
          { title: 'B', prompts: ['description', 'license'] },
        ],
      }),
    ).toThrow(/multiple sections/);
  });

  it('rejects a section with no prompts (zod min(1))', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        prompts: promptsFixture,
        sections: [
          { title: 'Empty', prompts: [] },
          { title: 'Rest', prompts: ['name', 'description', 'license'] },
        ],
      }),
    ).toThrow(ManifestError);
  });
});

describe('parseManifestObject — setup', () => {
  it('accepts a manifest with setup.message and setup.tasks', () => {
    const m = parseManifestObject({
      ...baseManifest,
      setup: {
        message: 'A few things to wire up:',
        tasks: [
          { id: 'install-deps', title: 'Install dependencies', detail: 'npm install' },
          { id: 'push-to-github', title: 'Push to GitHub for first deploy' },
        ],
      },
    });
    expect(m.setup?.message).toBe('A few things to wire up:');
    expect(m.setup?.tasks).toHaveLength(2);
    expect(m.setup?.tasks?.[0]).toEqual({
      id: 'install-deps',
      title: 'Install dependencies',
      detail: 'npm install',
    });
    expect(m.setup?.tasks?.[1]?.detail).toBeUndefined();
  });

  it('accepts a setup block with only a message', () => {
    const m = parseManifestObject({
      ...baseManifest,
      setup: { message: 'all yours' },
    });
    expect(m.setup?.message).toBe('all yours');
    expect(m.setup?.tasks).toBeUndefined();
  });

  it('treats an absent setup block as undefined', () => {
    const m = parseManifestObject(baseManifest);
    expect(m.setup).toBeUndefined();
  });

  it('rejects a task id that is not kebab-case', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        setup: { tasks: [{ id: 'Install_Deps', title: 'Install' }] },
      }),
    ).toThrow(/kebab-case/);
  });

  it('rejects a task id with leading/trailing dashes', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        setup: { tasks: [{ id: '-bad', title: 'x' }] },
      }),
    ).toThrow(/kebab-case/);
  });

  it('rejects duplicate task ids', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        setup: {
          tasks: [
            { id: 'one', title: 'A' },
            { id: 'one', title: 'B' },
          ],
        },
      }),
    ).toThrow(/appears more than once/);
  });

  it('rejects a task with an empty title', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        setup: { tasks: [{ id: 'ok', title: '' }] },
      }),
    ).toThrow(ManifestError);
  });
});

describe('parseManifestObject — composes (M5.1)', () => {
  const baseRecipe = {
    type: 'recipe' as const,
    name: 'fullstack-app',
    version: '0.1.0',
  };

  it('accepts a recipe with a single composes entry, parsing name + versionSpec', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: { cli: 'node-ts-cli@^0.1.0' },
    });
    expect(m.composes).toEqual({
      cli: { kind: 'name', name: 'node-ts-cli', versionSpec: '^0.1.0' },
    });
  });

  it('accepts multiple composes entries with different version-spec shapes', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: {
        cli: 'node-ts-cli@1.2.3',
        api: 'express-api@~2.0.0',
        db: 'postgres-stub@>=14.0.0',
        ui: 'vite-spa@*',
      },
    });
    expect(m.composes?.cli).toEqual({ kind: 'name', name: 'node-ts-cli', versionSpec: '1.2.3' });
    expect(m.composes?.api).toEqual({ kind: 'name', name: 'express-api', versionSpec: '~2.0.0' });
    expect(m.composes?.db).toEqual({
      kind: 'name',
      name: 'postgres-stub',
      versionSpec: '>=14.0.0',
    });
    expect(m.composes?.ui).toEqual({ kind: 'name', name: 'vite-spa', versionSpec: '*' });
  });

  it('parses scoped names by splitting on the last @', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: { cli: '@hexology/node-ts-cli@^0.1.0' },
    });
    expect(m.composes?.cli).toEqual({
      kind: 'name',
      name: '@hexology/node-ts-cli',
      versionSpec: '^0.1.0',
    });
  });

  it('accepts prerelease and build-metadata version specs', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: {
        alpha: 'pkg@1.0.0-alpha.1',
        beta: 'pkg@1.0.0+build.2',
      },
    });
    expect(m.composes?.alpha).toMatchObject({ kind: 'name', versionSpec: '1.0.0-alpha.1' });
    expect(m.composes?.beta).toMatchObject({ kind: 'name', versionSpec: '1.0.0+build.2' });
  });

  it('treats absent composes as undefined on a recipe', () => {
    const m = parseManifestObject(baseRecipe);
    expect(m.composes).toBeUndefined();
  });

  it('rejects composes on a component', () => {
    expect(() =>
      parseManifestObject({
        ...baseManifest,
        composes: { cli: 'node-ts-cli@^0.1.0' },
      }),
    ).toThrow(/only allowed on recipes/);
  });

  it('rejects a non-kebab-case key', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { CLI: 'node-ts-cli@^0.1.0' },
      }),
    ).toThrow(/kebab-case/);
  });

  it('rejects a key with a leading dash', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { '-cli': 'node-ts-cli@^0.1.0' },
      }),
    ).toThrow(/kebab-case/);
  });

  it('rejects an entry missing the @version part', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { cli: 'node-ts-cli' },
      }),
    ).toThrow(/<name>@<version>/);
  });

  it('rejects an entry whose version spec is malformed', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { cli: 'node-ts-cli@1.x' },
      }),
    ).toThrow(/version spec/);
  });

  it('rejects an entry with an incomplete semver triplet', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { cli: 'node-ts-cli@1.2' },
      }),
    ).toThrow(/version spec/);
  });

  it('rejects an empty entry string', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { cli: '' },
      }),
    ).toThrow(ManifestError);
  });

  it('rejects an entry with whitespace in the name', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { cli: 'bad name@1.0.0' },
      }),
    ).toThrow(/whitespace/);
  });
});

describe('parseManifestObject — provides / consumes / requires (M6.1)', () => {
  const baseComponent = {
    type: 'component' as const,
    name: 'api-express',
    version: '1.2.0',
    kind: 'api',
  };

  it('accepts a component with provides (array form)', () => {
    const m = parseManifestObject({
      ...baseComponent,
      provides: ['HTTP_PORT', 'api_routes_dir'],
    });
    expect(m.provides).toEqual(['HTTP_PORT', 'api_routes_dir']);
  });

  it('accepts a component with provides (map form — symbol → expression)', () => {
    const m = parseManifestObject({
      ...baseComponent,
      provides: {
        DB_URL: 'postgres://{{ host }}:{{ port }}/{{ database }}',
        HTTP_PORT: '{{ port }}',
      },
    });
    expect(m.provides).toEqual({
      DB_URL: 'postgres://{{ host }}:{{ port }}/{{ database }}',
      HTTP_PORT: '{{ port }}',
    });
  });

  it('rejects an empty key in provides map form', () => {
    expect(() => parseManifestObject({ ...baseComponent, provides: { '': 'something' } })).toThrow(
      ManifestError,
    );
  });

  it('accepts a component with consumes', () => {
    const m = parseManifestObject({
      ...baseComponent,
      consumes: ['DB_URL', 'session_store'],
    });
    expect(m.consumes).toEqual(['DB_URL', 'session_store']);
  });

  it('accepts a kind-based requires entry', () => {
    const m = parseManifestObject({
      ...baseComponent,
      requires: [{ kind: 'monitoring' }],
    });
    expect(m.requires).toEqual([{ kind: 'monitoring' }]);
  });

  it('accepts a name+version requires entry', () => {
    const m = parseManifestObject({
      ...baseComponent,
      requires: [{ name: 'auth-session', version: '^1.0.0' }],
    });
    expect(m.requires).toEqual([{ name: 'auth-session', version: '^1.0.0' }]);
  });

  it('accepts a mixed-style requires array (each entry well-formed)', () => {
    const m = parseManifestObject({
      ...baseComponent,
      requires: [
        { kind: 'db' },
        { name: 'auth-session', version: '~1.2.0' },
        { kind: 'monitoring' },
      ],
    });
    expect(m.requires).toHaveLength(3);
  });

  it('accepts all three fields together on a component', () => {
    const m = parseManifestObject({
      ...baseComponent,
      provides: ['HTTP_PORT'],
      consumes: ['DB_URL'],
      requires: [{ kind: 'db' }],
    });
    expect(m.provides).toEqual(['HTTP_PORT']);
    expect(m.consumes).toEqual(['DB_URL']);
    expect(m.requires).toEqual([{ kind: 'db' }]);
  });

  it('treats absent fields as undefined', () => {
    const m = parseManifestObject(baseComponent);
    expect(m.provides).toBeUndefined();
    expect(m.consumes).toBeUndefined();
    expect(m.requires).toBeUndefined();
  });

  it('rejects an empty string in provides', () => {
    expect(() => parseManifestObject({ ...baseComponent, provides: ['HTTP_PORT', ''] })).toThrow(
      ManifestError,
    );
  });

  it('rejects an empty string in consumes', () => {
    expect(() => parseManifestObject({ ...baseComponent, consumes: [''] })).toThrow(ManifestError);
  });

  it('rejects a requires entry that mixes kind with name+version', () => {
    expect(() =>
      parseManifestObject({
        ...baseComponent,
        requires: [{ kind: 'db', name: 'pg', version: '^14.0.0' }],
      }),
    ).toThrow(ManifestError);
  });

  it('rejects a requires entry with only `name` (missing version)', () => {
    expect(() =>
      parseManifestObject({
        ...baseComponent,
        requires: [{ name: 'auth-session' }],
      }),
    ).toThrow(ManifestError);
  });

  it('rejects a requires entry with only `version` (missing name)', () => {
    expect(() =>
      parseManifestObject({
        ...baseComponent,
        requires: [{ version: '^1.0.0' }],
      }),
    ).toThrow(ManifestError);
  });

  it('rejects a requires entry with an empty kind', () => {
    expect(() =>
      parseManifestObject({
        ...baseComponent,
        requires: [{ kind: '' }],
      }),
    ).toThrow(ManifestError);
  });

  it('rejects a requires entry with a non-kebab kind', () => {
    expect(() =>
      parseManifestObject({
        ...baseComponent,
        requires: [{ kind: 'Monitoring' }],
      }),
    ).toThrow(/kebab-case/);
  });

  it('rejects a requires entry with a malformed version', () => {
    expect(() =>
      parseManifestObject({
        ...baseComponent,
        requires: [{ name: 'auth-session', version: '1.x' }],
      }),
    ).toThrow(/recognized semver spec/);
  });

  it('rejects a requires entry with an incomplete semver triplet', () => {
    expect(() =>
      parseManifestObject({
        ...baseComponent,
        requires: [{ name: 'auth-session', version: '1.2' }],
      }),
    ).toThrow(/recognized semver spec/);
  });

  it('accepts caret, tilde, gte, and bare semver as version specs', () => {
    const m = parseManifestObject({
      ...baseComponent,
      requires: [
        { name: 'a', version: '^1.0.0' },
        { name: 'b', version: '~1.0.0' },
        { name: 'c', version: '>=1.0.0' },
        { name: 'd', version: '1.0.0' },
        { name: 'e', version: '*' },
      ],
    });
    expect(m.requires).toHaveLength(5);
  });

  it('rejects provides on a recipe', () => {
    expect(() =>
      parseManifestObject({
        type: 'recipe',
        name: 'r',
        version: '0.1.0',
        provides: ['HTTP_PORT'],
      }),
    ).toThrow(/only allowed on components/);
  });

  it('rejects consumes on a recipe', () => {
    expect(() =>
      parseManifestObject({
        type: 'recipe',
        name: 'r',
        version: '0.1.0',
        consumes: ['DB_URL'],
      }),
    ).toThrow(/only allowed on components/);
  });

  it('rejects requires on a recipe', () => {
    expect(() =>
      parseManifestObject({
        type: 'recipe',
        name: 'r',
        version: '0.1.0',
        requires: [{ kind: 'db' }],
      }),
    ).toThrow(/only allowed on components/);
  });
});

describe('parseManifestObject — composes slot form (M6.3)', () => {
  const baseRecipe = {
    type: 'recipe' as const,
    name: 'fullstack-app',
    version: '0.1.0',
  };

  it('parses an object slot entry into a slot ChildRef', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: { api: { kind: 'api', version: '^1.0.0' } },
    });
    expect(m.composes?.api).toEqual({
      kind: 'slot',
      componentKind: 'api',
      versionSpec: '^1.0.0',
    });
  });

  it('accepts the slot form alongside other wire forms in the same composes', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: {
        api: { kind: 'api', version: '^1.0.0' },
        ui: 'vite-spa@^1.0.0',
        local: 'file:./packages/db',
      },
    });
    expect(m.composes?.api?.kind).toBe('slot');
    expect(m.composes?.ui?.kind).toBe('name');
    expect(m.composes?.local?.kind).toBe('file');
  });

  it('rejects a slot entry with a non-kebab kind', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { api: { kind: 'API', version: '^1.0.0' } },
      }),
    ).toThrow(/kebab-case/);
  });

  it('rejects a slot entry with a malformed version', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { api: { kind: 'api', version: '1.x' } },
      }),
    ).toThrow(/recognized semver spec/);
  });

  it('rejects a slot entry with extra fields', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { api: { kind: 'api', version: '^1.0.0', name: 'whoops' } },
      }),
    ).toThrow(ManifestError);
  });

  it('rejects a slot entry missing the version field', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { api: { kind: 'api' } },
      }),
    ).toThrow(ManifestError);
  });
});

describe('parseManifestObject — composes (M5.2 wire forms)', () => {
  const baseRecipe = {
    type: 'recipe' as const,
    name: 'fullstack-app',
    version: '0.1.0',
  };

  it('parses a "file:" entry with a relative path', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: { cli: 'file:./local/cli' },
    });
    expect(m.composes?.cli).toEqual({ kind: 'file', path: './local/cli' });
  });

  it('parses a "file:" entry with an absolute path', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: { cli: 'file:/abs/path/to/cli' },
    });
    expect(m.composes?.cli).toEqual({ kind: 'file', path: '/abs/path/to/cli' });
  });

  it('rejects "file:" with no path', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { cli: 'file:' },
      }),
    ).toThrow(/empty path/);
  });

  it('parses a "git+" https URL with a ref', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: { cli: 'git+https://github.com/acme/cli@main' },
    });
    expect(m.composes?.cli).toEqual({
      kind: 'git',
      url: 'https://github.com/acme/cli',
      ref: 'main',
    });
  });

  it('parses a "git+" https URL with no ref', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: { cli: 'git+https://github.com/acme/cli' },
    });
    expect(m.composes?.cli).toEqual({
      kind: 'git',
      url: 'https://github.com/acme/cli',
    });
  });

  it('parses a "git+" SSH URL without confusing the host @ for a ref delimiter', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: { cli: 'git+git@github.com:acme/cli.git' },
    });
    expect(m.composes?.cli).toEqual({
      kind: 'git',
      url: 'git@github.com:acme/cli.git',
    });
  });

  it('parses a "git+" SSH URL with a ref appended', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: { cli: 'git+git@github.com:acme/cli.git@v1.2.3' },
    });
    expect(m.composes?.cli).toEqual({
      kind: 'git',
      url: 'git@github.com:acme/cli.git',
      ref: 'v1.2.3',
    });
  });

  it('parses a "git+" entry with a slash-bearing branch ref', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: { cli: 'git+https://github.com/acme/cli@release/1.0' },
    });
    expect(m.composes?.cli).toEqual({
      kind: 'git',
      url: 'https://github.com/acme/cli',
      ref: 'release/1.0',
    });
  });

  it('rejects "git+" with no URL', () => {
    expect(() =>
      parseManifestObject({
        ...baseRecipe,
        composes: { cli: 'git+' },
      }),
    ).toThrow(/empty URL/);
  });

  it('mixes all three forms in the same recipe', () => {
    const m = parseManifestObject({
      ...baseRecipe,
      composes: {
        cli: 'node-ts-cli@^0.1.0',
        api: 'file:./packages/api',
        ui: 'git+https://github.com/acme/ui@main',
      },
    });
    expect(m.composes?.cli?.kind).toBe('name');
    expect(m.composes?.api?.kind).toBe('file');
    expect(m.composes?.ui?.kind).toBe('git');
  });
});
