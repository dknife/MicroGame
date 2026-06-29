# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Pandora** — a browser 3D puzzle game (Korean UI). Open an n×n grid of lidded boxes and find every hidden gem. Same constraint structure as LinkedIn's Queens puzzle: exactly one gem per row, per column, and per color region, and no two gems may touch (including diagonally). Every board has a unique solution, so it is always solvable by logic alone.

Rendered with Three.js (WebGL). Each cell is a 3D box with a hinged lid; double-tapping a box opens the lid to reveal a glowing faceted gem (correct) or sinks the box and emits colored smoke (wrong). Three wrong opens ends the run. Grid grows from 5×5 to 12×12, one row/col per level.

Naming note: the target cards are called "diamonds" throughout the logic (`diamondCols`, `isDiamond`, `generateDiamonds`) and the per-cell mark state is `'paw'` — both are legacy names from an earlier 2D cat-themed version (myMeowDoku). The localStorage key is also still `myMeowDoku.save` (kept intentionally so existing players don't lose progress). The theme is now 3D gems; the internal names were left to avoid churn.

## Running

No build step. Uses ES modules, so it must be served over HTTP (opening `index.html` as `file://` blocks module loading). Serve the folder and open it:

```
python3 -m http.server   # then visit http://localhost:8000
```

Three.js ships vendored at `vendor/three.module.js` — no network or build needed. The only runtime asset is `skybox/diamond.jpg` (gem color/reflection map); the background sky and all metal/smoke textures are generated procedurally at runtime.

There is no test framework. Game-logic invariants can be checked by extracting the pure generation functions from `game.js` (everything above `function makeBoard`, no DOM dependencies) and running them in Node.

## Architecture

Two JS modules plus a static shell, all vanilla:

- `game.js` — all game state, logic, board generation, and Web Audio SFX. Owns the source of truth; knows nothing about Three.js. Module-level state: `level`, `size`, `board` (`{ diamondCols[r], regions[r][c] }`), `cells[r][c]` (`{ revealed, mark }`), `mistakes`, `locked`. Delegates all drawing/input to the renderer through four callbacks.
- `render3d.js` — the Three.js renderer + all pointer input. Builds the box scene, runs the animation loop, and translates pointer gestures into `(r, c)` callbacks. Holds its own `REGION_COLORS` (single source of color truth — `game.js` needs no colors).
- `index.html` / `style.css` — static shell: header HUD, `#board` canvas host, help boxes, overlay, win banner.

### game.js ↔ render3d.js contract

`game.js` calls `initRenderer(host, { onDown, onEnter, onUp, onTap })` once, then drives the view with:

- `buildBoard(size, board)` — rebuild the 3D box scene when the board changes (disposes the previous scene's geometries/materials/textures, except shared procedural textures).
- `syncState({ size, board, cells, flashing })` — called from `render()` every state change; the renderer diffs against its per-box state and fires animations (lid open, gem rise, box sink, smoke, mark redraw). It does **not** rebuild the scene.
- `shake()` / `celebrate()` — board shake on a wrong open; after a level clear, `celebrate()` starts both a slow camera orbit and a gem ring: all revealed gems lift above the board and gather into a rotating circular ring (`startGemRing` / the `ringActive` block in `animate`, in board-local coords so it tracks board transforms), each still spinning freely. A subset of ring gems (capped at `MAX_CAUSTICS`, spread evenly to stay under the shader's spot-light-coord varying limit) also projects a faked **caustic** onto the boxes below: a downward `SpotLight` per gem uses the procedural `causticTexture` filament web as its `.map` cookie (gobo), so the light drapes the moving pattern over the box surfaces. The cookie is a soft `blur`-ed light web drawn in several spectrum-colored passes that are progressively offset along one axis (prism dispersion, additive) so its blurred streaks get a smooth iridescent halo, and the spotlight color is kept near-white (only a hint of the gem color) so that iridescence reads (no shadows; the cone falloff is the circular mask). Each spotlight follows its gem's xz, fades in with the ring, flickers in intensity, and rotates its cookie by spinning `shadow.camera.up`. While the ring is active the scene also **blacks out** (`celebDark` ramps 0→1): the three analytic lights (`hemiLight`/`ambLight`/`dirLight`) fade to ~0 and the box surface materials' `envMapIntensity` is scaled down (`dimMats`, collected in `startGemRing`, excludes each gem's own material), so the boxes are lit only by the gems' own `PointLight`s and the caustic spotlights — a dark display where the caustics make the boxes glow. The ring keeps rotating even after the camera orbit is dismissed by a touch; the ring, caustic spotlights, and blackout all reset on `buildBoard` (`clearCaustics`, and the analytic lights are restored there).

The renderer reports input back through the callbacks: `onDown(r,c)` (long-press → start mark drag), `onEnter(r,c)` (drag entered a cell), `onUp()` (gesture end), `onTap(r,c)` (a tap, for double-tap detection).

## Key design points

- **Board generation** (`generateDiamonds` + `generateRegions`): row-by-row backtracking places one diamond per row (column unused, consecutive rows differ by ≥2 columns — sufficient for the 8-neighbor rule given one diamond per row). Regions grow by random multi-source flood-fill seeded at each diamond, guaranteeing exactly one diamond per region and region connectivity. Two regions per board are capped at 1–2 cells (easy entry points); if capping walls off unfillable cells, `tryGenerateRegions` returns null and `generateRegions` retries.
- **Unique-solution guarantee**: every board has exactly one valid placement → solvable by logic alone, no forced guessing. Naive regenerate-until-unique fails above 10×10 (unique layouts become vanishingly rare), so `createBoardJob` uses repair-based convergence: `findSolutions` (backtracking solver, early-exit at 2) finds an alternative solution, and `repairOnce` kills it by reassigning one cell the alternative uses to a neighboring region (never an intended diamond cell; connectivity checked via `connectedWithout`, preferring targets of size ≥3 to keep the small easy regions small). After `MAX_REPAIRS` or an unfixable state it regenerates from scratch.
- **Generation never blocks gameplay**: `prepareNextBoard` runs the next level's board job in small `setTimeout` slices (one solver step each) while the player plays; `newBoard` uses the prepared board when ready, falling back to synchronous `makeBoard`. `prepareToken` cancels stale background jobs. On load the saved board is restored from localStorage, so no generation happens at startup.
- **Click vs double-click**: the renderer only reports taps via `onTap`. `onCellClick` defers each tap by `DBLCLICK_DELAY` (250ms); two taps on the same cell within the window = double-click (`doubleClick` → open box). A pending tap on a *different* cell is committed immediately. `singleClick` is a deliberate no-op (single tap does nothing) — marking is long-press-drag, opening is double-tap.
- **Input gestures** (all in render3d.js `bindPointer`): single-pointer drag = camera orbit; long-press (`LONG_PRESS_MS` 400ms) then drag = mark; two pointers = pinch zoom; wheel = zoom; right-drag = always orbit. Releasing an orbit with enough velocity starts inertial spin (continues until the next touch). `MOVE_THRESH2` (8px²) converts a pending press into an orbit and cancels the long-press.
- **Drag-marking**: `startDrag` fixes the mode from the start cell (`'paw'` ↔ `'none'`), then `onCellEnter`/`applyDragMark` applies it to every cell entered (skipping revealed/`'wrong'` cells), playing a pop per change. After a real drag, `suppressClick` swallows the trailing tap so the start cell isn't toggled twice.
- **Mark states**: `'none' | 'paw' | 'wrong'`. `'paw'` is the user/auto "no gem here" mark, drawn on the lid as an X in the region's complementary color (revealing a gem auto-marks its row, column, and 8 neighbors). `'wrong'` is the red mistake state from opening an empty box — it cannot be cleared and 3 of them ends the game.
- **Sound**: all SFX synthesized with Web Audio (`playPop`/`playChime`/`playFanfare`/`playWarning`) — no audio files. The AudioContext is created/resumed by a one-time `pointerdown`/`mousedown`/`touchstart` listener because iOS only allows audio to start inside a user gesture and the tap path runs in a `setTimeout`. Auto-marks after a reveal are silent (only the reveal chime plays).
- **`locked` flag** gates all input during the mistake animation (box flashes ~800ms, board shakes, then the red mark lands) and while an overlay is up. `flashing` holds the cell being briefly shown.
- **Game flow**: Restart (`↺`) replays the *same* board (`resetRound` keeps `board`, resets `cells`/`mistakes`). Clearing a level → win banner → `bannerBtn` advances `level`/`size` and `newBoard()` generates a fresh board. The reset button restarts from level 1. Grid grows by 1 per level from 5×5, capped at 12×12 (`MAX_SIZE`).
- **Persistence**: `saveProgress` stores `{ level, diamondCols, regions }` as JSON in localStorage (`myMeowDoku.save`) on every `newBoard`; `startGame` restores it (with shape validation) so the player resumes at their last level with the same board. Mid-level marks are not saved.

## Rendering / Three.js notes

- **Procedural everything**: `buildProceduralSky` paints a seamless equirectangular nebula canvas → both a rotating `BackSide` sky sphere and (via `PMREMGenerator`) the scene reflection environment. `scratchTexture`/`metalNormalTexture`/`smokeTexture`/`starTexture` are cached singletons; box materials clone the shared texture with randomized rotation/repeat so each box shows a distinct scratch pattern without extra image memory.
- **Gems** are a single round-brilliant-cut `BufferGeometry` (`brilliantCutGeometry`: table + crown bezel/star facets + scalloped girdle + pavilion facets converging to a culet point, 8-fold) with `flatShading` so every triangle reads as a distinct facet, a double-sided `MeshPhysicalMaterial` (transmission/IOR for glass refraction), white edge `LineSegments` built from the same geometry via `EdgesGeometry`, a `PointLight` that pulses, and additive sparkle sprites. `loadDiamond` asynchronously applies `skybox/diamond.jpg` as the gem color map + a dedicated reflection env once loaded.
- **Animation loop** (`animate`) is paused on blur/`visibilitychange` to save CPU/GPU and resumes on focus (discarding accumulated delta). It drives the orbiting key light, sky rotation, inertial camera spin, celebrate orbit, lid open/close tweens, sink/rise tweens, gem spin/glow/sparkle, smoke emitters, and board shake.
- **Performance caution**: unique-board generation cost grows steeply with size (15×15 was abandoned). Raising `MAX_SIZE` requires extending `REGION_COLORS` in render3d.js (currently 12 entries, one per region at max size) and re-checking generation time.
