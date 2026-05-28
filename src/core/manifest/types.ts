export type PromptCommon = {
  description?: string;
  required?: boolean;
  when?: string;
};

export type StringPrompt = PromptCommon & {
  type: 'string';
  default?: string;
  pattern?: string;
};

export type IntegerPrompt = PromptCommon & {
  type: 'integer' | 'number';
  default?: number;
  min?: number;
  max?: number;
};

export type BooleanPrompt = PromptCommon & {
  type: 'boolean';
  default?: boolean;
};

export type EnumPrompt = PromptCommon & {
  type: 'enum';
  choices: string[];
  default?: string;
};

export type MultiPrompt = PromptCommon & {
  type: 'multi';
  choices: string[];
  default?: string[];
};

export type PasswordPrompt = PromptCommon & {
  type: 'password';
};

export type PathPrompt = PromptCommon & {
  type: 'path';
  default?: string;
  must_exist?: boolean;
};

export type PromptDef =
  | StringPrompt
  | IntegerPrompt
  | BooleanPrompt
  | EnumPrompt
  | MultiPrompt
  | PasswordPrompt
  | PathPrompt;

export type Prompt = { name: string; def: PromptDef };

export type RenameHook = {
  rename: { from: string; to: string; when?: string };
};

export type DeleteHook = {
  delete: ({ path: string } | { glob: string }) & { when?: string };
};

/**
 * JS hook declaration. `js` is the filename inside `.hex/hooks/` — no
 * subdirectories, no traversal. The bundle loader reads the file at load
 * time and attaches its source under `ComponentBundle.jsHookSources`.
 *
 * `name` (M7.5) is the namespace key used for the hook's prompt answers
 * (`answers.hooks.<name>.*`). Defaults to the filename minus `.js`.
 *
 * `prompts` (M7.5) fire at the hook's lifecycle moment, before the
 * hook's JS body runs. Answers land namespaced — the hook can read the
 * full answers tree (shared read) but persisted writes are isolated to
 * its own namespace.
 */
export type JsHook = {
  js: string;
  when?: string;
  name?: string;
  prompts?: Prompt[];
};

export type PostRenderHook = RenameHook | DeleteHook | JsHook;
export type PreRenderHook = JsHook;

export type Hooks = {
  pre_render?: PreRenderHook[];
  post_render?: PostRenderHook[];
};

export type IncludeRule = { path: string; when: string } | { glob: string; when: string };

export type Section = {
  title: string;
  prompts: string[];
};

export type SetupTask = {
  id: string;
  title: string;
  detail?: string;
};

export type Setup = {
  message?: string;
  tasks?: SetupTask[];
};

/**
 * `stub` (M8.2) is a per-slot recipe decision, orthogonal to which ref
 * variant resolves the child. When `true`, the recipe is opting that
 * child into stub mode — the resolver verifies the resolved component
 * declares a `stub:` block, and `stub_enabled` lands in the child's
 * render context.
 */
export type ChildRefStub = {
  stub?: boolean;
};

export type NameChildRef = ChildRefStub & {
  kind: 'name';
  name: string;
  versionSpec: string;
};

export type FileChildRef = ChildRefStub & {
  kind: 'file';
  path: string;
};

export type GitChildRef = ChildRefStub & {
  kind: 'git';
  url: string;
  ref?: string;
};

export type SlotChildRef = ChildRefStub & {
  kind: 'slot';
  /** The component kind to match against discovered templates. */
  componentKind: string;
  versionSpec: string;
};

export type ChildRef = NameChildRef | FileChildRef | GitChildRef | SlotChildRef;

export type Composes = Record<string, ChildRef>;

export type RequireByKind = { kind: string };
export type RequireByNameVersion = { name: string; version: string };
export type Requirement = RequireByKind | RequireByNameVersion;

/**
 * `provides` has two surface forms (parser preserves both):
 *   - `string[]` — bare declarations (no value produced; M6.1 baseline)
 *   - `Record<string, string>` — symbol → Nunjucks expression evaluated in
 *     the child's own answer scope at render time, made available to
 *     siblings under `provided.<symbol>`.
 */
export type Provides = string[] | Record<string, string>;

/**
 * Stub-mode declaration (M8.1). A component carrying a `stub:` block
 * advertises that it supports stub mode via the named engine. Absent
 * `stub:` means the component is real-only.
 *
 * `engine` is one of a known catalogue (`STUB_ENGINES` in schema.ts);
 * `fixtures` optionally points at a directory of seed data that M8.4
 * renders into the generated tree when stub mode is active.
 */
export type StubEngine = 'pg-mem' | 'msw' | 'wiremock';

export type Stub = {
  engine: StubEngine;
  fixtures?: string;
};

/**
 * Deploy stanza (M12.1). `adapter` identifies the deploy adapter by name;
 * any other keys are adapter-specific config that round-trips through the
 * manifest unchanged. The adapter's own `validateConfig` checks them.
 */
export type Deploy = {
  adapter: string;
  [key: string]: unknown;
};

/**
 * CI/CD stanza (M12.1). `provider` identifies the CI/CD provider by name;
 * any other keys are provider-specific config.
 */
export type Cicd = {
  provider: string;
  [key: string]: unknown;
};

export type Manifest = {
  type: 'component' | 'recipe';
  name: string;
  version: string;
  kind?: string;
  prompts?: Prompt[];
  sections?: Section[];
  hooks?: Hooks;
  include?: IncludeRule[];
  setup?: Setup;
  composes?: Composes;
  provides?: Provides;
  consumes?: string[];
  requires?: Requirement[];
  stub?: Stub;
  deploy?: Deploy;
  cicd?: Cicd;
};
