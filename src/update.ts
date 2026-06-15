import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { brand } from './brand/colors.js';
import { VERSION } from './brand/splash.js';
import { loadConfig } from './core/config/load.js';

const PKG_NAME = '@hexology/hex';
const REGISTRY = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 2000;

export async function maybeUpdate(): Promise<void> {
  // The central (enterprise / air-gapped) disable: a shared config with
  // `update: { check: false }` turns the check off without every shell
  // needing `HEX_NO_UPDATE_CHECK=1`. A broken/absent config must never
  // block startup, so swallow any load error and treat it as "enabled".
  let configCheckDisabled = false;
  try {
    const config = await loadConfig();
    configCheckDisabled = config.update?.check === false;
  } catch {
    configCheckDisabled = false;
  }

  if (
    !shouldCheck({
      noUpdateEnv: process.env.HEX_NO_UPDATE_CHECK === '1',
      stdinTTY: Boolean(process.stdin.isTTY),
      stdoutTTY: Boolean(process.stdout.isTTY),
      configCheckDisabled,
    })
  ) {
    return;
  }

  const latest = await fetchLatestVersion();
  if (!latest || !isNewerVersion(latest, VERSION)) return;

  console.log(
    `${brand.honey('▲')} hex ${brand.bold(latest)} is available — you have ${brand.dim(VERSION)}.`,
  );
  const yes = await confirm('Update now?');
  if (!yes) return;

  const ok = await runInstall();
  if (!ok) {
    console.error(brand.error('Update failed. Continuing with current version.'));
    return;
  }

  await relaunch();
}

export type ShouldCheckInput = {
  /** `HEX_NO_UPDATE_CHECK=1` set. */
  noUpdateEnv: boolean;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  /** `update.check === false` in config. */
  configCheckDisabled: boolean;
};

/**
 * Whether to run the startup update check. Disabled by the env var, by
 * config, or whenever either stream is not a TTY — so CI, pipes, and
 * headless shells (incl. air-gapped automation) never trigger a network
 * call. Pure + exported so the precedence is unit-testable.
 */
export function shouldCheck(input: ShouldCheckInput): boolean {
  if (input.noUpdateEnv) return false;
  if (input.configCheckDisabled) return false;
  if (!input.stdinTTY || !input.stdoutTTY) return false;
  return true;
}

/**
 * Fetch the latest published version, abandoning the attempt after
 * {@link FETCH_TIMEOUT_MS}. Every failure mode — offline, proxy hang,
 * non-200, malformed body, abort — resolves to `null` so the caller
 * silently continues with the current version. `fetchImpl` is injectable
 * for tests; production uses the global `fetch`.
 */
export async function fetchLatestVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetchImpl(`${REGISTRY}/${PKG_NAME}/latest`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': `hex/${VERSION}`, accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/** Compare two `MAJOR.MINOR.PATCH` strings: negative if a<b, 0 if equal, positive if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** True iff `latest` is a strictly newer version than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function runInstall(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['i', '-g', `${PKG_NAME}@latest`], {
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function relaunch(): Promise<never> {
  const args = process.argv.slice(2);
  return new Promise<never>((_, reject) => {
    const child = spawn('hex', args, { stdio: 'inherit', shell: false });
    child.on('exit', (code) => process.exit(code ?? 0));
    child.on('error', reject);
  });
}
