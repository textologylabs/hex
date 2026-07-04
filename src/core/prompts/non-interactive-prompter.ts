import { PromptError } from './engine.js';
import type { Prompter } from './types.js';

/**
 * A {@link Prompter} for non-interactive (`--answers`) mode (M15.17). UI hooks
 * (outline / section / progress / note) are no-ops; the actual input widgets
 * throw, because in answers mode `runPrompts` resolves every firing prompt
 * from the supplied map or its default and never reaches a widget. If one is
 * reached, the answers file was missing a value — surface it loudly rather
 * than blocking on a prompt with no terminal to read.
 */
export function createNonInteractivePrompter(): Prompter {
  const unanswered = (): never => {
    throw new PromptError(
      'a prompt needs an answer but none was supplied — add it to your --answers file, ' +
        'or run interactively (prompts defined inside a hook can only be answered interactively)',
    );
  };
  return {
    text: unanswered,
    confirm: unanswered,
    select: unanswered,
    multiselect: unanswered,
    password: unanswered,
    outline() {},
    sectionStart() {},
    sectionEnd() {},
    progress() {},
    note() {},
  };
}
