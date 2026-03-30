# Agent / contributor map

## What this is

Angular 19 (standalone) shell with a Babylon.js + Ammo.js physics scene for a single-player cornhole practice mode. The bag uses an Ammo soft body (`PhysicsImpostor.SoftbodyImpostor`); ground and board use static rigid bodies. The browser loads `public/ammo.js` (Babylon CDN build) via `index.html` before the app bundle. The 3D loop runs outside Angular's zone; state updates (`GameStateService`) run inside `NgZone.run` when scoring settles.

## Commands

- `npm start` — dev server (`ng serve`)
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm test` — Karma + Jasmine (Chrome)

## Where things live

- `src/app/game/cornhole-scene.service.ts` — Babylon `Engine` / `Scene`, Ammo physics, board frame colliders, soft-body bag, pointer throw
- `src/app/game/game-state.service.ts` — score, throws per round, round counter, HUD-facing messages
- `src/app/game/game-canvas.component.*` — `<canvas>` host, lifecycle `init`/`dispose` for the scene service
- `src/app/game/cornhole-constants.ts` — board/bag dimensions in meters

## Conventions

- Dispose the Babylon engine in `ngOnDestroy` of `GameCanvasComponent` (via `CornholeSceneService.dispose()`).
- Keep gameplay rules and scoring in Angular services; keep mesh/physics in the scene service.

## Secrets

None required for this client-only app. Do not commit API keys or `.env` files with secrets.

## GitHub

Create an empty repository on GitHub, then from this folder:

`git remote add origin https://github.com/<user>/<repo>.git`

`git push -u origin main`

Replace local `user.name` / `user.email` if you prefer your Git identity over the repo-only placeholder used for the initial commit.
