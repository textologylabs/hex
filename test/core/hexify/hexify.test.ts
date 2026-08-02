import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { escapeNunjucks } from '../../../src/core/hexify/escape.js';
import { buildHexignore, buildManifestYaml } from '../../../src/core/hexify/generate.js';
import { buildPlan, countOccurrencesAcross } from '../../../src/core/hexify/pipeline.js';
import type { ScannedFile } from '../../../src/core/hexify/pipeline.js';
import {
  type HexifyParam,
  countValueOccurrences,
  substitutePath,
  substituteText,
} from '../../../src/core/hexify/substitute.js';
import { ManifestError, parseManifestObject } from '../../../src/core/manifest/parse.js';
import { renderText } from '../../../src/core/render/templating.js';

/**
 * The invariant everything else leans on: for any input, the escaped /
 * substituted text rendered with the original values must reproduce the
 * input byte-for-byte. These tests drive the exact Nunjucks env the
 * render engine uses (renderText), not a stand-in.
 */

// Every known way a plain repo can collide with Nunjucks syntax.
const HAZARDS = [
  '${{ secrets.NPM_TOKEN }}', // GitHub Actions
  'const s = `${{a: 1}.a}`;', // JS template literal
  '  {% if x %}indented{% endif %}', // lstripBlocks would eat the indent
  '{# a comment #}',
  'a #} b', // bare #} THROWS in nunjucks even without an opening {#
  'a %} b',
  'a }} b',
  '{{{',
  '{{{{',
  '{% raw %}x{% endraw %}', // pre-existing raw blocks must survive too
  'lone {{ open',
  '{#{#',
  'plain text, no hazards',
];

describe('escapeNunjucks', () => {
  it.each(HAZARDS)('round-trips %j through the real renderer', (input) => {
    expect(renderText(escapeNunjucks(input), {})).toBe(input);
  });

  it('leaves hazard-free text completely untouched', () => {
    const text = 'no braces here\njust lines { single } braces are fine\n';
    expect(escapeNunjucks(text)).toBe(text);
  });
});

const P = (name: string, value: string): HexifyParam => ({
  name,
  value,
  description: name,
});

describe('countValueOccurrences', () => {
  it('counts boundary-respecting hits only', () => {
    const text = 'acme-portal is not acme-portal-web nor xacme-portal but acme-portal.';
    expect(countValueOccurrences(text, 'acme-portal')).toBe(2);
  });

  it('non-wordish values match as plain substrings', () => {
    expect(countValueOccurrences('say Acme Corp! and Acme Corp!x', 'Acme Corp!')).toBe(2);
  });

  it('empty value never matches', () => {
    expect(countValueOccurrences('anything', '')).toBe(0);
  });
});

describe('substituteText', () => {
  it('replaces occurrences and reports hits', () => {
    const { out, hits } = substituteText('name: acme-portal\ntitle: acme-portal app\n', [
      P('project_name', 'acme-portal'),
    ]);
    expect(out).toBe('name: {{ project_name }}\ntitle: {{ project_name }} app\n');
    expect(hits.get('project_name')).toBe(2);
  });

  it('respects word boundaries', () => {
    const { out, hits } = substituteText('acme-portal-web uses acme-portal', [
      P('project_name', 'acme-portal'),
    ]);
    expect(out).toBe('acme-portal-web uses {{ project_name }}');
    expect(hits.get('project_name')).toBe(1);
  });

  it('prefers the longest value on overlap', () => {
    const { out, hits } = substituteText('acme and acme-portal', [
      P('org', 'acme'),
      P('project_name', 'acme-portal'),
    ]);
    expect(out).toBe('{{ org }} and {{ project_name }}');
    expect(hits.get('org')).toBe(1);
    expect(hits.get('project_name')).toBe(1);
  });

  it('escapes a literal { that would fuse with an inserted placeholder', () => {
    const { out } = substituteText('x{acme rest', [P('org', 'acme')]);
    expect(renderText(out, { org: 'acme' })).toBe('x{acme rest');
    expect(renderText(out, { org: 'zed' })).toBe('x{zed rest');
  });

  it('round-trips hazard-rich input with the original values', () => {
    const text = [
      'name: acme-portal',
      'token: ${{ secrets.NPM_TOKEN }}',
      '  {% if ci %}acme-portal{% endif %}',
      'weird #} and {{{ acme-portal',
    ].join('\n');
    const params = [P('project_name', 'acme-portal')];
    const { out } = substituteText(text, params);
    expect(renderText(out, { project_name: 'acme-portal' })).toBe(text);
  });

  it('substitutes with different answers while escaped hazards stay literal', () => {
    const text = 'name: acme-portal\ntoken: ${{ secrets.X }}\n';
    const { out } = substituteText(text, [P('project_name', 'acme-portal')]);
    expect(renderText(out, { project_name: 'zed-portal' })).toBe(
      'name: zed-portal\ntoken: ${{ secrets.X }}\n',
    );
  });

  it('hits agree with countValueOccurrences for a single param', () => {
    const text = 'acme-portal, acme-portal-web, acme-portal';
    const { hits } = substituteText(text, [P('project_name', 'acme-portal')]);
    expect(hits.get('project_name')).toBe(countValueOccurrences(text, 'acme-portal'));
  });
});

describe('substitutePath', () => {
  it('parameterises a filename', () => {
    const { out, hits } = substitutePath('src/acme-portal.config.ts', [
      P('project_name', 'acme-portal'),
    ]);
    expect(out).toBe('src/{{ project_name }}.config.ts');
    expect(hits.get('project_name')).toBe(1);
    expect(renderText(out, { project_name: 'acme-portal' })).toBe('src/acme-portal.config.ts');
  });

  it('treats path separators as boundaries', () => {
    const { out } = substitutePath('acme/acme-thing/file.ts', [P('org', 'acme')]);
    expect(out).toBe('{{ org }}/acme-thing/file.ts');
  });
});

describe('buildManifestYaml', () => {
  it('emits a schema-valid manifest with prompts as single-key maps', () => {
    const yamlText = buildManifestYaml({
      name: 'acme-portal',
      kind: 'webapp',
      params: [
        { name: 'project_name', value: 'acme-portal', description: 'Package name' },
        { name: 'description', value: 'The portal', description: 'Short description' },
      ],
    });
    const manifest = parseManifestObject(parseYaml(yamlText));
    expect(manifest.type).toBe('component');
    expect(manifest.name).toBe('acme-portal');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.kind).toBe('webapp');
    expect(manifest.prompts).toHaveLength(2);
    const first = manifest.prompts?.[0];
    expect(first?.name).toBe('project_name');
    expect(first?.def).toMatchObject({ type: 'string', default: 'acme-portal' });
    expect(manifest.sections).toBeUndefined();
  });

  it('omits kind when blank and prompts when empty', () => {
    const yamlText = buildManifestYaml({ name: 'bare', kind: '  ', params: [] });
    expect(yamlText).not.toMatch(/kind:/);
    expect(yamlText).not.toMatch(/prompts:/);
  });

  it('fails loudly on a generator bug before anything is written', () => {
    expect(() =>
      buildManifestYaml({
        name: '',
        params: [],
      }),
    ).toThrow(ManifestError);
  });
});

describe('buildHexignore', () => {
  it('always includes the safety defaults', () => {
    const out = buildHexignore(undefined);
    expect(out).toMatch(/^\.git\/$/m);
    expect(out).toMatch(/^node_modules\/$/m);
    expect(out).toMatch(/^\.DS_Store$/m);
  });

  it('inherits .gitignore lines, deduping against the defaults', () => {
    const out = buildHexignore('node_modules/\ndist/\n# build artefacts\ncoverage/\n');
    expect(out.match(/node_modules\//g)).toHaveLength(1);
    expect(out).toMatch(/^dist\/$/m);
    expect(out).toMatch(/^# build artefacts$/m);
    expect(out).toMatch(/^coverage\/$/m);
  });
});

describe('buildPlan / countOccurrencesAcross', () => {
  const files: ScannedFile[] = [
    { rel: 'package.json', abs: '/x/package.json', binary: false, text: '{"name": "acme-portal"}' },
    {
      rel: 'src/acme-portal.config.ts',
      abs: '/x/src/acme-portal.config.ts',
      binary: false,
      text: 'export const app = "acme-portal";\n',
    },
    { rel: 'logo.png', abs: '/x/logo.png', binary: true },
    { rel: 'README.md', abs: '/x/README.md', binary: false, text: 'plain\n' },
  ];
  const params = [P('project_name', 'acme-portal')];

  it('classifies renames, content changes, and binaries', () => {
    const plan = buildPlan(files, params, 'manifest', 'ignore', []);
    const byRel = new Map(plan.files.map((f) => [f.rel, f]));
    expect(byRel.get('package.json')).toMatchObject({ renamed: false, contentChanged: true });
    expect(byRel.get('src/acme-portal.config.ts')).toMatchObject({
      renamed: true,
      newRel: 'src/{{ project_name }}.config.ts',
      contentChanged: true,
    });
    expect(byRel.get('logo.png')).toMatchObject({
      binary: true,
      renamed: false,
      contentChanged: false,
    });
    expect(byRel.get('README.md')).toMatchObject({ renamed: false, contentChanged: false });
    expect(plan.paramStats.project_name).toEqual({ total: 3, files: 2, paths: 1 });
  });

  it('counts candidate occurrences across contents and paths', () => {
    expect(countOccurrencesAcross(files, 'acme-portal')).toEqual({ total: 3, files: 2, paths: 1 });
    expect(countOccurrencesAcross(files, 'no-such-value')).toEqual({
      total: 0,
      files: 0,
      paths: 0,
    });
  });
});
