import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { Answers } from './types.js';

/**
 * `--answers <file>` parsing (M15.17). An answers file is a YAML (or JSON)
 * mapping of prompt name → value. Recipe-child answers nest under the slot
 * key; hook-prompt answers are out of scope for this slice. Kept pure +
 * separate from the filesystem read so it's unit-testable.
 */
export class AnswersFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswersFileError';
  }
}

/** Parse answers-file text into an answers map. Throws {@link AnswersFileError} on bad shape. */
export function parseAnswersFile(text: string): Answers {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new AnswersFileError(`invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (data === null || data === undefined) {
    // An empty file is a valid "no answers supplied" map — every prompt then
    // falls back to its default (or fails loudly if required without one).
    return {};
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new AnswersFileError('answers file must be a mapping of prompt name to value');
  }
  return data as Answers;
}

/** Read + parse an answers file. Surfaces a clear error if the file is missing/unreadable. */
export async function loadAnswersFile(path: string): Promise<Answers> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new AnswersFileError(
      `cannot read answers file "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseAnswersFile(text);
}
