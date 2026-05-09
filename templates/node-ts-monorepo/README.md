# {{ workspace_name }}

Node + TypeScript monorepo with two packages, managed as npm workspaces.

## Layout

```
{{ workspace_name }}/
├── cli/      # {{ cli.project_name }} — {{ cli.description }}
└── lib/      # {{ lib.project_name }} — {{ lib.description }}
```

## Get started

```sh
npm install        # installs all workspace deps and links lib into cli
npm run build      # builds every workspace
npm test           # runs every workspace's tests
```

Each package has its own README under its subdir with package-specific docs.

## Adding a workspace dependency

To use `{{ lib.project_name }}` from inside `{{ cli.project_name }}`, add it
to `cli/package.json`:

```json
{
  "dependencies": {
    "{{ lib.project_name }}": "workspace:*"
  }
}
```

Then `npm install` again at the workspace root — npm will link the local lib
into the cli's `node_modules/` automatically.
