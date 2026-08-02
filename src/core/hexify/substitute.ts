import { escapeNunjucks } from './escape.js';

/**
 * The parameterisation engine (Hex 2.0 / H1): turn confirmed
 * value→prompt-name pairs into `{{ name }}` placeholders across file
 * contents and paths, with the escape pass fused into the same
 * left-to-right scan so literal text is neutralised exactly once and
 * inserted placeholders are never escaped.
 *
 * This module is deliberately command-agnostic — extract-from-projects
 * (V2 of the epic) inherits it unchanged.
 */

export type HexifyParam = {
  /** Nunjucks identifier the placeholder renders, e.g. `project_name`. */
  name: string;
  /** The original concrete value — also the prompt default, also the round-trip answer. */
  value: string;
  /** Human label for the generated prompt. */
  description: string;
};

/**
 * Values made only of word-ish characters get boundary protection:
 * `acme-portal` must not match inside `acme-portal-web` or `xacme-portal`.
 * Values containing anything else (spaces, punctuation) are distinctive
 * enough to match as plain substrings.
 */
const WORDISH_VALUE_RE = /^[A-Za-z0-9_.-]+$/;
const BOUNDARY_CHAR_RE = /[A-Za-z0-9_-]/;

function matchesAt(text: string, index: number, value: string, wordish: boolean): boolean {
  if (!text.startsWith(value, index)) return false;
  if (!wordish) return true;
  const before = index > 0 ? text[index - 1] : '';
  const after = text[index + value.length] ?? '';
  if (before && BOUNDARY_CHAR_RE.test(before)) return false;
  if (after && BOUNDARY_CHAR_RE.test(after)) return false;
  return true;
}

/**
 * Boundary-aware occurrence count for one value — the number
 * `substituteText` would replace if this were the only param. Used by
 * the guided flow to show "N occurrences" before the user confirms.
 */
export function countValueOccurrences(text: string, value: string): number {
  if (value.length === 0) return 0;
  const wordish = WORDISH_VALUE_RE.test(value);
  let count = 0;
  let i = 0;
  while (i < text.length) {
    if (matchesAt(text, i, value, wordish)) {
      count++;
      i += value.length;
    } else {
      i++;
    }
  }
  return count;
}

export type SubstitutionResult = {
  out: string;
  /** Replacements made per param name (params with zero hits included). */
  hits: Map<string, number>;
};

/**
 * One left-to-right pass over `text`: at each position the params are
 * tried longest-value-first (so `acme-portal` wins over `acme` on
 * overlap); a boundary-checked match emits `{{ name }}`; everything
 * else accumulates as literal text and is escaped via `escapeNunjucks`
 * at flush time.
 *
 * One fusion guard: a literal `{` immediately before an inserted
 * placeholder would combine into `{{{ name }}` — that trailing `{` is
 * escaped to `{{ '{' }}` on flush.
 *
 * Invariant: rendering `out` with `{ [name]: value }` for every param
 * reproduces `text` byte-for-byte.
 */
export function substituteText(text: string, params: HexifyParam[]): SubstitutionResult {
  const sorted = [...params].sort((a, b) => b.value.length - a.value.length);
  const hits = new Map(params.map((p) => [p.name, 0]));

  let out = '';
  let literal = '';
  const flush = (beforePlaceholder: boolean): void => {
    let escaped = escapeNunjucks(literal);
    if (beforePlaceholder && escaped.endsWith('{')) {
      escaped = `${escaped.slice(0, -1)}{{ '{' }}`;
    }
    out += escaped;
    literal = '';
  };

  let i = 0;
  while (i < text.length) {
    let matched: HexifyParam | undefined;
    for (const p of sorted) {
      if (p.value.length > 0 && matchesAt(text, i, p.value, WORDISH_VALUE_RE.test(p.value))) {
        matched = p;
        break;
      }
    }
    if (matched) {
      flush(true);
      out += `{{ ${matched.name} }}`;
      hits.set(matched.name, (hits.get(matched.name) ?? 0) + 1);
      i += matched.value.length;
    } else {
      literal += text[i];
      i++;
    }
  }
  flush(false);
  return { out, hits };
}

/**
 * Path parameterisation is the same substitution applied to the POSIX
 * relative path — the render engine passes every path through Nunjucks,
 * so a template file named `src/{{ project_name }}.config.ts` renders
 * natively. (Rename hooks are NOT usable here: their from/to are
 * literal, never rendered.) `/` already acts as a boundary because it
 * is not a word-ish neighbour character.
 */
export function substitutePath(relPath: string, params: HexifyParam[]): SubstitutionResult {
  return substituteText(relPath, params);
}
