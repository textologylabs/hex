import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import * as clack from '@clack/prompts';
import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import { sym } from '../brand/glyphs.js';
import { splash } from '../brand/splash.js';
import { buildHexignore, buildManifestYaml } from '../core/hexify/generate.js';
import {
  type HexifyPlan,
  type OccurrenceCount,
  type RoundTripResult,
  type ScannedFile,
  applyPlan,
  buildPlan,
  countOccurrencesAcross,
  scanRepo,
  verifyRoundTrip,
  writeShadowTemplate,
} from '../core/hexify/pipeline.js';
import type { HexifyParam } from '../core/hexify/substitute.js';
import { readLockfileUpward } from '../core/lockfile/index.js';
import { ManifestError } from '../core/manifest/parse.js';
import { createClackPrompter } from '../core/prompts/clack-prompter.js';
import type { Prompter } from '../core/prompts/types.js';
import { loadFromPath } from '../core/sources/file-source.js';

/**
 * `hex hexify` (Hex 2.0 / H1). Converts a plain, manually-maintained
 * template repo into a hex template IN PLACE: injects a generated
 * `.hex/manifest.yaml` (one string prompt per confirmed parameter,
 * defaults = the original concrete values), substitutes `{{ … }}`
 * placeholders across file contents AND paths, neutralises pre-existing
 * Nunjucks-hazard sequences, and writes a `.gitignore`-seeded
 * `.hexignore`.
 *
 * The safety story is double-walled. Git first: the preflight refuses a
 * dirty tree, so review is `git diff` and undo is `git checkout .`.
 * Then the round-trip gate: the hexified template is built in a
 * throwaway SHADOW dir and rendered back with the original values as
 * answers — only when that render byte-matches the repo does anything
 * touch it. Gate fails ⇒ zero writes. `--dry-run` runs the whole
 * pipeline, gate included, and writes nothing.
 *
 * After hexify: commit, `hex new` scaffolds fresh instances, and
 * existing hand-copied instances can be `hex adopt`ed — the fit report
 * gauges hexification quality.
 */

export type HexifyCommandOptions = {
  dryRun?: boolean;
  json?: boolean;
};

export type HexifyCommandEffects = {
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  setExitCode: (code: number) => void;
  prompterFactory: (interactive: boolean) => Prompter;
  /**
   * Git preflight seam. The default shells out to git; tests inject
   * fakes for the guard paths and the integration pack uses the real
   * implementation against scratch repos.
   */
  gitStatus: (dir: string) => Promise<{ isRepo: boolean; clean: boolean }>;
  /**
   * Shadow-root factory (the pipeline uses `<shadow>/template` and
   * `<shadow>/render` beneath it). A seam so the cleanup guarantee is
   * assertable in tests.
   */
  makeShadowDir: () => Promise<string>;
  /**
   * Test-only hook, invoked after the shadow template is written and
   * before the round-trip gate runs — the only honest way to exercise
   * the gate-failure path, since a correct pipeline never fails its
   * own proof.
   */
  afterShadowBuild?: (shadowTemplateDir: string) => Promise<void>;
};

const execFileAsync = promisify(execFile);

async function defaultGitStatus(dir: string): Promise<{ isRepo: boolean; clean: boolean }> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  } catch {
    return { isRepo: false, clean: false };
  }
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir });
  return { isRepo: true, clean: stdout.trim() === '' };
}

export const defaultHexifyCommandEffects: HexifyCommandEffects = {
  stdout: process.stdout,
  stderr: process.stderr,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  prompterFactory: () => createClackPrompter(),
  gitStatus: defaultGitStatus,
  makeShadowDir: () => mkdtemp(join(tmpdir(), 'hex-hexify-')),
};

/** How many paths a report group lists before truncating. */
const MAX_LISTED = 10;

export type HexifyReport = {
  template: { name: string; version: string; kind?: string };
  parameters: Array<{ name: string; value: string; occurrences: OccurrenceCount }>;
  /** Files rewritten in place (substitutions or hazard escapes). */
  filesChanged: string[];
  /** Files renamed so their path carries a placeholder. */
  renamed: Array<{ from: string; to: string }>;
  /** The generated .hexignore, line by line. */
  hexignore: string[];
  roundTrip: RoundTripResult;
  dryRun: boolean;
};

/** Reshape a plan + gate result into the report. Pure — no I/O. */
export function buildHexifyReport(
  plan: HexifyPlan,
  roundTrip: RoundTripResult,
  opts: { dryRun: boolean },
): HexifyReport {
  const templateName = extractManifestName(plan.manifestYaml);
  return {
    template: templateName,
    parameters: plan.params.map((p) => ({
      name: p.name,
      value: p.value,
      occurrences: plan.paramStats[p.name] ?? { total: 0, files: 0, paths: 0 },
    })),
    filesChanged: plan.files
      .filter((f) => f.contentChanged && !f.renamed)
      .map((f) => f.rel)
      .sort(),
    renamed: plan.files
      .filter((f) => f.renamed)
      .map((f) => ({ from: f.rel, to: f.newRel }))
      .sort((a, b) => (a.from < b.from ? -1 : 1)),
    hexignore: plan.hexignore.split('\n').filter((l) => l !== ''),
    roundTrip,
    dryRun: opts.dryRun,
  };
}

function extractManifestName(manifestYaml: string): HexifyReport['template'] {
  // The manifest was schema-validated at generation time; this is a
  // display-only convenience read.
  const name = manifestYaml.match(/^name: (.*)$/m)?.[1] ?? 'template';
  const kind = manifestYaml.match(/^kind: (.*)$/m)?.[1];
  return kind ? { name, version: '0.1.0', kind } : { name, version: '0.1.0' };
}

function listGroup(title: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const lines = [`${title} (${paths.length}):`];
  for (const p of paths.slice(0, MAX_LISTED)) lines.push(brand.dim(`  ${p}`));
  if (paths.length > MAX_LISTED) lines.push(brand.dim(`  … and ${paths.length - MAX_LISTED} more`));
  return lines;
}

/** Pure text rendering of a hexify report (the `--json` path bypasses this). */
export function formatHexifyText(report: HexifyReport): string {
  const { template, roundTrip } = report;
  const label = brand.bold(`${template.name}@${template.version}`);
  const lines: string[] = [];

  if (!roundTrip.ok) {
    lines.push(`round-trip proof FAILED for ${label} — nothing was written`);
    lines.push(...listGroup('bytes differ after render', roundTrip.mismatched));
    lines.push(...listGroup('in the repo but not the render', roundTrip.onlyInOriginal));
    lines.push(...listGroup('in the render but not the repo', roundTrip.onlyInRendered));
    return lines.join('\n');
  }

  const summary = `${report.parameters.length} parameter${
    report.parameters.length === 1 ? '' : 's'
  }, ${report.filesChanged.length} rewritten, ${report.renamed.length} renamed`;
  if (report.dryRun) {
    lines.push(`Hexify preview for ${label} — ${summary}`);
    lines.push(brand.dim('--dry-run: nothing written.'));
  } else {
    lines.push(`${sym.ok()} Hexified ${label} — ${summary}`);
  }
  for (const p of report.parameters) {
    lines.push(
      brand.dim(
        `  {{ ${p.name} }} ← "${p.value}" (${p.occurrences.total} occurrence${
          p.occurrences.total === 1 ? '' : 's'
        })`,
      ),
    );
  }
  lines.push(...listGroup('rewritten (placeholders / hazard escapes)', report.filesChanged));
  if (report.renamed.length > 0) {
    lines.push(`renamed (${report.renamed.length}):`);
    for (const r of report.renamed.slice(0, MAX_LISTED)) {
      lines.push(brand.dim(`  ${r.from} → ${r.to}`));
    }
    if (report.renamed.length > MAX_LISTED) {
      lines.push(brand.dim(`  … and ${report.renamed.length - MAX_LISTED} more`));
    }
  }
  lines.push(
    `round-trip proof: ${roundTrip.checked} file${
      roundTrip.checked === 1 ? '' : 's'
    } render back byte-identical`,
  );
  if (!report.dryRun) {
    lines.push(
      brand.dim('next: review with git diff, commit, then hex new — or hex adopt an instance'),
    );
  }
  return lines.join('\n');
}

function emitReport(
  effects: HexifyCommandEffects,
  report: HexifyReport,
  opts: HexifyCommandOptions,
): void {
  if (opts.json) {
    effects.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  effects.stdout.write(`${formatHexifyText(report)}\n`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

type PackageSeeds = {
  name?: string;
  description?: string;
  author?: string;
  license?: string;
};

async function readPackageSeeds(repoRoot: string): Promise<PackageSeeds> {
  try {
    const raw = await readFile(join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const author =
      typeof pkg.author === 'object' && pkg.author !== null
        ? str((pkg.author as Record<string, unknown>).name)
        : str(pkg.author);
    return {
      name: str(pkg.name),
      description: str(pkg.description),
      author,
      license: str(pkg.license),
    };
  } catch {
    return {};
  }
}

const PROMPT_NAME_RE = /^[a-z_][a-z0-9_]*$/;
const MIN_VALUE_LENGTH = 3;

/** The obvious parameterisation candidates, in proposal order. */
function autoCandidates(seeds: PackageSeeds): HexifyParam[] {
  const c: HexifyParam[] = [];
  if (seeds.name) c.push({ name: 'project_name', value: seeds.name, description: 'Package name' });
  if (seeds.description) {
    c.push({ name: 'description', value: seeds.description, description: 'Short description' });
  }
  if (seeds.author) c.push({ name: 'author', value: seeds.author, description: 'Author' });
  if (seeds.license) c.push({ name: 'license', value: seeds.license, description: 'License' });
  return c;
}

function describeCount(o: OccurrenceCount): string {
  const parts = [`${o.total} occurrence${o.total === 1 ? '' : 's'}`];
  if (o.files > 0) parts.push(`${o.files} file${o.files === 1 ? '' : 's'}`);
  if (o.paths > 0) parts.push(`${o.paths} filename${o.paths === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** The guided parameterisation dialogue. Pure prompter-driven — no I/O. */
async function collectParams(
  prompter: Prompter,
  files: ScannedFile[],
  seeds: PackageSeeds,
): Promise<HexifyParam[]> {
  const accepted: HexifyParam[] = [];
  const usedValues = new Set<string>();
  const usedNames = new Set<string>();

  for (const candidate of autoCandidates(seeds)) {
    const value = candidate.value.trim();
    if (value.length < MIN_VALUE_LENGTH) continue;
    if (usedValues.has(value)) {
      prompter.note?.(
        `"${value}" already parameterised — skipping duplicate candidate {{ ${candidate.name} }}`,
      );
      continue;
    }
    const count = countOccurrencesAcross(files, value);
    if (count.total === 0) continue;
    const yes = await prompter.confirm({
      message: `Parameterise "${value}" as {{ ${candidate.name} }}? (${describeCount(count)})`,
      default: true,
    });
    if (yes) {
      accepted.push({ ...candidate, value });
      usedValues.add(value);
      usedNames.add(candidate.name);
    }
  }

  while (
    await prompter.confirm({
      message: 'Add a custom parameter (another concrete value to replace)?',
      default: false,
    })
  ) {
    const value = (
      await prompter.text({
        message: 'Concrete value to parameterise',
        validate: (v) =>
          v.trim().length < MIN_VALUE_LENGTH
            ? `use at least ${MIN_VALUE_LENGTH} characters — short values over-match`
            : usedValues.has(v.trim())
              ? 'that value is already parameterised'
              : undefined,
      })
    ).trim();
    const count = countOccurrencesAcross(files, value);
    if (count.total === 0) {
      prompter.note?.(`no occurrences of "${value}" found — skipped`);
      continue;
    }
    const name = await prompter.text({
      message: `Prompt name for "${value}" (e.g. db_name)`,
      validate: (v) =>
        !PROMPT_NAME_RE.test(v)
          ? 'lower_snake_case identifiers only (^[a-z_][a-z0-9_]*$)'
          : usedNames.has(v)
            ? 'that prompt name is already taken'
            : undefined,
    });
    accepted.push({ name, value, description: name.replace(/_/g, ' ') });
    usedValues.add(value);
    usedNames.add(name);
    prompter.note?.(`{{ ${name} }} ← "${value}" (${describeCount(count)})`);
  }

  return accepted;
}

export async function runHexifyCommand(
  repoRoot: string,
  effects: HexifyCommandEffects,
  opts: HexifyCommandOptions = {},
): Promise<void> {
  // Guard 1 — already a hex template? Cheapest check first. (A template
  // dir has a manifest but no lockfile, so the lockfile guard below
  // would miss it.)
  if (
    (await pathExists(join(repoRoot, '.hex', 'manifest.yaml'))) ||
    (await pathExists(join(repoRoot, '.hex', 'manifest.yml')))
  ) {
    effects.stderr.write(
      `${brand.error('already a hex template (.hex/manifest.yaml exists) — nothing to hexify')}\n`,
    );
    effects.setExitCode(1);
    return;
  }

  // Guard 2 — a hex APP (scaffolded or adopted)? The upward walk also
  // refuses running from a nested subdirectory of one.
  let existing: Awaited<ReturnType<typeof readLockfileUpward>>;
  try {
    existing = await readLockfileUpward(repoRoot);
  } catch (err) {
    effects.stderr.write(
      `${brand.error(
        `found a .hex/lockfile.yaml but it is unreadable: ${
          err instanceof Error ? err.message : String(err)
        } — fix or remove it before hexifying`,
      )}\n`,
    );
    effects.setExitCode(1);
    return;
  }
  if (existing) {
    effects.stderr.write(
      `${brand.error(
        `this is a hex app (lockfile in ${existing.rootDir}) — hexify converts template repos, not generated apps`,
      )}\n`,
    );
    effects.setExitCode(1);
    return;
  }

  // Guard 3 — git preflight. Hexify rewrites files in place; git is the
  // review-and-undo story, so a repo and a clean tree are non-negotiable.
  const git = await effects.gitStatus(repoRoot);
  if (!git.isRepo) {
    effects.stderr.write(
      `${brand.error(
        'not a git repository — hexify rewrites files in place and relies on git as the undo (git init && git add -A && git commit first)',
      )}\n`,
    );
    effects.setExitCode(1);
    return;
  }
  if (!git.clean) {
    effects.stderr.write(
      `${brand.error(
        'working tree not clean — commit or stash first (git diff is the review, git checkout . the undo)',
      )}\n`,
    );
    effects.setExitCode(1);
    return;
  }

  // Seeds + scan. The generated .hexignore's patterns gate the scan, so
  // node_modules-on-disk never enters the template.
  const seeds = await readPackageSeeds(repoRoot);
  const hexignore = buildHexignore(await readTextIfPresent(join(repoRoot, '.gitignore')));
  const ignorePatterns = hexignore.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
  const files = await scanRepo(repoRoot, ignorePatterns);
  if (files.length === 0) {
    effects.stderr.write(
      `${brand.error('nothing to hexify — the repo has no files outside the ignore patterns')}\n`,
    );
    effects.setExitCode(1);
    return;
  }

  // Guided dialogue — before any temp dir exists, so a cancel needs no
  // cleanup. PromptCancelledError propagates for the top-level 130.
  const prompter = effects.prompterFactory(true);
  prompter.note?.(
    [
      `Scanning ${files.length} files (ignore: ${ignorePatterns.join(', ')}).`,
      'Each confirmed value becomes a template prompt whose default is the',
      'current value; every occurrence — contents and filenames — becomes a',
      '{{ placeholder }}. Nothing is written unless a render with the',
      'original values reproduces this repo byte-for-byte.',
    ].join('\n'),
    'hex hexify',
  );

  const templateName = await prompter.text({
    message: 'Template name',
    default: seeds.name ?? basename(repoRoot),
    validate: (v) => (v.trim().length === 0 ? 'a template needs a name' : undefined),
  });
  const kind = await prompter.text({
    message: 'Component kind (e.g. webapp, lib — blank to omit)',
    default: '',
  });

  const params = await collectParams(prompter, files, seeds);

  if (params.length === 0) {
    const anyway = await prompter.confirm({
      message: 'No parameters confirmed — hexify anyway (instances would be identical copies)?',
      default: false,
    });
    if (!anyway) {
      effects.stdout.write('nothing hexified — no parameters confirmed\n');
      return;
    }
  }

  let manifestYaml: string;
  try {
    manifestYaml = buildManifestYaml({ name: templateName.trim(), kind, params });
  } catch (err) {
    if (err instanceof ManifestError) {
      effects.stderr.write(`${brand.error(`generated manifest is invalid: ${err.message}`)}\n`);
      effects.setExitCode(1);
      return;
    }
    throw err;
  }

  const plan = buildPlan(files, params, manifestYaml, hexignore, ignorePatterns);

  if (!opts.dryRun) {
    const proceed = await prompter.confirm({
      message: `Write the hexified template into ${repoRoot}?`,
      default: true,
    });
    if (!proceed) {
      effects.stdout.write('aborted — nothing written\n');
      return;
    }
  }

  // Shadow phase — build the template AWAY from the repo and prove the
  // round trip before a single in-place byte moves.
  const shadowDir = await effects.makeShadowDir();
  try {
    const shadowTemplate = join(shadowDir, 'template');
    await writeShadowTemplate(plan, shadowTemplate);
    await effects.afterShadowBuild?.(shadowTemplate);
    const roundTrip = await verifyRoundTrip(
      shadowTemplate,
      repoRoot,
      plan,
      join(shadowDir, 'render'),
    );

    if (!roundTrip.ok) {
      emitReport(
        effects,
        buildHexifyReport(plan, roundTrip, { dryRun: opts.dryRun ?? false }),
        opts,
      );
      effects.stderr.write(
        `${brand.error('round-trip proof failed — the repo was not touched')}\n`,
      );
      effects.setExitCode(1);
      return;
    }

    if (opts.dryRun) {
      emitReport(effects, buildHexifyReport(plan, roundTrip, { dryRun: true }), opts);
      return;
    }

    await applyPlan(repoRoot, plan);

    // Reload proof: the repo must now load exactly as every future
    // consumer (`hex new`, `hex adopt`) will load it.
    await loadFromPath(repoRoot, 'file');

    emitReport(effects, buildHexifyReport(plan, roundTrip, { dryRun: false }), opts);
  } finally {
    await rm(shadowDir, { recursive: true, force: true });
  }
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function registerHexify(program: Command): void {
  program
    .command('hexify')
    .description(
      'convert this repo into a hex template in place — round-trip-proven, git is the undo',
    )
    .option('--dry-run', 'run the full pipeline, round-trip gate included; write nothing', false)
    .option('--json', 'emit the hexify report as machine-readable JSON', false)
    .action(async (opts: { dryRun: boolean; json: boolean }) => {
      // `--json` stdout must stay parseable — no splash, no clack chrome.
      if (!opts.json) {
        process.stdout.write(`${splash()}\n`);
        clack.intro(brand.honeyBold(' hex hexify '));
      }
      await runHexifyCommand(process.cwd(), defaultHexifyCommandEffects, {
        dryRun: opts.dryRun,
        json: opts.json,
      });
    });
}
