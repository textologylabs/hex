#!/usr/bin/env node
import { Command } from 'commander';
import { brand } from './brand/colors.js';
import { VERSION, splash } from './brand/splash.js';
import { registerBrowse } from './commands/browse.js';
import { registerDoctor } from './commands/doctor.js';
import { registerLint } from './commands/lint.js';
import { registerList } from './commands/list.js';
import { registerNew } from './commands/new.js';
import { registerPublish } from './commands/publish.js';
import { registerSearch } from './commands/search.js';
import { registerSetup } from './commands/setup.js';
import { registerSources } from './commands/sources.js';
import { registerUpgrade } from './commands/upgrade.js';
import { maybeUpdate } from './update.js';

process.on('exit', () => {
  if (process.stdout.isTTY) process.stdout.write('\n');
});

async function main() {
  await maybeUpdate();

  const program = new Command();

  program
    .name('hex')
    .version(VERSION, '-v, --version', 'print version and exit')
    .addHelpText('beforeAll', `${splash()}\n`);

  registerBrowse(program);
  registerDoctor(program);
  registerLint(program);
  registerList(program);
  registerNew(program);
  registerPublish(program);
  registerSearch(program);
  registerSetup(program);
  registerSources(program);
  registerUpgrade(program);

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(brand.error(`error: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
