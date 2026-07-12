import type { Command } from 'commander';
import { brand } from '../brand/colors.js';
import { sym } from '../brand/glyphs.js';
import { loadFromPath } from '../core/sources/file-source.js';
import { type LintCheck, lintStubComponent } from '../core/stub/lint.js';

const MARK: Record<LintCheck['status'], string> = {
  pass: brand.done(sym.ok()),
  fail: brand.error(sym.err()),
  skip: brand.dim('–'),
};

/**
 * `hex lint <path>` — check a component template against the
 * stub-mode prod-clean conventions (M8.5). Exits non-zero if any check
 * fails so the command is usable as a marketplace / CI gate.
 */
export function registerLint(program: Command): void {
  program
    .command('lint')
    .description('check a stubbable component against the prod-clean conventions')
    .argument('<path>', 'path to the component template directory')
    .action(async (path: string) => {
      const bundle = await loadFromPath(path);

      if (bundle.manifest.type !== 'component') {
        console.log(
          brand.dim(
            `${bundle.manifest.name} is a ${bundle.manifest.type} — stub lint applies to components only.`,
          ),
        );
        return;
      }

      const report = await lintStubComponent(bundle);

      if (!report.stubbable) {
        console.log(
          brand.dim(
            `${bundle.manifest.name} declares no \`stub:\` block — real-only, nothing to lint.`,
          ),
        );
        return;
      }

      console.log(
        `${brand.bold(bundle.manifest.name)} ${brand.dim(`— stub engine: ${report.engine}`)}`,
      );
      for (const check of report.checks) {
        console.log(`  ${MARK[check.status]} ${brand.dim(check.id)}  ${check.message}`);
      }

      if (report.ok) {
        console.log(brand.done(`\nstubs prod-clean: ${sym.ok()}`));
      } else {
        console.log(brand.error(`\nstubs prod-clean: ${sym.err()} — fix the failing checks above`));
        process.exitCode = 1;
      }
    });
}
