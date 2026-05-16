import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFromPath } from '../../../src/core/sources/file-source.js';
import { type LintCheck, lintStubComponent } from '../../../src/core/stub/lint.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hex-stub-lint-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

type Spec = {
  manifest: string;
  files?: Record<string, string>;
};

async function buildComponent(spec: Spec): Promise<string> {
  const root = join(work, 'component');
  await mkdir(join(root, '.hex'), { recursive: true });
  await writeFile(join(root, '.hex', 'manifest.yaml'), spec.manifest, 'utf8');
  for (const [rel, body] of Object.entries(spec.files ?? {})) {
    await mkdir(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), body, 'utf8');
  }
  return root;
}

async function lint(spec: Spec) {
  const bundle = await loadFromPath(await buildComponent(spec));
  return lintStubComponent(bundle);
}

function check(report: { checks: LintCheck[] }, id: LintCheck['id']): LintCheck {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check "${id}" in report`);
  return c;
}

const PG_MEM_MANIFEST = `type: component
name: db-postgres
version: 2.0.0
kind: db
stub:
  engine: pg-mem
`;

const WIREMOCK_MANIFEST = `type: component
name: api-mock
version: 1.0.0
kind: api
stub:
  engine: wiremock
`;

describe('lintStubComponent', () => {
  it('reports stubbable: false for a component with no stub block', async () => {
    const report = await lint({
      manifest: 'type: component\nname: plain\nversion: 1.0.0\n',
    });
    expect(report.stubbable).toBe(false);
    expect(report.checks).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('passes a fully prod-clean pg-mem component', async () => {
    const report = await lint({
      manifest: PG_MEM_MANIFEST,
      files: {
        'src/index.ts': '// prod',
        'src/index.dev.ts': '// dev',
        'package.json': JSON.stringify({ devDependencies: { 'pg-mem': '^3.0.0' } }),
      },
    });
    expect(report.ok).toBe(true);
    expect(check(report, 'entry-points').status).toBe('pass');
    expect(check(report, 'dev-dependencies').status).toBe('pass');
    expect(check(report, 'compose-profiles').status).toBe('skip');
  });

  it('fails entry-points when src/index.dev.ts is missing', async () => {
    const report = await lint({
      manifest: PG_MEM_MANIFEST,
      files: {
        'src/index.ts': '// prod',
        'package.json': JSON.stringify({ devDependencies: { 'pg-mem': '^3.0.0' } }),
      },
    });
    expect(report.ok).toBe(false);
    const c = check(report, 'entry-points');
    expect(c.status).toBe('fail');
    expect(c.message).toMatch(/src\/index\.dev\.ts/);
  });

  it('fails dev-dependencies when the stub engine is in dependencies', async () => {
    const report = await lint({
      manifest: PG_MEM_MANIFEST,
      files: {
        'src/index.ts': '// prod',
        'src/index.dev.ts': '// dev',
        'package.json': JSON.stringify({ dependencies: { 'pg-mem': '^3.0.0' } }),
      },
    });
    expect(check(report, 'dev-dependencies').status).toBe('fail');
    expect(check(report, 'dev-dependencies').message).toMatch(/move it to devDependencies/);
  });

  it('fails dev-dependencies when the stub engine is declared nowhere', async () => {
    const report = await lint({
      manifest: PG_MEM_MANIFEST,
      files: {
        'src/index.ts': '// prod',
        'src/index.dev.ts': '// dev',
        'package.json': JSON.stringify({ devDependencies: {} }),
      },
    });
    expect(check(report, 'dev-dependencies').status).toBe('fail');
    expect(check(report, 'dev-dependencies').message).toMatch(
      /neither dependencies nor devDependencies/,
    );
  });

  it('fails dev-dependencies when there is no package.json', async () => {
    const report = await lint({
      manifest: PG_MEM_MANIFEST,
      files: { 'src/index.ts': '// prod', 'src/index.dev.ts': '// dev' },
    });
    expect(check(report, 'dev-dependencies').status).toBe('fail');
    expect(check(report, 'dev-dependencies').message).toMatch(/no package.json/);
  });

  it('skips dev-dependencies for an out-of-process engine', async () => {
    const report = await lint({
      manifest: WIREMOCK_MANIFEST,
      files: {
        'src/index.ts': '// prod',
        'src/index.dev.ts': '// dev',
        'docker-compose.yml':
          'services:\n  wiremock:\n    image: wiremock/wiremock\n    profiles: [dev]\n',
      },
    });
    expect(check(report, 'dev-dependencies').status).toBe('skip');
    expect(report.ok).toBe(true);
  });

  it('passes compose-profiles when the wiremock service is dev-profiled', async () => {
    const report = await lint({
      manifest: WIREMOCK_MANIFEST,
      files: {
        'src/index.ts': '// prod',
        'src/index.dev.ts': '// dev',
        'docker-compose.yml':
          'services:\n  wiremock:\n    image: wiremock/wiremock\n    profiles: [dev]\n',
      },
    });
    expect(check(report, 'compose-profiles').status).toBe('pass');
  });

  it('fails compose-profiles when no service is dev-profiled', async () => {
    const report = await lint({
      manifest: WIREMOCK_MANIFEST,
      files: {
        'src/index.ts': '// prod',
        'src/index.dev.ts': '// dev',
        'docker-compose.yml': 'services:\n  wiremock:\n    image: wiremock/wiremock\n',
      },
    });
    expect(check(report, 'compose-profiles').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('skips compose-profiles when an out-of-process component ships no compose file', async () => {
    const report = await lint({
      manifest: WIREMOCK_MANIFEST,
      files: { 'src/index.ts': '// prod', 'src/index.dev.ts': '// dev' },
    });
    expect(check(report, 'compose-profiles').status).toBe('skip');
    expect(report.ok).toBe(true);
  });
});
