import { describe, expect, it } from 'vitest';
import { AnswersFileError, parseAnswersFile } from '../../../src/core/prompts/answers-file.js';

describe('parseAnswersFile', () => {
  it('parses a flat mapping of name → value', () => {
    const answers = parseAnswersFile(
      ['project_name: my-app', 'license: MIT', 'port: 3000', 'debug: true'].join('\n'),
    );
    expect(answers).toEqual({
      project_name: 'my-app',
      license: 'MIT',
      port: 3000,
      debug: true,
    });
  });

  it('preserves nested objects (recipe-child namespaces) and lists (multi answers)', () => {
    const answers = parseAnswersFile(
      ['app_name: site', 'features:', '  - a', '  - b', 'api:', '  port: 8080'].join('\n'),
    );
    expect(answers).toEqual({
      app_name: 'site',
      features: ['a', 'b'],
      api: { port: 8080 },
    });
  });

  it('treats an empty file as an empty answer map', () => {
    expect(parseAnswersFile('')).toEqual({});
    expect(parseAnswersFile('\n\n')).toEqual({});
  });

  it('rejects a top-level list', () => {
    expect(() => parseAnswersFile('- a\n- b')).toThrow(AnswersFileError);
    expect(() => parseAnswersFile('- a\n- b')).toThrow(/must be a mapping/);
  });

  it('rejects a top-level scalar', () => {
    expect(() => parseAnswersFile('just a string')).toThrow(/must be a mapping/);
  });

  it('rejects unparseable YAML', () => {
    expect(() => parseAnswersFile('key: [unterminated')).toThrow(AnswersFileError);
    expect(() => parseAnswersFile('key: [unterminated')).toThrow(/invalid YAML/);
  });
});
