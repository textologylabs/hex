import { detectCapabilities } from '../util/tty.js';

export interface Glyphs {
  filled: string;
  empty: string;
  error: string;
  /** Status symbols surfaced across command output (doctor / lint / hive / …). */
  ok: string;
  warn: string;
}

const UNICODE: Glyphs = {
  filled: '⬢',
  empty: '⬡',
  error: '✗',
  ok: '✓',
  warn: '⚠',
};

const ASCII: Glyphs = {
  filled: '[#]',
  empty: '[ ]',
  error: '[x]',
  ok: '[OK]',
  warn: '[!]',
};

export function getGlyphs(unicode = detectCapabilities().unicode): Glyphs {
  return unicode ? UNICODE : ASCII;
}

export const cell = {
  done: () => getGlyphs().filled,
  pending: () => getGlyphs().empty,
  error: () => getGlyphs().error,
};

/**
 * Capability-aware status symbols. Every command that prints a `✓` / `⚠` /
 * `✗` must go through these rather than a hardcoded literal, so
 * `HEX_FORCE_ASCII` (and terminal cap detection) actually degrades them on a
 * terminal that can't render unicode. Re-detects per call, so an env change is
 * honoured without a restart. The `check` variant is a single glyph for
 * bracketed checkboxes (`[✓]` / `[x]`) where the wide `[OK]` would nest badly.
 */
export const sym = {
  ok: () => getGlyphs().ok,
  warn: () => getGlyphs().warn,
  err: () => getGlyphs().error,
  check: (unicode = detectCapabilities().unicode) => (unicode ? '✓' : 'x'),
};
