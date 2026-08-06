import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as clack from '@clack/prompts';
import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import { sym } from '../brand/glyphs.js';
import { splash } from '../brand/splash.js';
import {
  ProvenanceError,
  materialiseRef,
  resolveProvenanceRef,
  splitEdited,
} from '../core/adopt/provenance.js';
import {
  type LockFileEntry,
  type Lockfile,
  type LockfileIntegrity,
  buildLockfile,
  checkLockfileIntegrity,
  hashTree,
  readLockfileUpward,
  writeLockfile,
} from '../core/lockfile/index.js';
import { AnswersFileError, loadAnswersFile } from '../core/prompts/answers-file.js';
import { createClackPrompter } from '../core/prompts/clack-prompter.js';
import { PromptError, runPrompts } from '../core/prompts/engine.js';
import { createNonInteractivePrompter } from '../core/prompts/non-interactive-prompter.js';
import type { Answers, Prompter } from '../core/prompts/types.js';
import { renderBundle } from '../core/render/engine.js';
import type { ComponentBundle } from '../core/sources/file-source.js';
import { captureBaseline } from '../core/upgrade/baseline.js';
import { readPackageSeeds, seedDefaults } from '../core/util/package-seeds.js';
import { NewCommandError, resolveTemplate } from './new.js';

/**
 * `hex adopt` (Hex 2.0 / A2). Retrospectively links an EXISTING project —
 * one that was never scaffolded by Hex — to a template, so `hex doctor`
 * and `hex upgrade` work from then on.
 *
 * The trick: adoption manufactures exactly the state a scaffolded-then-
 * edited app would be in. The template is rendered into a throwaway
 * SHADOW directory (never the project), that tree becomes
 * `.hex/pristine/`, and the lockfile's file-hash table is built from the
 * shadow — so every hash records what the template says, and the
 * project's own divergence surfaces as ordinary integrity drift.
 *
 * The contract (the part a change-advisory board cares about): adopt
 * writes `.hex/` ONLY. Nothing else in the tree is created, modified,
 * or deleted, and `rm -rf .hex` reverses the whole thing. `--dry-run`
 * writes nothing at all.
 */

export type AdoptCommandOptions = {
  dryRun?: boolean;
  json?: boolean;
  /** Path to a YAML answers file — implies fully non-interactive prompts. */
  answers?: string;
  trustLocal?: boolean;
  /**
   * Replace an existing adoption without asking (A5). Interactive runs
   * get a y/N question instead; answers-mode runs REQUIRE this flag to
   * re-adopt.
   */
  readopt?: boolean;
  /**
   * A7: enrich the fit report by materialising the instance's own git
   * tree at this ref (bare flag = the root commit) and splitting
   * "edited" into edited-by-you / stale / collided. ADVISORY and
   * report-only — never changes what adopt writes; failures warn and
   * continue without the split.
   */
  provenance?: string | true;
};

export type AdoptCommandEffects = {
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  setExitCode: (code: number) => void;
  /** `interactive` is false when `--answers` was given. */
  prompterFactory: (interactive: boolean) => Prompter;
  /**
   * Indirection over `hex new`'s resolveTemplate so tests can script a
   * bundle without touching discovery, catalogues, or clack.
   */
  resolveTemplate: (arg: string | undefined) => Promise<ComponentBundle>;
  /**
   * Shadow-dir factory. A seam (rather than a bare mkdtemp call) so the
   * cleanup guarantee is assertable in tests.
   */
  makeShadowDir: () => Promise<string>;
  /**
   * A7 seam: resolve `ref` (undefined = root commit) in the project's
   * git history and materialise its tree into `<destDir>/tree`. The
   * default shells out to git; tests inject fakes. Throws
   * {@link ProvenanceError} on any git failure.
   */
  materialiseProvenance: (
    projectRoot: string,
    ref: string | undefined,
    destDir: string,
  ) => Promise<{ ref: string; sha: string }>;
};

export const defaultAdoptCommandEffects: AdoptCommandEffects = {
  stdout: process.stdout,
  stderr: process.stderr,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  prompterFactory: (interactive) =>
    interactive ? createClackPrompter() : createNonInteractivePrompter(),
  resolveTemplate,
  makeShadowDir: () => mkdtemp(join(tmpdir(), 'hex-adopt-')),
  materialiseProvenance: async (projectRoot, ref, destDir) => {
    const resolved = await resolveProvenanceRef(projectRoot, ref);
    await materialiseRef(projectRoot, resolved.sha, destDir);
    return resolved;
  },
};

/** How many paths a fit-report group lists before truncating. */
const MAX_LISTED = 10;

export type AdoptFitReport = {
  template: { name: string; version: string; type: 'component' };
  /** Files the lockfile records — i.e. what the template renders. */
  recorded: number;
  /** Recorded files whose project bytes match the template exactly. */
  clean: string[];
  /** Recorded files present in the project but with differing bytes. */
  edited: string[];
  /** Recorded files absent from the project. */
  missing: string[];
  /** Project files the template does not render. */
  untracked: string[];
  /** round(100 * clean / recorded). */
  fitPercent: number;
  dryRun: boolean;
  /**
   * A7 enrichment (only on `--provenance` runs): `edited` split by the
   * instance's early-ref tree. The three lists partition `edited`;
   * fitPercent is unaffected.
   */
  provenance?: {
    ref: string;
    sha: string;
    editedByYou: string[];
    stale: string[];
    collided: string[];
  };
};

/**
 * Reshape a lockfile-integrity result into the adoption fit report.
 * Pure — the FS work happened in `checkLockfileIntegrity`.
 */
export function buildAdoptReport(
  lockfile: Lockfile,
  integrity: LockfileIntegrity,
  opts: { dryRun: boolean },
  provenance?: AdoptFitReport['provenance'],
): AdoptFitReport {
  const notClean = new Set([...integrity.modified, ...integrity.missing]);
  const clean = lockfile.files.map((f) => f.path).filter((p) => !notClean.has(p));
  clean.sort();
  const recorded = lockfile.files.length;
  return {
    template: {
      name: lockfile.root.name,
      version: lockfile.root.version,
      type: 'component',
    },
    recorded,
    clean,
    edited: [...integrity.modified].sort(),
    missing: [...integrity.missing].sort(),
    untracked: [...integrity.added].sort(),
    fitPercent: recorded === 0 ? 0 : Math.round((100 * clean.length) / recorded),
    dryRun: opts.dryRun,
    ...(provenance === undefined ? {} : { provenance }),
  };
}

function listGroup(title: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const lines = [`${title} (${paths.length}):`];
  for (const p of paths.slice(0, MAX_LISTED)) lines.push(brand.dim(`  ${p}`));
  if (paths.length > MAX_LISTED) lines.push(brand.dim(`  … and ${paths.length - MAX_LISTED} more`));
  return lines;
}

/** Pure text rendering of a fit report (the `--json` path bypasses this). */
export function formatAdoptText(report: AdoptFitReport): string {
  const { template } = report;
  const fit = `fit ${report.fitPercent}% (${report.clean.length}/${report.recorded} files clean)`;
  const lines: string[] = [];
  if (report.dryRun) {
    lines.push(`Fit preview for ${brand.bold(`${template.name}@${template.version}`)} — ${fit}`);
    lines.push(brand.dim('--dry-run: nothing written.'));
  } else {
    lines.push(
      `${sym.ok()} Adopted ${brand.bold(`${template.name}@${template.version}`)} — ${fit}`,
    );
  }
  if (report.provenance !== undefined) {
    const p = report.provenance;
    lines.push(...listGroup('edited by you (preserved by hex upgrade)', p.editedByYou));
    lines.push(...listGroup('stale (template moved on; upgrade refreshes these)', p.stale));
    lines.push(...listGroup('collided (both changed; will conflict on upgrade)', p.collided));
    lines.push(brand.dim(`provenance baseline: ${p.ref} @ ${p.sha.slice(0, 8)}`));
  } else {
    lines.push(...listGroup('edited (yours; preserved by hex upgrade)', report.edited));
  }
  lines.push(...listGroup('missing (rendered by the template, absent here)', report.missing));
  lines.push(...listGroup('untracked (yours alone; ignored by hex upgrade)', report.untracked));
  if (!report.dryRun) {
    lines.push(brand.dim('inspect any time with hex doctor — reversible with: rm -rf .hex'));
  }
  return lines.join('\n');
}

function emitReport(
  effects: AdoptCommandEffects,
  report: AdoptFitReport,
  opts: AdoptCommandOptions,
): void {
  if (opts.json) {
    effects.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  effects.stdout.write(`${formatAdoptText(report)}\n`);
}

export async function runAdoptCommand(
  projectRoot: string,
  templateArg: string | undefined,
  effects: AdoptCommandEffects,
  opts: AdoptCommandOptions = {},
): Promise<void> {
  // Guard 1 — `--answers` preflight (mirrors `hex new`). Runs first
  // because it decides whether the session is interactive, which the
  // re-adopt question below depends on.
  let supplied: Answers | undefined;
  if (opts.answers !== undefined) {
    if (!templateArg) {
      effects.stderr.write(
        `${brand.error('--answers requires a template argument — the interactive picker is unavailable in answers mode')}\n`,
      );
      effects.setExitCode(1);
      return;
    }
    try {
      supplied = await loadAnswersFile(opts.answers);
    } catch (err) {
      if (err instanceof AnswersFileError) {
        effects.stderr.write(`${brand.error(err.message)}\n`);
        effects.setExitCode(1);
        return;
      }
      throw err;
    }
  }

  const prompter = effects.prompterFactory(supplied === undefined);

  // Guard 2 — already a hex app? Nested subdirectories hard-refuse; the
  // app root itself gets the A5 re-adopt path: a y/N question when
  // interactive, `--readopt` when in answers mode. Confirming replaces
  // the previous adoption wholesale (fresh pristine + lockfile — the
  // merge base resets).
  let existing: Awaited<ReturnType<typeof readLockfileUpward>>;
  try {
    existing = await readLockfileUpward(projectRoot);
  } catch (err) {
    effects.stderr.write(
      `${brand.error(
        `found a .hex/lockfile.yaml but it is unreadable: ${
          err instanceof Error ? err.message : String(err)
        } — fix or remove it before adopting`,
      )}\n`,
    );
    effects.setExitCode(1);
    return;
  }
  if (existing) {
    const label = `${existing.lockfile.root.name}@${existing.lockfile.root.version}`;
    if (resolve(existing.rootDir) !== resolve(projectRoot)) {
      effects.stderr.write(
        `${brand.error(
          `this directory is inside a hex app (lockfile in ${existing.rootDir}) — run hex adopt from the app root`,
        )}\n`,
      );
      effects.setExitCode(1);
      return;
    }
    if (opts.readopt) {
      effects.stderr.write(`${brand.dim(`re-adopting over ${label} — the merge base resets`)}\n`);
    } else if (supplied !== undefined) {
      effects.stderr.write(
        `${brand.error(
          `already adopted (${label}) — pass --readopt to replace the existing adoption in answers mode`,
        )}\n`,
      );
      effects.setExitCode(1);
      return;
    } else {
      const yes = await prompter.confirm({
        message: `Already adopted (${label}) — re-adopt and replace the existing adoption? The merge base resets.`,
        default: false,
      });
      if (!yes) {
        effects.stdout.write('re-adopt declined — nothing changed\n');
        return;
      }
    }
  }

  // Resolve the template — same path / hive / catalogue semantics as
  // `hex new`, including the interactive picker when no arg is given.
  // PromptCancelledError propagates for the top-level 130 mapping.
  let bundle: ComponentBundle;
  try {
    bundle = await effects.resolveTemplate(templateArg);
  } catch (err) {
    if (err instanceof NewCommandError) {
      effects.stderr.write(`${brand.error(err.message)}\n`);
      effects.setExitCode(1);
      return;
    }
    throw err;
  }

  // Guard 3 — V1 is component-only.
  if (bundle.manifest.type === 'recipe') {
    effects.stderr.write(
      `${brand.error(
        `"${bundle.manifest.name}" is a recipe — recipes are not yet supported by hex adopt (component templates only)`,
      )}\n`,
    );
    effects.setExitCode(1);
    return;
  }

  // Prompts — before any temp dir exists, so a cancel needs no cleanup.
  // A3: interactive runs prefill widget defaults from the project's own
  // package.json (the values a hand-copied instance carries in-band) —
  // the user still confirms every one. Answers mode gets no defaults:
  // headless answers must come only from the file.
  const bootstrap = supplied === undefined ? seedDefaults(await readPackageSeeds(projectRoot)) : {};
  let answers: Answers;
  try {
    answers = await runPrompts(
      bundle.manifest.prompts ?? [],
      prompter,
      {},
      bundle.manifest.sections,
      supplied,
      bootstrap,
    );
  } catch (err) {
    if (err instanceof PromptError) {
      effects.stderr.write(`${brand.error(err.message)}\n`);
      effects.setExitCode(1);
      return;
    }
    throw err;
  }

  // Shadow phase — the only span that owns disk state needing cleanup.
  const shadowDir = await effects.makeShadowDir();
  try {
    await renderBundle(bundle, shadowDir, answers, {
      force: false,
      prompter,
      trustLocal: opts.trustLocal,
    });

    // The lockfile is built FROM THE SHADOW: its file-hash table records
    // what the template renders, so the project's divergence shows up as
    // ordinary integrity drift. (A template that somehow emitted `.hex/`
    // output is harmless: hashTree and copyTreeInto both skip it.)
    const lockfile = await buildLockfile({ bundle, answers, outputDir: shadowDir });

    // Guard 4 — zero-file render, checked on the lockfile table (the
    // post-hooks truth; a hook could have deleted everything).
    if (lockfile.files.length === 0) {
      effects.stderr.write(
        `${brand.error('template rendered zero files — nothing to adopt against')}\n`,
      );
      effects.setExitCode(1);
      return;
    }

    // The fit comparison, once for both paths (hashTree skips .hex, so
    // the write below cannot change it).
    const integrity = await checkLockfileIntegrity(projectRoot, lockfile);

    // A7 — provenance enrichment. Advisory and report-only: any git
    // failure warns and the report simply ships without the split.
    let provenance: AdoptFitReport['provenance'];
    if (opts.provenance !== undefined) {
      const requestedRef = opts.provenance === true ? undefined : opts.provenance;
      const provDir = await effects.makeShadowDir();
      try {
        const resolved = await effects.materialiseProvenance(projectRoot, requestedRef, provDir);
        const toMap = (entries: LockFileEntry[]): Map<string, string> =>
          new Map(entries.map((e) => [e.path, e.sha256]));
        const split = splitEdited(
          integrity.modified,
          toMap(await hashTree(join(provDir, 'tree'))),
          toMap(await hashTree(projectRoot)),
          toMap(lockfile.files),
        );
        provenance = { ref: resolved.ref, sha: resolved.sha, ...split };
      } catch (err) {
        if (err instanceof ProvenanceError) {
          effects.stderr.write(
            `${brand.dim(`provenance: ${err.message} — continuing without the split`)}\n`,
          );
        } else {
          throw err;
        }
      } finally {
        await rm(provDir, { recursive: true, force: true });
      }
    }

    if (opts.dryRun) {
      // Read-only comparison; the project is never written.
      emitReport(
        effects,
        buildAdoptReport(lockfile, integrity, { dryRun: true }, provenance),
        opts,
      );
      return;
    }

    // `.hex/pristine/` first, then the lockfile. If the second write
    // fails, readLockfileUpward still returns null, so re-running adopt
    // recovers (captureBaseline clears the stale pristine), and
    // `rm -rf .hex` reverses everything either way.
    await captureBaseline(projectRoot, shadowDir);
    await writeLockfile(projectRoot, lockfile);

    emitReport(effects, buildAdoptReport(lockfile, integrity, { dryRun: false }, provenance), opts);
    // Low fit is information, not failure — exit 0, like doctor.
  } finally {
    await rm(shadowDir, { recursive: true, force: true });
  }
}

export function registerAdopt(program: Command): void {
  program
    .command('adopt')
    .description('link an existing project to a template — writes .hex/ only, reversible')
    .argument('[template]', 'template path or registered name (omit to pick interactively)')
    .option('--dry-run', 'render + compare and print the fit report; write nothing', false)
    .option('--json', 'emit the fit report as machine-readable JSON', false)
    .option(
      '--answers <file>',
      'answer prompts non-interactively from a YAML file (for scripted adoption)',
    )
    .option(
      '--trust-local',
      'run JS hooks unsandboxed for local FileSource templates (dev workflow; ignored for git/marketplace sources)',
      false,
    )
    .option(
      '--readopt',
      'replace an existing adoption without asking (required to re-adopt with --answers)',
      false,
    )
    .option(
      '--provenance [ref]',
      "split the fit report's edited group into edited-by-you / stale / collided using the project's git history (default ref: the root commit); report-only",
    )
    .action(
      async (
        templateArg: string | undefined,
        opts: {
          dryRun: boolean;
          json: boolean;
          answers?: string;
          trustLocal: boolean;
          readopt: boolean;
          provenance?: string | boolean;
        },
      ) => {
        // `--json` stdout must stay parseable — no splash, no clack chrome.
        if (!opts.json) {
          process.stdout.write(`${splash()}\n`);
          clack.intro(brand.honeyBold(' hex adopt '));
        }
        await runAdoptCommand(process.cwd(), templateArg, defaultAdoptCommandEffects, {
          dryRun: opts.dryRun,
          json: opts.json,
          answers: opts.answers,
          trustLocal: opts.trustLocal,
          readopt: opts.readopt,
          provenance:
            opts.provenance === true
              ? true
              : opts.provenance === false
                ? undefined
                : opts.provenance,
        });
      },
    );
}
