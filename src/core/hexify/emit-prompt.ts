import type { MinedPair } from './mine.js';
import type { ScannedFile } from './pipeline.js';
import { MIN_VALUE_LENGTH } from './substitute.js';

/**
 * `hexify --emit-prompt` (Hex 2.0 / H3): build a self-contained
 * markdown prompt for an external AI agent asking it to propose deep
 * parameterisation of the template repo, answered as a
 * `hexify.plan.yaml` that `hexify --plan` consumes.
 *
 * Design stance: hex never calls an AI — the prompt and the plan are
 * files the user carries between hex and whatever agent (if any) they
 * trust. The agent is assumed to have filesystem access, so the prompt
 * cites repo paths and summarises hex's own findings rather than
 * inlining file contents; the agent explores the trees itself.
 */

/** package.json-derived seed values, structurally what the command reads. */
export type AgentPromptSeeds = {
  name?: string;
  description?: string;
  author?: string;
  license?: string;
};

export type AgentPromptInput = {
  /** Absolute path of the template repo (hexify's cwd). */
  templateRoot: string;
  /** Absolute path of the `--against` instance, when given. */
  againstRoot?: string;
  seeds: AgentPromptSeeds;
  files: ScannedFile[];
  ignorePatterns: string[];
  mined: MinedPair[];
};

/** File-inventory lines before truncation — huge repos stay summarised. */
const MAX_INVENTORY_LINES = 400;

export function buildAgentPrompt(input: AgentPromptInput): string {
  const lines: string[] = [];
  const push = (...l: string[]): void => {
    lines.push(...l);
  };

  push(
    '# Hexify parameterisation — agent briefing',
    '',
    'You are helping convert a plain template repository into a **Hex**',
    'template (a scaffolding tool: confirmed values become prompts, every',
    'occurrence becomes a `{{ placeholder }}` in file contents and paths).',
    'Your job is the *judgment* half: find the concrete values that should',
    'become parameters. Hex does the substitution, escaping, and',
    'verification deterministically — a wrong proposal cannot corrupt the',
    'repo, it just counts zero occurrences or fails the round-trip proof.',
    '',
    '## Repositories',
    '',
    `- Template repo (the one being converted): \`${input.templateRoot}\``,
  );
  if (input.againstRoot) {
    push(
      `- A known instance, hand-copied from it earlier: \`${input.againstRoot}\``,
      '',
      'Read both trees directly. Everywhere the template and the instance',
      'differ by a consistent value substitution is a parameter site;',
      'differences that are feature drift are NOT parameters.',
    );
  } else {
    push(
      '',
      'Read the tree directly. Look for the values a team would change when',
      'copying this repo to start a new service.',
    );
  }

  push(
    '',
    '## Rules (Hex enforces every one of these)',
    '',
    '- Propose concrete **values exactly as they appear in the template**',
    '  repo — never placeholders, never regexes. Escaping and substitution',
    '  are Hex’s job.',
    `- Values must be at least ${MIN_VALUE_LENGTH} characters and appear verbatim somewhere in`,
    '  the template repo (contents or file paths) — otherwise the param',
    '  counts 0 occurrences and is dropped.',
    '- Param names are lower_snake_case: `^[a-z_][a-z0-9_]*$`.',
    '- Values made only of `[A-Za-z0-9_.-]` substitute with word-boundary',
    '  protection (`acme-portal` will not match inside `acme-portal-web` —',
    '  propose the longer value separately if it varies independently).',
    '  Values with spaces or other punctuation match as plain substrings.',
    '- On overlap the longest value wins; proposing both `acme` and',
    '  `acme-portal` is safe.',
    '- Casing variants (`acme_portal`, `AcmePortal`) are separate params in',
    '  this version — propose each spelling you find.',
    '- Every value must be one a fresh instance would genuinely change.',
    '  When unsure, leave it out — a human confirms each param, and fewer,',
    '  better params beat noise.',
    '',
    'Look especially for what mechanical mining cannot see: multi-word',
    'strings (company names, licence headers), service/deploy-manifest',
    'names, ports, org slugs, registry URLs, team e-mail addresses.',
  );

  push('', '## What Hex already found', '');
  const seedEntries: Array<[string, string | undefined]> = [
    ['name', input.seeds.name],
    ['description', input.seeds.description],
    ['author', input.seeds.author],
    ['license', input.seeds.license],
  ];
  const seedLines = seedEntries.filter((s): s is [string, string] => typeof s[1] === 'string');
  if (seedLines.length > 0) {
    push('package.json seeds (auto-proposed anyway — extend, don’t repeat):', '');
    for (const [k, v] of seedLines) push(`- ${k}: \`${v}\``);
  } else {
    push('No package.json seeds — the guided flow starts empty here.');
  }
  if (input.againstRoot) {
    push('', `Mined template↔instance pairs (all ${input.mined.length}, unfiltered):`, '');
    if (input.mined.length === 0) {
      push('- none — the trees are identical or differ only by drift');
    }
    for (const m of input.mined) {
      push(
        `- \`${m.templateValue}\` ↔ \`${m.instanceValue}\` (${m.evidence} differing spot${
          m.evidence === 1 ? '' : 's'
        } in ${m.filePaths.join(', ')})`,
      );
    }
  }

  push('', '## Template file inventory', '');
  push(`Ignore patterns: ${input.ignorePatterns.join(', ')}`, '');
  const inventory = input.files.map((f) => `- ${f.rel}${f.binary ? ' (binary)' : ''}`);
  push(...inventory.slice(0, MAX_INVENTORY_LINES));
  if (inventory.length > MAX_INVENTORY_LINES) {
    push(`- … and ${inventory.length - MAX_INVENTORY_LINES} more`);
  }

  push(
    '',
    '## Your output — `hexify.plan.yaml`',
    '',
    'Write it in the template repo root (Hex tolerates it there untracked):',
    '',
    '```yaml',
    'template:            # optional — defaults for the template identity',
    '  name: acme-portal',
    '  kind: webapp',
    'params:',
    '  - name: project_name',
    '    value: acme-portal',
    '    description: Project name',
    '  - name: service_name',
    '    value: acme-portal-svc',
    '    description: Deployed service name',
    '```',
    '',
    'Param names and values must each be unique across the list.',
    '',
    '## Verify your plan (recommended loop)',
    '',
    'Hex is the oracle — iterate until it agrees with you:',
    '',
    '1. From the template repo root:',
    '',
    '   ```sh',
    '   hex hexify --plan hexify.plan.yaml --dry-run --json',
    '   ```',
    '',
    '   Runs headless and writes nothing. In the report: any',
    '   `parameters[].occurrences.total` of 0 means that value does not',
    '   appear verbatim (fix or drop it — `planned.unmatched` lists them),',
    '   and `roundTrip.ok` must be true.',
  );
  if (input.againstRoot) {
    push(
      '',
      '2. Grade the result against the instance. Write an answers file',
      '   mapping each param name to the INSTANCE’s value (e.g.',
      '   `project_name: zed-portal`), then from the instance directory:',
      '',
      '   ```sh',
      `   hex adopt ${input.templateRoot} --dry-run --json --answers <answers.yaml>`,
      '   ```',
      '',
      '   Writes nothing (exit 0 even at low fit). Maximise `.fitPercent`;',
      '   the `edited` list shows exactly where parameterisation is still',
      '   missing or wrong.',
    );
  }
  push(
    '',
    'When the plan is final, a human runs `hex hexify --plan',
    'hexify.plan.yaml` interactively — every param is confirmed by hand and',
    'nothing is written unless a render with the original values reproduces',
    'the repo byte-for-byte.',
    '',
  );

  return lines.join('\n');
}
