import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { type HookResult, runPostRenderHooks } from '../hooks/declarative.js';
import type { Answers } from '../prompts/types.js';
import type { ComponentBundle } from '../sources/file-source.js';
import { shouldInclude } from './include-rules.js';
import { renderText } from './templating.js';
import { walkTemplate } from './walk.js';

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

export type RenderOptions = {
  /** Overwrite a non-empty existing output directory. */
  force?: boolean;
};

const BINARY_SAMPLE_BYTES = 8192;

function looksBinary(buf: Buffer): boolean {
  const end = Math.min(BINARY_SAMPLE_BYTES, buf.length);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function ensureWriteableTarget(outputPath: string, force: boolean): Promise<void> {
  try {
    const s = await stat(outputPath);
    if (!s.isDirectory()) {
      throw new RenderError(`output path exists and is not a directory: ${outputPath}`);
    }
    const entries = await readdir(outputPath);
    if (entries.length > 0 && !force) {
      throw new RenderError(
        `output directory is non-empty: ${outputPath} (pass --force to overwrite)`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (err instanceof RenderError) throw err;
    throw new RenderError(
      `cannot inspect output directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function safeJoin(outputPath: string, rendered: string): string {
  // Normalise away any rendered '..' / leading '/' so authors can't
  // escape the output directory through templated paths.
  const target = resolve(outputPath, rendered);
  const root = resolve(outputPath) + sep;
  if (!target.startsWith(root) && target !== resolve(outputPath)) {
    throw new RenderError(`rendered path escapes the output directory: ${rendered}`);
  }
  return target;
}

/**
 * Render a component bundle into an output directory, given the user's
 * answers. The bundle's `.hex/` is skipped, `.hexignore` is honoured, and
 * each remaining file's path + contents are rendered through Nunjucks
 * (binary files are copied verbatim).
 *
 * If a rendered path comes out empty (e.g. all path segments were guarded
 * by `{% if %}` blocks), the file is skipped. The recommended way to
 * conditionally emit a whole file is the manifest's `include:` rules,
 * not `{% if %}` wrapping a filename.
 */
export type RenderResult = {
  written: string[];
} & HookResult;

export async function renderBundle(
  bundle: ComponentBundle,
  outputPath: string,
  answers: Answers,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  const absOut = isAbsolute(outputPath) ? outputPath : resolve(process.cwd(), outputPath);
  await ensureWriteableTarget(absOut, opts.force ?? false);

  const includeRules = bundle.manifest.include ?? [];
  const written: string[] = [];

  for await (const file of walkTemplate(bundle.rootPath)) {
    if (!shouldInclude(file.relativePath, includeRules, answers)) continue;

    const renderedRel = renderText(file.relativePath, answers).trim();
    if (renderedRel.length === 0) continue;

    const targetPath = safeJoin(absOut, renderedRel);
    const data = await readFile(file.absolutePath);

    await mkdir(dirname(targetPath), { recursive: true });

    if (looksBinary(data)) {
      await writeFile(targetPath, data);
    } else {
      const rendered = renderText(data.toString('utf8'), answers);
      await writeFile(targetPath, rendered, 'utf8');
    }

    written.push(renderedRel);
  }

  const hooks = bundle.manifest.hooks?.post_render ?? [];
  const hookResult = await runPostRenderHooks(absOut, hooks, answers, written, {
    force: opts.force ?? false,
  });

  return { written, ...hookResult };
}
