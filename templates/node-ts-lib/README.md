# {{ project_name }}

{{ description }}

## Install

```sh
npm install {{ project_name }}
```

## Use

```ts
import { greet } from '{{ project_name }}';

console.log(greet('world'));
```

## Develop

```sh
npm install
npm run dev   # tsup watch — rebuilds on change
```

## Build

```sh
npm run build   # emits dist/index.js (ESM) + dist/index.cjs + dist/index.d.ts
```

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | Bundle to `dist/` (ESM + CJS + types) via tsup |
| `npm run dev` | Watch-rebuild during development |
| `npm test` | Run vitest |
| `npm run typecheck` | TypeScript type-check |
| `npm run lint` | Biome lint |
| `npm run format` | Biome format-write |

## License

{{ license }}{% if author %} © {{ author }}{% endif %}
