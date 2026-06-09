import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import { splash } from '../brand/splash.js';
import {
  type LoadedChecklist,
  countByStatus,
  readChecklistUpward,
} from '../core/checklist/index.js';
import {
  type LoadedLockfile,
  type LockChild,
  type LockfileIntegrity,
  checkLockfileIntegrity,
  readLockfileUpward,
} from '../core/lockfile/index.js';

/**
 * Runtime + project-state info `hex doctor` reports. The pure
 * `buildDoctorReport` builds this from the loaded checklist + lockfile;
 * `formatDoctorText` / `formatDoctorJson` render it.
 */
export type DoctorEnvInfo = {
  node: string;
  platform: string;
  terminal: string;
};

/**
 * One pending task as it appears in `--json` output. Mirrors the
 * checklist shape so the consumer can decide what to surface.
 */
export type DoctorSetupTask = {
  id: string;
  title: string;
  run?: string;
  open?: string;
  detail?: string;
};

export type DoctorSetupReport = {
  /** Counts split into the two stored statuses. */
  counts: { pending: number; done: number };
  /** Tasks whose status is `pending`, in declared order. */
  pending: DoctorSetupTask[];
};

export type DoctorLockfileReport = {
  root: { name: string; version: string; type: 'component' | 'recipe' };
  children: Array<{
    key: string;
    name: string;
    version: string;
    type: 'component' | 'recipe';
    stub: boolean;
    children?: DoctorLockfileReport['children'];
  }>;
  /** `null` when checking the integrity itself threw (e.g., I/O error). */
  integrity: LockfileIntegrity | null;
};

export type DoctorReport = {
  env: DoctorEnvInfo;
  setup?: DoctorSetupReport;
  lockfile?: DoctorLockfileReport;
  /** A present-but-unreadable lockfile surfaces here as a single line. */
  lockfileWarning?: string;
};

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('inspect terminal capabilities and runtime info')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (opts: { json: boolean }) => {
      const env: DoctorEnvInfo = {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        terminal: process.env.TERM_PROGRAM ?? process.env.TERM ?? 'unknown',
      };

      const loaded = await readChecklistUpward(process.cwd()).catch(() => null);
      const { lockfile, integrity, warning } = await loadLockfileForDoctor(process.cwd());

      const report = buildDoctorReport(env, loaded, lockfile, integrity, warning);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      console.log(formatDoctorText(report));
    });
}

/**
 * Pure assembly of a `DoctorReport` from the inputs each surface
 * already knows how to load. Easy to unit-test the shape without
 * touching the filesystem.
 *
 * Section ordering in `formatDoctorText` is fixed (env, lockfile,
 * setup). Doctor surfaces the lockfile FIRST because it's the more
 * authoritative project-state signal — outstanding setup tasks are a
 * recovery-path concern that follows.
 */
export function buildDoctorReport(
  env: DoctorEnvInfo,
  loaded: LoadedChecklist | null,
  lockfileLoaded: LoadedLockfile | null,
  integrity: LockfileIntegrity | null,
  lockfileWarning?: string,
): DoctorReport {
  const report: DoctorReport = { env };

  if (loaded) {
    const counts = countByStatus(loaded.checklist);
    const pending: DoctorSetupTask[] = loaded.checklist.tasks
      .filter((t) => t.status === 'pending')
      .map((t) => ({
        id: t.id,
        title: t.title,
        ...(t.run !== undefined && { run: t.run }),
        ...(t.open !== undefined && { open: t.open }),
        ...(t.detail !== undefined && { detail: t.detail }),
      }));
    report.setup = { counts: { pending: counts.pending, done: counts.done }, pending };
  }

  if (lockfileLoaded) {
    report.lockfile = {
      root: {
        name: lockfileLoaded.lockfile.root.name,
        version: lockfileLoaded.lockfile.root.version,
        type: lockfileLoaded.lockfile.root.type,
      },
      children: shapeChildren(lockfileLoaded.lockfile.children ?? []),
      integrity,
    };
  } else if (lockfileWarning !== undefined) {
    report.lockfileWarning = lockfileWarning;
  }

  return report;
}

function shapeChildren(
  children: LockChild[],
): DoctorReport['lockfile'] extends infer T
  ? T extends { children: infer C }
    ? C
    : never
  : never {
  return children.map((c) => ({
    key: c.key,
    name: c.name,
    version: c.version,
    type: c.type,
    stub: c.stub,
    ...(c.children && c.children.length > 0 && { children: shapeChildren(c.children) }),
  })) as ReturnType<typeof shapeChildren>;
}

/**
 * Render the textual `hex doctor` output. Pure: no I/O, no stdout.
 *
 * Section order: env table → lockfile (when present) → outstanding
 * setup tasks (when any). The setup section surfaces a recovery hint
 * (`run "hex setup"`) since this is the only place the user might
 * land after a Ctrl-C'd `hex new`.
 */
export function formatDoctorText(report: DoctorReport): string {
  const lines: string[] = [
    splash(),
    '',
    row('Node', report.env.node),
    row('Platform', report.env.platform),
    row('Terminal', report.env.terminal),
  ];

  if (report.lockfile) {
    lines.push('', formatLockfileFromReport(report.lockfile));
  } else if (report.lockfileWarning !== undefined) {
    lines.push('', `${brand.bold('Lockfile')}  ${brand.warn('⚠')}  ${report.lockfileWarning}`);
  }

  if (report.setup && report.setup.counts.pending > 0) {
    lines.push('', formatSetupFromReport(report.setup));
  }

  return lines.join('\n');
}

function row(label: string, value: string): string {
  return `  ${brand.dim(label.padEnd(16))}  ${value}`;
}

function formatSetupFromReport(setup: DoctorSetupReport): string {
  const { counts } = setup;
  const header = brand.bold(
    `Outstanding setup tasks  ${brand.dim(`(${counts.pending} pending, ${counts.done} done)`)}`,
  );
  const rows = setup.pending.map((t) => {
    const action = actionHint(t);
    const actionTail = action !== '' ? `  ${brand.dim(action)}` : '';
    return `  ${brand.dim('[ ]')}  ${t.id}  ${brand.dim('—')}  ${t.title}${actionTail}`;
  });
  const footer = brand.dim('  run "hex setup" to walk through them');
  return [header, ...rows, footer].join('\n');
}

/**
 * Brief action hint surfaced inline with a pending task, so doctor's
 * output answers "what would running this do?" without the user
 * having to open the manifest. Mirrors M14.7's executor priority:
 * `run:` ahead of `open:`; pure-`detail:` tasks get no hint (their
 * action is the title's prose).
 */
function actionHint(t: DoctorSetupTask): string {
  if (t.run !== undefined) return `→ run: ${t.run}`;
  if (t.open !== undefined) return `→ open: ${t.open}`;
  return '';
}

function formatLockfileFromReport(lf: NonNullable<DoctorReport['lockfile']>): string {
  const header = brand.bold(
    `Lockfile  ${brand.dim(`(${lf.root.type} ${lf.root.name}@${lf.root.version})`)}`,
  );
  const childRows: string[] = [];
  appendChildRowsFromReport(lf.children, 1, childRows);
  return [header, ...childRows, integrityLine(lf.integrity)].join('\n');
}

function appendChildRowsFromReport(
  children: NonNullable<DoctorReport['lockfile']>['children'],
  depth: number,
  out: string[],
): void {
  for (const c of children) {
    const indent = '  '.repeat(depth);
    const stub = c.stub ? brand.dim(' (stub)') : '';
    out.push(`${indent}${c.key}  ${brand.dim('—')}  ${c.name}@${c.version}${stub}`);
    if (c.children) appendChildRowsFromReport(c.children, depth + 1, out);
  }
}

/** The single integrity-status line: a clean ✓ or an "N files diverged" ⚠. */
function integrityLine(integrity: LockfileIntegrity | null): string {
  if (!integrity) return `  ${brand.dim('integrity: not checked')}`;
  if (integrity.ok) return `  ${brand.done('✓')}  integrity clean`;

  const total = integrity.modified.length + integrity.missing.length + integrity.added.length;
  const breakdown = `${integrity.modified.length} modified, ${integrity.missing.length} missing, ${integrity.added.length} added`;
  return `  ${brand.warn('⚠')}  ${total} file${total === 1 ? '' : 's'} diverged from the lockfile  ${brand.dim(`(${breakdown})`)}`;
}

/**
 * Render an "Outstanding setup tasks" block for `hex doctor`. Kept as
 * a thin public wrapper so the M3-era tests that exercise it directly
 * keep passing — internally it routes through the report builder.
 * Returns null when there's no checklist nearby or every task is
 * already done.
 */
export function formatSetupSection(loaded: LoadedChecklist | null): string | null {
  if (!loaded) return null;
  const counts = countByStatus(loaded.checklist);
  if (counts.pending === 0) return null;
  const report = buildDoctorReport({ node: '', platform: '', terminal: '' }, loaded, null, null);
  if (!report.setup) return null;
  return formatSetupFromReport(report.setup);
}

/**
 * Render the "Lockfile" block. Public wrapper for backwards
 * compatibility with the M10-era tests; internally routes through
 * the report builder.
 */
export function formatLockfileSection(
  loaded: LoadedLockfile | null,
  integrity: LockfileIntegrity | null,
): string | null {
  if (!loaded) return null;
  const report = buildDoctorReport(
    { node: '', platform: '', terminal: '' },
    null,
    loaded,
    integrity,
  );
  if (!report.lockfile) return null;
  return formatLockfileFromReport(report.lockfile);
}

/**
 * Load the nearest lockfile, run its integrity check, and pack the
 * result for `buildDoctorReport`. A present-but-unreadable lockfile
 * (malformed, or written by a newer Hex) surfaces as `warning`
 * instead — doctor renders that as a one-line ⚠ in place of the full
 * block. Absent lockfile → all three slots null.
 */
async function loadLockfileForDoctor(cwd: string): Promise<{
  lockfile: LoadedLockfile | null;
  integrity: LockfileIntegrity | null;
  warning?: string;
}> {
  let loaded: LoadedLockfile | null;
  try {
    loaded = await readLockfileUpward(cwd);
  } catch (err) {
    return {
      lockfile: null,
      integrity: null,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
  if (!loaded) return { lockfile: null, integrity: null };
  const integrity = await checkLockfileIntegrity(loaded.rootDir, loaded.lockfile).catch(() => null);
  return { lockfile: loaded, integrity };
}
