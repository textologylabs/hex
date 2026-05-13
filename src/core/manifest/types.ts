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
 */
export type JsHook = {
  js: string;
  when?: string;
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

export type NameChildRef = {
  kind: 'name';
  name: string;
  versionSpec: string;
};

export type FileChildRef = {
  kind: 'file';
  path: string;
};

export type GitChildRef = {
  kind: 'git';
  url: string;
  ref?: string;
};

export type SlotChildRef = {
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
};
