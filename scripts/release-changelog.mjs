#!/usr/bin/env node
// Release-prep CHANGELOG surgery (M15.16). Moves the accumulated
// `## [Unreleased]` entries under a dated `## [<version>]` heading and
// leaves a fresh empty `## [Unreleased]` on top for the next cycle —
// the Keep a Changelog convention. Invoked by `release-prep.yml`:
//
//   node scripts/release-changelog.mjs <version> <YYYY-MM-DD> [changelogPath]
//
// Fails loudly (exit 1) if there's nothing under `## [Unreleased]`, so a
// release can't be cut with an empty body.
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Transform CHANGELOG text: rename the current `## [Unreleased]` section
 * to `## [version] — date`, and insert a new empty `## [Unreleased]`
 * above it. Returns the new text. Throws if the Unreleased section is
 * missing or its body is empty.
 */
export function releaseChangelog(text, version, date) {
  const lines = text.split('\n');
  const headingRe = /^## \[/;
  const unreleasedRe = /^## \[Unreleased\]/i;

  const start = lines.findIndex((l) => unreleasedRe.test(l));
  if (start === -1) throw new Error('no `## [Unreleased]` section found in CHANGELOG');

  // Body runs from the line after the heading to the next `## [` heading.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      end = i;
      break;
    }
  }

  const body = lines.slice(start + 1, end);
  if (body.join('').trim().length === 0) {
    throw new Error('`## [Unreleased]` is empty — nothing to release');
  }

  // Trim leading/trailing blank lines off the captured body, then rebuild:
  //   ## [Unreleased]
  //   <blank>
  //   ## [version] — date
  //   <body>
  //   <blank>
  while (body.length > 0 && body[0].trim() === '') body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();

  const rebuilt = [
    '## [Unreleased]',
    '',
    `## [${version}] — ${date}`,
    '',
    ...body,
    '',
  ];

  return [...lines.slice(0, start), ...rebuilt, ...lines.slice(end)].join('\n');
}

function main() {
  const [version, date, path = 'CHANGELOG.md'] = process.argv.slice(2);
  if (!version || !date) {
    process.stderr.write('usage: release-changelog.mjs <version> <YYYY-MM-DD> [path]\n');
    process.exit(2);
  }
  const text = readFileSync(path, 'utf8');
  let next;
  try {
    next = releaseChangelog(text, version, date);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  writeFileSync(path, next, 'utf8');
  process.stdout.write(`CHANGELOG.md: [Unreleased] → [${version}] — ${date}\n`);
}

// Only run when invoked directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) main();
