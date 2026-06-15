import { describe, expect, it } from 'vitest';
import { describeTopLevelError } from '../src/cli-errors.js';
import { PromptCancelledError } from '../src/core/prompts/types.js';

describe('describeTopLevelError', () => {
  it('maps a user cancel to a quiet message + exit 130', () => {
    const report = describeTopLevelError(new PromptCancelledError());
    expect(report).toEqual({ message: 'cancelled', exitCode: 130, cancelled: true });
  });

  it('maps a normal Error to an `error:` message + exit 1', () => {
    const report = describeTopLevelError(new Error('boom'));
    expect(report).toEqual({ message: 'error: boom', exitCode: 1, cancelled: false });
  });

  it('handles a non-Error throw value', () => {
    const report = describeTopLevelError('weird');
    expect(report).toEqual({ message: 'error: weird', exitCode: 1, cancelled: false });
  });
});
