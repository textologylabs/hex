import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { StubEngine } from '../manifest/types.js';
import type { ComponentBundle } from '../sources/file-source.js';
import { engineNpmPackage, isOutOfProcess } from './catalogue.js';

export type LintStatus = 'pass' | 'fail' | 'skip';

export type LintCheck = {
  id: 'entry-points' | 'dev-dependencies' | 'compose-profiles';
  status: LintStatus;
  message: string;
};

export type LintReport = {
  /** True when the component declares a `stub:` block — the lint only applies to stubbable components. */
  stubbable: boolean;
  engine?: StubEngine;
  checks: LintCheck[];
  /** True when no check failed (skips and passes both count as OK). */
  ok: boolean;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lint a stubbable component against the "no stubs in the production
 * build" conventions (idea.md §6 / M8.5):
 *
 * 1. **entry-points** — separate `src/index.ts` (prod) and
 *    `src/index.dev.ts` (dev) so bundlers tree-shake stub code out of
 *    prod artifacts.
 * 2. **dev-dependencies** — an in-process engine's npm package lives in
 *    `devDependencies`, so `npm install --omit=dev` pulls none of it.
 * 3. **compose-profiles** — an out-of-process engine's stub service is
 *    gated behind `profiles: [dev]` so `docker-compose up` stays
 *    prod-shape.
 *
 * A component without a `stub:` block is real-only — the lint reports
 * `stubbable: false` with no checks and `ok: true`.
 */
export async function lintStubComponent(bundle: ComponentBundle): Promise<LintReport> {
  const stub = bundle.manifest.stub;
  if (!stub) {
    return { stubbable: false, checks: [], ok: true };
  }

  const checks: LintCheck[] = [
    await checkEntryPoints(bundle.rootPath),
    await checkDevDependencies(bundle.rootPath, stub.engine),
    await checkComposeProfiles(bundle.rootPath, stub.engine),
  ];

  return {
    stubbable: true,
    engine: stub.engine,
    checks,
    ok: checks.every((c) => c.status !== 'fail'),
  };
}

async function checkEntryPoints(rootPath: string): Promise<LintCheck> {
  const prod = await pathExists(join(rootPath, 'src', 'index.ts'));
  const dev = await pathExists(join(rootPath, 'src', 'index.dev.ts'));
  if (prod && dev) {
    return {
      id: 'entry-points',
      status: 'pass',
      message: 'src/index.ts (prod) and src/index.dev.ts (dev) are both present',
    };
  }
  const missing = [!prod && 'src/index.ts', !dev && 'src/index.dev.ts'].filter(Boolean);
  return {
    id: 'entry-points',
    status: 'fail',
    message: `missing ${missing.join(' and ')} — stubbable components need separate prod/dev entry points so bundlers tree-shake stub code out of prod builds`,
  };
}

async function checkDevDependencies(rootPath: string, engine: StubEngine): Promise<LintCheck> {
  const pkg = engineNpmPackage(engine);
  if (!pkg) {
    return {
      id: 'dev-dependencies',
      status: 'skip',
      message: `n/a — ${engine} is an out-of-process engine with no npm package`,
    };
  }

  const pkgJsonPath = join(rootPath, 'package.json');
  let raw: string;
  try {
    raw = await readFile(pkgJsonPath, 'utf8');
  } catch {
    return {
      id: 'dev-dependencies',
      status: 'fail',
      message: 'no package.json found to verify stub-engine dependency placement',
    };
  }

  let parsed: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      id: 'dev-dependencies',
      status: 'fail',
      message: `package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (parsed.dependencies && pkg in parsed.dependencies) {
    return {
      id: 'dev-dependencies',
      status: 'fail',
      message: `${pkg} is in dependencies — move it to devDependencies so prod \`npm install --omit=dev\` excludes it`,
    };
  }
  if (parsed.devDependencies && pkg in parsed.devDependencies) {
    return {
      id: 'dev-dependencies',
      status: 'pass',
      message: `${pkg} is correctly declared in devDependencies`,
    };
  }
  return {
    id: 'dev-dependencies',
    status: 'fail',
    message: `${pkg} is in neither dependencies nor devDependencies — declare the stub engine in devDependencies`,
  };
}

const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml'];

async function checkComposeProfiles(rootPath: string, engine: StubEngine): Promise<LintCheck> {
  if (!isOutOfProcess(engine)) {
    return {
      id: 'compose-profiles',
      status: 'skip',
      message: `n/a — ${engine} is in-process and needs no compose service`,
    };
  }

  let composePath: string | undefined;
  for (const name of COMPOSE_FILENAMES) {
    if (await pathExists(join(rootPath, name))) {
      composePath = join(rootPath, name);
      break;
    }
  }
  if (!composePath) {
    return {
      id: 'compose-profiles',
      status: 'skip',
      message:
        'no docker-compose.yml in the component — the recipe root assembles the shared stub service (M8.3)',
    };
  }

  let services: Record<string, unknown> = {};
  try {
    const doc = parseYaml(await readFile(composePath, 'utf8')) as {
      services?: Record<string, unknown>;
    };
    services = doc?.services ?? {};
  } catch (err) {
    return {
      id: 'compose-profiles',
      status: 'fail',
      message: `docker-compose.yml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const devProfiled = Object.values(services).some((svc) => {
    if (!svc || typeof svc !== 'object') return false;
    const profiles = (svc as { profiles?: unknown }).profiles;
    return Array.isArray(profiles) && profiles.includes('dev');
  });

  if (devProfiled) {
    return {
      id: 'compose-profiles',
      status: 'pass',
      message: 'at least one service is gated behind `profiles: [dev]`',
    };
  }
  return {
    id: 'compose-profiles',
    status: 'fail',
    message:
      'docker-compose.yml has no service behind `profiles: [dev]` — stub services must be dev-profiled so `docker-compose up` stays prod-shape',
  };
}
