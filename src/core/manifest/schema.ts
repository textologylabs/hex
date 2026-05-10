import { z } from 'zod';

const promptCommon = {
  description: z.string().optional(),
  required: z.boolean().optional(),
  when: z.string().optional(),
};

const stringPromptSchema = z.object({
  type: z.literal('string'),
  default: z.string().optional(),
  pattern: z.string().optional(),
  ...promptCommon,
});

const integerPromptSchema = z.object({
  type: z.union([z.literal('integer'), z.literal('number')]),
  default: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  ...promptCommon,
});

const booleanPromptSchema = z.object({
  type: z.literal('boolean'),
  default: z.boolean().optional(),
  ...promptCommon,
});

const enumPromptSchema = z.object({
  type: z.literal('enum'),
  choices: z.array(z.string()).min(1),
  default: z.string().optional(),
  ...promptCommon,
});

const multiPromptSchema = z.object({
  type: z.literal('multi'),
  choices: z.array(z.string()).min(1),
  default: z.array(z.string()).optional(),
  ...promptCommon,
});

const passwordPromptSchema = z.object({
  type: z.literal('password'),
  ...promptCommon,
});

const pathPromptSchema = z.object({
  type: z.literal('path'),
  default: z.string().optional(),
  must_exist: z.boolean().optional(),
  ...promptCommon,
});

export const promptDefSchema = z.discriminatedUnion('type', [
  stringPromptSchema,
  integerPromptSchema,
  booleanPromptSchema,
  enumPromptSchema,
  multiPromptSchema,
  passwordPromptSchema,
  pathPromptSchema,
]);

export const renameHookSchema = z.object({
  rename: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    when: z.string().optional(),
  }),
});

export const deleteHookSchema = z.object({
  delete: z
    .union([
      z.object({ path: z.string().min(1), when: z.string().optional() }),
      z.object({ glob: z.string().min(1), when: z.string().optional() }),
    ])
    .refine((v) => ('path' in v ? !('glob' in v) : 'glob' in v), {
      message: 'delete hook must specify exactly one of path or glob',
    }),
});

const postRenderHookSchema = z.union([renameHookSchema, deleteHookSchema]);

export const hooksSchema = z.object({
  post_render: z.array(postRenderHookSchema).optional(),
});

export const includeRuleSchema = z
  .union([
    z.object({ path: z.string().min(1), when: z.string().min(1) }),
    z.object({ glob: z.string().min(1), when: z.string().min(1) }),
  ])
  .refine((v) => ('path' in v ? !('glob' in v) : 'glob' in v), {
    message: 'include rule must specify exactly one of path or glob',
  });

export const sectionSchema = z.object({
  title: z.string().min(1),
  prompts: z.array(z.string().min(1)).min(1),
});

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

export const TASK_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const setupTaskSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(TASK_ID_RE, 'task id must be kebab-case ([a-z0-9-], no leading/trailing dash)'),
  title: z.string().min(1),
  detail: z.string().optional(),
});

export const setupSchema = z.object({
  message: z.string().min(1).optional(),
  tasks: z.array(setupTaskSchema).optional(),
});

export const KEBAB_KEY_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Permissive but not loose: optional comparator + strict semver triplet,
// optional prerelease/build metadata, or bare `*`. Looser ranges (e.g. `1.x`,
// hyphen ranges) are deliberately rejected for now — a real recipe can ask
// to relax this if needed.
const VERSION_SPEC_RE =
  /^(?:\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$|^\*$/;

// Three wire forms, dispatched by prefix:
//   - `file:<path>`           → local FileSource (path relative to recipe root)
//   - `git+<url>[@<ref>]`     → GitSource (last `@` is the ref iff what follows
//                               looks ref-like — i.e. has no `:`, which would
//                               mark it as part of an `git@host:path` URL)
//   - `<name>@<versionSpec>`  → bare name, resolved via configured source roots
//
// The scoped-name case (`@hexology/foo@^0.1.0`) parses by splitting on the
// LAST `@` after stripping the optional prefix.
// Slot form (M6.3): `{ kind: <component-kind>, version: <spec> }` — picks a
// candidate from discovery matching the kind. We use a single dispatching
// transform (rather than `z.union(stringForm, slotForm)`) because zod's union
// swallows the string transform's custom `ctx.addIssue` messages and reports
// only a generic "Invalid input" at the parent path.
const slotComposesEntryShape = z
  .object({
    kind: z
      .string()
      .min(1)
      .regex(
        KEBAB_KEY_RE,
        'composes slot kind must be kebab-case ([a-z0-9-], no leading/trailing dash)',
      ),
    version: z
      .string()
      .regex(VERSION_SPEC_RE, 'composes slot version must be a recognized semver spec'),
  })
  .strict();

const stringComposesEntrySchema = z
  .string()
  .min(1)
  .transform((spec, ctx) => {
    if (spec.startsWith('file:')) {
      const path = spec.slice('file:'.length);
      if (path.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `composes entry "${spec}" has an empty path after "file:"`,
        });
        return z.NEVER;
      }
      return { kind: 'file' as const, path };
    }

    if (spec.startsWith('git+')) {
      const rest = spec.slice('git+'.length);
      if (rest.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `composes entry "${spec}" has an empty URL after "git+"`,
        });
        return z.NEVER;
      }
      const lastAt = rest.lastIndexOf('@');
      if (lastAt === -1) {
        return { kind: 'git' as const, url: rest };
      }
      const possibleRef = rest.slice(lastAt + 1);
      // SSH URLs look like `git@host:path` — the `@` is part of the URL,
      // not a ref delimiter. The trailing piece will contain `:` in that
      // case, which gives us a clean discriminator.
      if (possibleRef.length === 0 || possibleRef.includes(':')) {
        return { kind: 'git' as const, url: rest };
      }
      return { kind: 'git' as const, url: rest.slice(0, lastAt), ref: possibleRef };
    }

    const lastAt = spec.lastIndexOf('@');
    if (lastAt <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: `composes entry "${spec}" must be of the form "<name>@<version>", "file:<path>", or "git+<url>[@<ref>]"`,
      });
      return z.NEVER;
    }
    const name = spec.slice(0, lastAt);
    const versionSpec = spec.slice(lastAt + 1);
    if (/\s/.test(name)) {
      ctx.addIssue({
        code: 'custom',
        message: `composes entry name "${name}" must not contain whitespace`,
      });
      return z.NEVER;
    }
    if (!VERSION_SPEC_RE.test(versionSpec)) {
      ctx.addIssue({
        code: 'custom',
        message: `composes entry version spec "${versionSpec}" is not a recognized semver spec`,
      });
      return z.NEVER;
    }
    return { kind: 'name' as const, name, versionSpec };
  });

export const composesEntrySchema = z.unknown().transform((val, ctx) => {
  if (typeof val === 'string') {
    const parsed = stringComposesEntrySchema.safeParse(val);
    if (!parsed.success) {
      // Forward each sub-schema issue to the parent context. Cast to the
      // input shape — zod's $ZodIssue union has variants (e.g.
      // unrecognized_keys) that the public addIssue() input type doesn't
      // include directly, but the runtime accepts them.
      for (const issue of parsed.error.issues) {
        ctx.addIssue(issue as Parameters<typeof ctx.addIssue>[0]);
      }
      return z.NEVER;
    }
    return parsed.data;
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const parsed = slotComposesEntryShape.safeParse(val);
    if (!parsed.success) {
      // Forward each sub-schema issue to the parent context. Cast to the
      // input shape — zod's $ZodIssue union has variants (e.g.
      // unrecognized_keys) that the public addIssue() input type doesn't
      // include directly, but the runtime accepts them.
      for (const issue of parsed.error.issues) {
        ctx.addIssue(issue as Parameters<typeof ctx.addIssue>[0]);
      }
      return z.NEVER;
    }
    return {
      kind: 'slot' as const,
      componentKind: parsed.data.kind,
      versionSpec: parsed.data.version,
    };
  }
  ctx.addIssue({
    code: 'custom',
    message: 'composes entry must be a string or { kind, version } object',
  });
  return z.NEVER;
});

export const composesSchema = z.record(z.string(), composesEntrySchema);

// Component contracts (M6.1):
//   provides — non-empty strings (env vars, generated symbols, file-layout promises)
//   consumes — non-empty strings the component needs bound from siblings
//   requires — peer-presence assertions, either by kind or by name+version
export const providesSchema = z.array(z.string().min(1));
export const consumesSchema = z.array(z.string().min(1));

// `.strict()` on each variant ensures a mixed object (e.g. `{kind, name, version}`)
// fails BOTH variants — without it, zod would silently strip the extra keys and
// accept the object as the matching shape.
const requireByKindSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .regex(
        KEBAB_KEY_RE,
        'requires kind must be kebab-case ([a-z0-9-], no leading/trailing dash)',
      ),
  })
  .strict();

const requireByNameVersionSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().regex(VERSION_SPEC_RE, 'requires version must be a recognized semver spec'),
  })
  .strict();

export const requirementSchema = z.union([requireByKindSchema, requireByNameVersionSchema]);

export const requiresSchema = z.array(requirementSchema);

// Manifest schema with prompts already desugared (each entry { name, def }).
// `sections:` opts the manifest into total coverage — every prompt must
// appear in exactly one section, and section entries must reference real
// prompts. The check fires here (not at engine time) so authoring mistakes
// surface as parse errors with file paths.
export const manifestSchema = z
  .object({
    type: z.union([z.literal('component'), z.literal('recipe')]),
    name: z.string().min(1),
    version: z.string().regex(SEMVER_RE, 'version must be semver (MAJOR.MINOR.PATCH)'),
    kind: z.string().optional(),
    prompts: z
      .array(
        z.object({
          name: z.string().min(1),
          def: promptDefSchema,
        }),
      )
      .optional(),
    sections: z.array(sectionSchema).optional(),
    hooks: hooksSchema.optional(),
    include: z.array(includeRuleSchema).optional(),
    setup: setupSchema.optional(),
    composes: composesSchema.optional(),
    provides: providesSchema.optional(),
    consumes: consumesSchema.optional(),
    requires: requiresSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    for (const field of ['provides', 'consumes', 'requires'] as const) {
      if (manifest[field] && manifest.type !== 'component') {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `\`${field}\` is only allowed on components (type: component)`,
        });
      }
    }

    if (manifest.composes) {
      if (manifest.type !== 'recipe') {
        ctx.addIssue({
          code: 'custom',
          path: ['composes'],
          message: '`composes` is only allowed on recipes (type: recipe)',
        });
      }
      for (const key of Object.keys(manifest.composes)) {
        if (!KEBAB_KEY_RE.test(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['composes', key],
            message: `composes key "${key}" must be kebab-case ([a-z0-9-], no leading/trailing dash)`,
          });
        }
      }
    }

    if (manifest.setup?.tasks) {
      const seenIds = new Map<string, number>();
      manifest.setup.tasks.forEach((task, idx) => {
        const previous = seenIds.get(task.id);
        if (previous !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['setup', 'tasks', idx, 'id'],
            message: `setup task id "${task.id}" appears more than once (also at index ${previous})`,
          });
          return;
        }
        seenIds.set(task.id, idx);
      });
    }

    if (!manifest.sections) return;

    const promptNames = new Set((manifest.prompts ?? []).map((p) => p.name));
    const seen = new Map<string, number>(); // name → section index

    manifest.sections.forEach((section, sIdx) => {
      section.prompts.forEach((promptName, pIdx) => {
        if (!promptNames.has(promptName)) {
          ctx.addIssue({
            code: 'custom',
            path: ['sections', sIdx, 'prompts', pIdx],
            message: `section "${section.title}" references unknown prompt "${promptName}"`,
          });
          return;
        }
        const previous = seen.get(promptName);
        if (previous !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['sections', sIdx, 'prompts', pIdx],
            message: `prompt "${promptName}" appears in multiple sections (also in section ${previous})`,
          });
          return;
        }
        seen.set(promptName, sIdx);
      });
    });

    for (const name of promptNames) {
      if (!seen.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sections'],
          message: `prompt "${name}" is not assigned to any section`,
        });
      }
    }
  });
