# {{ project_name }}

{{ description }}

## Develop

```sh
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Build

```sh
npm run build
npm run preview   # serves dist/ locally
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm test` | Run vitest |
| `npm run typecheck` | TypeScript type-check |
| `npm run lint` | Biome lint |
| `npm run format` | Biome format-write |

## Deploy

This project is wired to deploy to [Vercel](https://vercel.com) via
[Hex](https://github.com/textologylabs/hex):

```sh
hex deploy           # ships the current build via the Vercel CLI
hex deploy --dry-run # describe the planned invocation
```

The first deploy needs `VERCEL_TOKEN` exported (or set as a GitHub
secret for the CI/CD pipeline).

On every push to `main`, `.github/workflows/deploy.yml` runs the same
build pipeline and calls the deploy step in CI.

## License

{{ license }}{% if author %} © {{ author }}{% endif %}
