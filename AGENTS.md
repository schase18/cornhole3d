# Agent / contributor map

## What this is

Angular 19 (standalone) shell with a Babylon.js + Cannon physics scene for a single-player cornhole practice mode. The 3D loop runs outside Angular’s zone; state updates (`GameStateService`) run inside `NgZone.run` when scoring settles.

## Commands

- `npm start` — dev server (`ng serve`)
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm test` — Karma + Jasmine (Chrome)

## Where things live

- `src/app/game/cornhole-scene.service.ts` — Babylon `Engine` / `Scene`, physics, board frame colliders, bag, pointer throw
- `src/app/game/game-state.service.ts` — score, throws per round, round counter, HUD-facing messages
- `src/app/game/game-canvas.component.*` — `<canvas>` host, lifecycle `init`/`dispose` for the scene service
- `src/app/game/cornhole-constants.ts` — board/bag dimensions in meters

## Conventions

- Dispose the Babylon engine in `ngOnDestroy` of `GameCanvasComponent` (via `CornholeSceneService.dispose()`).
- Keep gameplay rules and scoring in Angular services; keep mesh/physics in the scene service.

## Secrets

None required for this client-only app. Do not commit API keys or `.env` files with secrets.
