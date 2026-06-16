export interface TerminalCapabilities {
  unicode: boolean;
  color: boolean;
  isTTY: boolean;
}

export function detectCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TerminalCapabilities {
  const isTTY = Boolean(process.stdout.isTTY);
  const color = isTTY && env.NO_COLOR === undefined && env.TERM !== 'dumb';
  return {
    unicode: detectUnicode(env, platform),
    color,
    isTTY,
  };
}

// `platform` is injected (defaulting to the real one) so the locale path and
// the Windows path are both testable on any CI runner — Windows deliberately
// ignores LANG (it isn't how the OS signals UTF-8 support).
function detectUnicode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env.HEX_FORCE_ASCII === '1') return false;
  if (env.HEX_FORCE_UNICODE === '1') return true;

  if (platform === 'win32') {
    return Boolean(env.WT_SESSION) || env.TERM_PROGRAM === 'vscode' || env.ConEmuTask !== undefined;
  }

  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /UTF-?8/i.test(locale);
}
