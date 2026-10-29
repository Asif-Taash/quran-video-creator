# Frontend

Next.js 14 app + Remotion video composition. See the [project README](../README.md) for setup.

- `src/remotion/` is the video itself, rendered both in the browser (live preview, `@remotion/player`) and on the server (`src/app/api/video/render/route.ts`, `@remotion/renderer`). Its props come from the same route, so preview and export can't drift apart.
- Type-check (there's no lint setup): `docker compose exec frontend npx tsc --noEmit`
