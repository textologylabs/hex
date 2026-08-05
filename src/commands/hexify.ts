import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as clack from '@clack/prompts';
import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import { sym } from '../brand/glyphs.js';
import { splash } from '../brand/splash.js';
import { buildAgentPrompt } from '../core/hexify/emit-prompt.js';
import { buildHexignore, buildManifestYaml } from '../core/hexify/generate.js';
import { type MinedPair, mineCandidatePairs } from '../core/hexify/mine.js';
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
import { type HexifyPlanFile, PlanFileError, loadPlanFile } from '../core/hexify/plan-file.js';
import { type HexifyParam, MIN_VALUE_LENGTH, PROMPT_NAME_RE } from '../core/hexify/substitute.js';
import { readLockfileUpward } from '../core/lockfile/index.js';
import { ManifestError } from '../core/manifest/parse.js';
import { createClackPrompter } from '../core/prompts/clack-prompter.js';
import type { Prompter } from '../core/prompts/types.js';
import { loadFromPath } from '../core/sources/file-source.js';
import { writeFileAtomic } from '../core/util/atomic.js';

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
  /**
   * Path to a known INSTANCE of this template (H2): the template↔instance
   * diff is mined for candidate value pairs, proposed with evidence in
   * the same confirm dialogue. Best taken at an early ref of the
   * instance — later drift just produces junk proposals to decline.
   */
  against?: string;
  /**
   * H3: write a self-contained AI-agent briefing to this path and stop.
   * Zero writes beyond the prompt file itself; no TTY needed; the
   * clean-tree guard is skipped. The agent answers with hexify.plan.yaml.
   */
  emitPrompt?: string;
  /**
   * H3: path to an agent-produced hexify.plan.yaml. Its params become
   * PROPOSALS: with `--dry-run` the run is headless (the agent's verify
   * loop — matched params auto-accepted, nothing written); without it the
   * guided dialogue confirms each param before the round-trip gate.
   */
  plan?: string;
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

/**
 * Hexify's own working files (the H3 handoff loop): untracked copies at
 * the repo root don't dirty the preflight — the rewrite never touches
 * them, so "git is the undo" holds regardless.
 */
const TOLERATED_UNTRACKED = new Set(['hexify-prompt.md', 'hexify.plan.yaml']);

async function defaultGitStatus(dir: string): Promise<{ isRepo: boolean; clean: boolean }> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  } catch {
    return { isRepo: false, clean: false };
  }
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir });
  const blocking = stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .filter((l) => !(l.startsWith('?? ') && TOLERATED_UNTRACKED.has(l.slice(3))));
  return { isRepo: true, clean: blocking.length === 0 };
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
  /** Present on `--plan` runs: provenance + values that matched nothing. */
  planned?: { source: string; accepted: number; unmatched: string[] };
};

/** Reshape a plan + gate result into the report. Pure — no I/O. */
export function buildHexifyReport(
  plan: HexifyPlan,
  roundTrip: RoundTripResult,
  opts: { dryRun: boolean; planned?: HexifyReport['planned'] },
): HexifyReport {
  const templateName = extractManifestName(plan.manifestYaml);
  return {
    ...(opts.planned === undefined ? {} : { planned: opts.planned }),
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
  if (report.planned !== undefined && report.planned.unmatched.length > 0) {
    lines.push(
      brand.dim(
        `  plan values not found (dropped): ${report.planned.unmatched
          .map((v) => `"${v}"`)
          .join(', ')}`,
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

/** How many mined pairs get proposed before the rest are summarised away. */
const MAX_MINED_PROPOSALS = 8;

/** Default prompt-name suggestion for a mined value: `acme-portal` → `acme_portal`. */
function suggestPromptName(value: string, taken: Set<string>): string {
  const base =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^([0-9])/, '_$1') || 'param';
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base}_${n++}`;
  return name;
}

/** The guided parameterisation dialogue. Pure prompter-driven — no I/O. */
async function collectParams(
  prompter: Prompter,
  files: ScannedFile[],
  seeds: PackageSeeds,
  mined: MinedPair[] = [],
  planned: HexifyParam[] = [],
): Promise<HexifyParam[]> {
  const accepted: HexifyParam[] = [];
  const usedValues = new Set<string>();
  const usedNames = new Set<string>();

  // Plan proposals (H3) lead: the agent already chose names and
  // descriptions, so a single confirm per param suffices. Zero-occurrence
  // values are surfaced, never silently dropped.
  for (const p of planned) {
    if (usedValues.has(p.value)) continue;
    const count = countOccurrencesAcross(files, p.value);
    if (count.total === 0) {
      prompter.note?.(`no occurrences of "${p.value}" — skipped (from plan)`);
      continue;
    }
    const yes = await prompter.confirm({
      message: `Parameterise "${p.value}" as {{ ${p.name} }}? (from plan; ${describeCount(count)})`,
      default: true,
    });
    if (!yes) continue;
    accepted.push(p);
    usedValues.add(p.value);
    usedNames.add(p.name);
  }

  for (const candidate of autoCandidates(seeds)) {
    const value = candidate.value.trim();
    if (value.length < MIN_VALUE_LENGTH) continue;
    if (usedNames.has(candidate.name)) {
      prompter.note?.(
        `prompt name ${candidate.name} already taken by the plan — skipping auto candidate "${value}"`,
      );
      continue;
    }
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

  // Mined candidates (H2): evidence from the template↔instance diff,
  // proposed after the package.json seeds so duplicates fall away, and
  // capped — anything beyond the cap is drift-shaped long tail.
  const proposedValues = new Set<string>();
  let proposed = 0;
  for (const pair of mined) {
    if (proposed >= MAX_MINED_PROPOSALS) break;
    const value = pair.templateValue;
    if (usedValues.has(value) || proposedValues.has(value)) continue;
    const count = countOccurrencesAcross(files, value);
    if (count.total === 0) continue;
    proposedValues.add(value);
    proposed++;
    const evidence = `↔ "${pair.instanceValue}" in the instance, ${pair.evidence} differing spot${
      pair.evidence === 1 ? '' : 's'
    }`;
    const yes = await prompter.confirm({
      message: `Parameterise "${value}"? (${evidence}; ${describeCount(count)} here)`,
      default: true,
    });
    if (!yes) continue;
    const name = await prompter.text({
      message: `Prompt name for "${value}"`,
      default: suggestPromptName(value, usedNames),
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
  }
  if (proposed >= MAX_MINED_PROPOSALS && mined.length > proposed) {
    prompter.note?.(
      `${mined.length - proposed} weaker mined pair${
        mined.length - proposed === 1 ? '' : 's'
      } not proposed — add any of them via the custom-parameter loop`,
    );
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
  // Flag sanity — contradictory combinations fail before any repo look.
  if (opts.emitPrompt !== undefined) {
    const clash =
      opts.plan !== undefined
        ? '--plan'
        : opts.json
          ? '--json'
          : opts.dryRun
            ? '--dry-run'
            : undefined;
    if (clash !== undefined) {
      effects.stderr.write(
        `${brand.error(
          `--emit-prompt cannot be combined with ${clash} — it only writes the briefing file`,
        )}\n`,
      );
      effects.setExitCode(1);
      return;
    }
  }

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

  // Plan preflight (H3) — before the git guard, because in headless
  // (--dry-run) runs the plan replaces the dialogue entirely and its
  // errors should fail fast.
  let planFile: HexifyPlanFile | undefined;
  if (opts.plan !== undefined) {
    try {
      planFile = await loadPlanFile(opts.plan);
    } catch (err) {
      if (err instanceof PlanFileError) {
        effects.stderr.write(`${brand.error(err.message)}\n`);
        effects.setExitCode(1);
        return;
      }
      throw err;
    }
  }

  // Guard 3 — git preflight. Hexify rewrites files in place; git is the
  // review-and-undo story, so a repo and a clean tree are non-negotiable.
  // The emit path rewrites nothing and is exempt (its output file is
  // tolerated untracked anyway).
  if (opts.emitPrompt === undefined) {
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
  }

  // Guard 4 — `--against` must point at an existing directory.
  if (opts.against !== undefined) {
    let isDir = false;
    try {
      isDir = (await stat(opts.against)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      effects.stderr.write(
        `${brand.error(`--against path is not a directory: ${opts.against}`)}\n`,
      );
      effects.setExitCode(1);
      return;
    }
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

  // H2 — mine candidate pairs from the template↔instance diff. The
  // instance walk gets the same ignore patterns, so node_modules and
  // friends never produce pairs. Hoisted above the dialogue: the emit
  // path and headless plan runs need the pairs with no prompter at all.
  let mined: MinedPair[] = [];
  if (opts.against !== undefined) {
    const instanceFiles = await scanRepo(opts.against, ignorePatterns);
    mined = mineCandidatePairs(files, instanceFiles);
  }

  // Emit path (H3) — write the agent briefing and stop. No TTY, no
  // shadow dir, nothing else touched.
  if (opts.emitPrompt !== undefined) {
    const emitPath = resolve(repoRoot, opts.emitPrompt);
    const prompt = buildAgentPrompt({
      templateRoot: resolve(repoRoot),
      againstRoot: opts.against === undefined ? undefined : resolve(opts.against),
      seeds,
      files,
      ignorePatterns,
      mined,
    });
    await writeFileAtomic(emitPath, prompt);
    effects.stdout.write(
      `wrote ${opts.emitPrompt} — hand it to an AI agent; it should answer with hexify.plan.yaml (then: hex hexify --plan hexify.plan.yaml)\n`,
    );
    return;
  }

  const planParams = planFile?.params ?? [];
  const planValues = new Set(planParams.map((p) => p.value));
  const unmatched = planParams
    .filter((p) => countOccurrencesAcross(files, p.value).total === 0)
    .map((p) => p.value);

  // Headless plan mode (H3): `--plan --dry-run` is the agent's verify
  // loop — matched plan params auto-accepted, no prompter, and dry-run
  // guarantees nothing is written. The write path is always interactive.
  const headless = planFile !== undefined && (opts.dryRun ?? false);

  let templateName: string;
  let kind: string;
  let params: HexifyParam[];
  let prompter: Prompter | undefined;

  if (headless) {
    templateName = planFile?.template?.name ?? seeds.name ?? basename(repoRoot);
    kind = planFile?.template?.kind ?? '';
    params = planParams.filter((p) => !unmatched.includes(p.value));
  } else {
    // Guided dialogue — before any temp dir exists, so a cancel needs no
    // cleanup. PromptCancelledError propagates for the top-level 130.
    prompter = effects.prompterFactory(true);
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

    templateName = await prompter.text({
      message: 'Template name',
      default: planFile?.template?.name ?? seeds.name ?? basename(repoRoot),
      validate: (v) => (v.trim().length === 0 ? 'a template needs a name' : undefined),
    });
    kind = await prompter.text({
      message: 'Component kind (e.g. webapp, lib — blank to omit)',
      default: planFile?.template?.kind ?? '',
    });

    if (opts.against !== undefined && mined.length === 0) {
      prompter.note?.(
        'no candidate pairs mined from the instance — the trees are identical or differ only by drift',
      );
    }

    params = await collectParams(prompter, files, seeds, mined, planParams);

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
  }

  const planned: HexifyReport['planned'] =
    planFile === undefined
      ? undefined
      : {
          source: opts.plan ?? '',
          accepted: params.filter((p) => planValues.has(p.value)).length,
          unmatched,
        };

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

  if (!opts.dryRun && prompter !== undefined) {
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
        buildHexifyReport(plan, roundTrip, { dryRun: opts.dryRun ?? false, planned }),
        opts,
      );
      effects.stderr.write(
        `${brand.error('round-trip proof failed — the repo was not touched')}\n`,
      );
      effects.setExitCode(1);
      return;
    }

    if (opts.dryRun) {
      emitReport(effects, buildHexifyReport(plan, roundTrip, { dryRun: true, planned }), opts);
      return;
    }

    await applyPlan(repoRoot, plan);

    // Reload proof: the repo must now load exactly as every future
    // consumer (`hex new`, `hex adopt`) will load it.
    await loadFromPath(repoRoot, 'file');

    emitReport(effects, buildHexifyReport(plan, roundTrip, { dryRun: false, planned }), opts);
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
    .option(
      '--against <instance>',
      'path to a known instance of this template — its diff is mined for parameter candidates (best at an early ref of the instance)',
    )
    .option(
      '--emit-prompt [file]',
      'write a self-contained AI-agent briefing (default hexify-prompt.md) and stop — the agent answers with hexify.plan.yaml',
    )
    .option(
      '--plan <file>',
      'agent-produced hexify.plan.yaml — its params become proposals; with --dry-run the run is headless (the agent verify loop)',
    )
    .action(
      async (opts: {
        dryRun: boolean;
        json: boolean;
        against?: string;
        emitPrompt?: string | boolean;
        plan?: string;
      }) => {
        const emitPrompt =
          opts.emitPrompt === true
            ? 'hexify-prompt.md'
            : opts.emitPrompt === false
              ? undefined
              : opts.emitPrompt;
        // `--json` stdout must stay parseable, and the emit path is a
        // one-line file writer — no splash, no clack chrome, for both.
        if (!opts.json && emitPrompt === undefined) {
          process.stdout.write(`${splash()}\n`);
          clack.intro(brand.honeyBold(' hex hexify '));
        }
        await runHexifyCommand(process.cwd(), defaultHexifyCommandEffects, {
          dryRun: opts.dryRun,
          json: opts.json,
          against: opts.against,
          emitPrompt,
          plan: opts.plan,
        });
      },
    );
}
