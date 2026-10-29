# Frontend

Next.js 14 app + Remotion video composition. See the [project README](../README.md) for setup.

- `src/remotion/` is the video itself, rendered both in the browser (live preview, `@remotion/player`) and on the server (`src/app/api/video/render/route.ts`, `@remotion/renderer`). Its props come from the same route, so preview and export can't drift apart.
- Type-check (there's no lint setup): `docker compose exec frontend npx tsc --noEmit`
- `node_modules` is installed inside the image; the container uses its own copy. For the editor's type information on the host (otherwise every JSX tag shows "JSX.IntrinsicElements" errors), copy it out once, and again after changing `package.json` and rebuilding:
  ```bash
  docker run --rm -v "$PWD/node_modules":/host-nm --entrypoint sh quran-video-creator-main-frontend \
    -c 'cp -a /app/node_modules/. /host-nm/ && chown -R '"$(id -u):$(id -g)"' /host-nm'
  ```
