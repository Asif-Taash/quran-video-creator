# Notes for coding agents

- Next.js is **14.2.3** (App Router, `route.ts` handlers, `params` as a plain object) with React 18 and Remotion 4. Follow the patterns already in `src/app/api/`.
- `node_modules` lives only inside the frontend container, so run tooling there: `docker compose exec frontend npx tsc --noEmit` is the check (ESLint isn't configured).
- `src/remotion/` must only import from itself, `remotion` and `react`: the server bundles that folder on its own for every export.
