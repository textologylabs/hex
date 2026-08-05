import { describe, expect, it } from 'vitest';
import { buildAgentPrompt } from '../../../src/core/hexify/emit-prompt.js';
import type { ScannedFile } from '../../../src/core/hexify/pipeline.js';
import { parsePlanFile } from '../../../src/core/hexify/plan-file.js';

const file = (rel: string, binary = false): ScannedFile => ({
  rel,
  abs: `/tpl/${rel}`,
  binary,
  ...(binary ? {} : { text: 'x\n' }),
});

const baseInput = {
  templateRoot: '/work/acme-portal',
  seeds: { name: 'acme-portal', license: 'MIT' },
  files: [file('package.json'), file('src/acme-portal.config.ts'), file('logo.png', true)],
  ignorePatterns: ['.git/', 'node_modules/'],
  mined: [],
};

describe('buildAgentPrompt', () => {
  it('cites both repo paths, the rules, and the self-grade loop when --against is present', () => {
    const prompt = buildAgentPrompt({
      ...baseInput,
      againstRoot: '/work/zed-portal',
      mined: [
        {
          templateValue: 'acme-portal-svc',
          instanceValue: 'zed-portal-svc',
          evidence: 7,
          files: 2,
          filePaths: ['conf/service.yaml', 'k8s/deploy.yaml'],
        },
      ],
    });
    expect(prompt).toContain('/work/acme-portal');
    expect(prompt).toContain('/work/zed-portal');
    // Rules the agent must follow.
    expect(prompt).toContain('^[a-z_][a-z0-9_]*$');
    expect(prompt).toContain('at least 3 characters');
    expect(prompt).toContain('never placeholders');
    // Mined evidence with its file paths.
    expect(prompt).toContain('`acme-portal-svc` ↔ `zed-portal-svc`');
    expect(prompt).toContain('conf/service.yaml, k8s/deploy.yaml');
    // Inventory with binary marker; seeds listed.
    expect(prompt).toContain('- src/acme-portal.config.ts');
    expect(prompt).toContain('- logo.png (binary)');
    expect(prompt).toContain('name: `acme-portal`');
    // The loop commands hex actually accepts.
    expect(prompt).toContain('hex hexify --plan hexify.plan.yaml --dry-run --json');
    expect(prompt).toContain('hex adopt /work/acme-portal --dry-run --json --answers');
    expect(prompt).toContain('.fitPercent');
  });

  it('omits instance material without --against but keeps the headless loop', () => {
    const prompt = buildAgentPrompt(baseInput);
    expect(prompt).not.toContain('Mined template↔instance pairs');
    expect(prompt).not.toContain('hex adopt');
    expect(prompt).toContain('hex hexify --plan hexify.plan.yaml --dry-run --json');
  });

  it('notes empty mining and empty seeds instead of omitting the sections silently', () => {
    const withEmpty = buildAgentPrompt({
      ...baseInput,
      seeds: {},
      againstRoot: '/work/zed-portal',
    });
    expect(withEmpty).toContain('No package.json seeds');
    expect(withEmpty).toContain('none — the trees are identical or differ only by drift');
  });

  it('truncates a huge file inventory', () => {
    const files = Array.from({ length: 450 }, (_, i) =>
      file(`src/f${String(i).padStart(3, '0')}.ts`),
    );
    const prompt = buildAgentPrompt({ ...baseInput, files });
    expect(prompt).toContain('… and 50 more');
    expect(prompt).not.toContain('f449');
  });

  it('ships an example plan block that parsePlanFile itself accepts', () => {
    const prompt = buildAgentPrompt(baseInput);
    const block = prompt.match(/```yaml\n([\s\S]*?)```/)?.[1];
    expect(block).toBeDefined();
    const yaml = (block ?? '')
      .split('\n')
      .map((l) => l.replace(/\s*#.*$/, ''))
      .join('\n');
    const plan = parsePlanFile(yaml);
    expect(plan.params.map((p) => p.name)).toEqual(['project_name', 'service_name']);
  });
});
