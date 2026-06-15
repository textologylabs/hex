import { PromptCancelledError } from './core/prompts/types.js';

/**
 * How the top-level CLI catch should report a thrown error (M15.5). Kept
 * separate from `cli.ts` so it's unit-testable — `cli.ts` runs `main()` at
 * import time, so tests can't import it directly.
 */
export type TopLevelErrorReport = {
  /** Message to print to stderr (without colour). */
  message: string;
  /** Process exit code. */
  exitCode: number;
  /** True for a user cancel — render dim rather than as an error. */
  cancelled: boolean;
};

export function describeTopLevelError(err: unknown): TopLevelErrorReport {
  // A user cancel (Esc / ctrl-C out of a prompt) is a normal exit, not an
  // error: quiet message + 130 (conventional "interrupted by user") so a
  // script can tell cancel apart from both success and failure.
  if (err instanceof PromptCancelledError) {
    return { message: 'cancelled', exitCode: 130, cancelled: true };
  }
  return {
    message: `error: ${err instanceof Error ? err.message : String(err)}`,
    exitCode: 1,
    cancelled: false,
  };
}
