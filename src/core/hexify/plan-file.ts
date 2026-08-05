import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type HexifyParam, MIN_VALUE_LENGTH, PROMPT_NAME_RE } from './substitute.js';

/**
 * `hexify --plan <file>` parsing (Hex 2.0 / H3). A plan file is the
 * agent half of the AI handoff: hex emits a prompt (`--emit-prompt`),
 * an external agent answers with this YAML, and hex treats its params
 * as PROPOSALS — occurrence-counted, human-confirmed on the write path,
 * and always behind the round-trip gate. Hex itself never talks to an
 * AI; this file is just data.
 *
 * Kept pure + separate from the filesystem read, answers-file style.
 */
export class PlanFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanFileError';
  }
}

export type HexifyPlanFile = {
  /** Optional template identity — becomes the name/kind prompt defaults. */
  template?: { name?: string; kind?: string };
  /** Proposed parameters, description defaulted to the prompt name. */
  params: HexifyParam[];
};

const planSchema = z
  .object({
    template: z
      .object({
        name: z.string().min(1).optional(),
        kind: z.string().optional(),
      })
      .strict()
      .optional(),
    params: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(PROMPT_NAME_RE, 'lower_snake_case identifiers only (^[a-z_][a-z0-9_]*$)'),
            value: z
              .string()
              .min(
                MIN_VALUE_LENGTH,
                `use at least ${MIN_VALUE_LENGTH} characters — short values over-match`,
              ),
            description: z.string().optional(),
          })
          .strict(),
      )
      .min(1, 'list at least one parameter'),
  })
  .strict();

/** Parse plan-file text. Throws {@link PlanFileError} on bad YAML, shape, or duplicates. */
export function parsePlanFile(text: string): HexifyPlanFile {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new PlanFileError(`invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw new PlanFileError('plan file must be a mapping with a `params:` list');
  }
  const result = planSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new PlanFileError(`schema validation failed:\n${issues}`);
  }
  const seenNames = new Set<string>();
  const seenValues = new Set<string>();
  const params: HexifyParam[] = result.data.params.map((p) => {
    const value = p.value.trim();
    if (value.length < MIN_VALUE_LENGTH) {
      throw new PlanFileError(
        `param "${p.name}": use at least ${MIN_VALUE_LENGTH} characters — short values over-match`,
      );
    }
    if (seenNames.has(p.name)) throw new PlanFileError(`duplicate param name: ${p.name}`);
    if (seenValues.has(value)) throw new PlanFileError(`duplicate param value: "${value}"`);
    seenNames.add(p.name);
    seenValues.add(value);
    return { name: p.name, value, description: p.description ?? p.name.replace(/_/g, ' ') };
  });
  return { template: result.data.template, params };
}

/** Read + parse a plan file. Surfaces a clear error if missing/unreadable. */
export async function loadPlanFile(path: string): Promise<HexifyPlanFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new PlanFileError(
      `cannot read plan file "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return parsePlanFile(text);
  } catch (err) {
    if (err instanceof PlanFileError) {
      throw new PlanFileError(`${path}: ${err.message}`);
    }
    throw err;
  }
}
