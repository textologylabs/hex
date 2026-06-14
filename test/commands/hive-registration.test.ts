import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerBrowse } from '../../src/commands/browse.js';
import { registerHive } from '../../src/commands/hive.js';
import { registerMarketplace } from '../../src/commands/marketplace.js';
import { registerSearch } from '../../src/commands/search.js';
import { registerSources } from '../../src/commands/sources.js';

function buildProgram(): Command {
  const program = new Command();
  registerHive(program);
  registerSearch(program);
  registerBrowse(program);
  registerSources(program);
  registerMarketplace(program);
  return program;
}

describe('hex hive registration (M15.1)', () => {
  it('exposes `hive` in help and hides the legacy aliases', () => {
    const program = buildProgram();
    const visible = program
      .createHelp()
      .visibleCommands(program)
      .map((c) => c.name());

    expect(visible).toContain('hive');
    for (const alias of ['sources', 'search', 'browse', 'marketplace']) {
      expect(visible).not.toContain(alias);
    }
  });

  it('keeps the legacy aliases registered (hidden, not removed)', () => {
    const program = buildProgram();
    const all = program.commands.map((c) => c.name());
    for (const alias of ['sources', 'search', 'browse', 'marketplace']) {
      expect(all).toContain(alias);
    }
  });

  it('groups every discovery + source verb under `hive`', () => {
    const program = buildProgram();
    const hive = program.commands.find((c) => c.name() === 'hive');
    expect(hive).toBeDefined();
    const subs = hive?.commands.map((c) => c.name()) ?? [];
    for (const sub of [
      'list',
      'refresh',
      'search',
      'browse',
      'add',
      'remove',
      'info',
      'validate',
    ]) {
      expect(subs).toContain(sub);
    }
  });
});
