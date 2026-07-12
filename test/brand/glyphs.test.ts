import { describe, expect, it, vi } from 'vitest';
import { getGlyphs, sym } from '../../src/brand/glyphs.js';
import { detectCapabilities } from '../../src/util/tty.js';

describe('glyphs', () => {
  it('returns unicode glyphs when unicode is supported', () => {
    const g = getGlyphs(true);
    expect(g.filled).toBe('⬢');
    expect(g.empty).toBe('⬡');
    expect(g.error).toBe('✗');
    expect(g.ok).toBe('✓');
    expect(g.warn).toBe('⚠');
  });

  it('falls back to ASCII when unicode is not supported', () => {
    const g = getGlyphs(false);
    expect(g.filled).toBe('[#]');
    expect(g.empty).toBe('[ ]');
    expect(g.error).toBe('[x]');
    expect(g.ok).toBe('[OK]');
    expect(g.warn).toBe('[!]');
  });
});

describe('status symbols (sym)', () => {
  it('resolves to unicode via HEX_FORCE_UNICODE', () => {
    vi.stubEnv('HEX_FORCE_UNICODE', '1');
    try {
      expect(sym.ok()).toBe('✓');
      expect(sym.warn()).toBe('⚠');
      expect(sym.err()).toBe('✗');
      expect(sym.check()).toBe('✓');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('degrades to ASCII via HEX_FORCE_ASCII', () => {
    vi.stubEnv('HEX_FORCE_ASCII', '1');
    try {
      expect(sym.ok()).toBe('[OK]');
      expect(sym.warn()).toBe('[!]');
      expect(sym.err()).toBe('[x]');
      // The bracketed-checkbox variant stays a single glyph so `[✓]` → `[x]`.
      expect(sym.check()).toBe('x');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('terminal capability detection', () => {
  it('honours HEX_FORCE_ASCII=1', () => {
    expect(detectCapabilities({ HEX_FORCE_ASCII: '1', LANG: 'en_US.UTF-8' }).unicode).toBe(false);
  });

  it('honours HEX_FORCE_UNICODE=1 even on a non-UTF-8 locale', () => {
    expect(detectCapabilities({ HEX_FORCE_UNICODE: '1', LANG: 'C' }).unicode).toBe(true);
  });

  it('detects UTF-8 from LANG (POSIX platforms)', () => {
    expect(detectCapabilities({ LANG: 'en_US.UTF-8' }, 'linux').unicode).toBe(true);
  });

  it('falls back when locale is non-UTF-8 (POSIX platforms)', () => {
    expect(detectCapabilities({ LANG: 'C' }, 'linux').unicode).toBe(false);
  });

  it('on Windows uses terminal signals, not LANG', () => {
    // Windows doesn't surface UTF-8 via LANG — a UTF-8 LANG alone is not enough.
    expect(detectCapabilities({ LANG: 'en_US.UTF-8' }, 'win32').unicode).toBe(false);
    // …but a modern terminal (Windows Terminal / VS Code) is detected.
    expect(detectCapabilities({ WT_SESSION: '1' }, 'win32').unicode).toBe(true);
    expect(detectCapabilities({ TERM_PROGRAM: 'vscode' }, 'win32').unicode).toBe(true);
  });
});
