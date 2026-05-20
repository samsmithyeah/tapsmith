# Tapsmith Website

The [tapsmith.dev](https://tapsmith.dev) documentation site. Built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build).

## Development

```bash
cd website
npm ci
npm run dev       # http://localhost:4321
```

## Doc sync

Documentation lives in `docs/` at the repo root. The sync script copies it into the website at build time:

```bash
npm run sync-docs
```

This runs automatically as part of `npm run dev` and `npm run build`. Do not edit files in `src/content/docs/` directly — they are gitignored and regenerated on every build.

## Scripts

| Command                | Action                                     |
| :--------------------- | :----------------------------------------- |
| `npm run dev`          | Start dev server (syncs docs first)        |
| `npm run build`        | Production build (sync + build + validate) |
| `npm run typecheck`    | TypeScript checking                        |
| `npm run lint`         | ESLint                                     |
| `npm run format`       | Prettier (write)                           |
| `npm run format:check` | Prettier (check only)                      |
| `npm run knip`         | Unused code detection                      |

## Deployment

Deployed to Cloudflare Pages automatically on `v*` tag push. Can also be triggered manually via the "Deploy Website" workflow in GitHub Actions.
