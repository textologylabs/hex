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

export type PostRenderHook = RenameHook | DeleteHook;

export type Hooks = {
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
  provides?: string[];
  consumes?: string[];
  requires?: Requirement[];
};
