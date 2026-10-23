# Thunder Fighter local game PoC

This is a complete local game slice built with both repositories:

```text
GameFactory deterministic 3D ships
  -> OhMyGame project_import_asset
  -> Asset Library + Canvas nodes
  -> bundled Three.js game
  -> OhMyGame local preview
  -> browser playtest
```

## Requirements

The target is a short, replayable vertical shooter rather than a content-heavy
campaign. Genre research and the project constraints set these requirements:

- Immediate action: the player starts firing automatically and only has to move.
- Readable vertical lane: the central playfield stays clear; HUD uses compact DOM
  surfaces at the edges.
- Short progression: three waves, escalating enemy density, then a boss.
- Meaningful pickups: weapon levels 1–3, then hull repair or score once maxed.
- Failure and recovery: three lives, invulnerability after damage, pause,
  game-over, victory, and restart.
- Input coverage: keyboard, pointer drag, and touch-compatible pointer events.
- Responsive play: desktop and narrow mobile layouts use the same simulation
  with different camera extents.
- Asset provenance: every ship is a GameFactory GLB imported through OhMyGame's
  host bridge, with SHA-256 recorded before and after import.

## Game systems

- **Player:** CX-9 interceptor, three lives, temporary invulnerability.
- **Weapons:** single shot, twin shot, then triple shot.
- **Enemies:** wave 1 raiders and wave 2 armored raiders; wave 2 enemies fire.
- **Pickups:** one every seven kills; max weapon grants repair or bonus score.
- **Boss:** Dreadnought with 48 HP, moving pattern and spread fire.
- **Scoring:** enemy kills, boss kill, pickups, and persisted local high score.
- **States:** `ready`, `playing`, `paused`, `gameover`, `won`.
- **UI:** compact score/wave/status HUD, boss health strip, transient messages,
  start/pause/end overlays.

## Assets

GameFactory `scripts/thunder_fighter_generate.py` creates three deterministic
hard-surface ships through the no-GPU `spec` route:

| Asset                   | Triangles | Purpose            |
| ----------------------- | --------: | ------------------ |
| CX-9 player interceptor |       372 | Player fighter     |
| VX raider               |       560 | Enemy wave fighter |
| Dreadnought             |       404 | Boss               |

All three specs pass the GameFactory solidity, chirality, scale, budget,
connectivity, provenance, orientation, and winding gates.

## Run

Prepare the OhMyGame host and player build once:

```bash
npx -y bun@1.4.2 install --frozen-lockfile
./node_modules/.bin/tsc -p tsconfig.build.json
node --import tsx scripts/build-story-web.mjs
node node_modules/vite/bin/vite.js build --config vite.player.config.ts
node node_modules/vite/bin/vite.js build --config vite.sandbox.config.ts --outDir dist/player
```

Prepare the isolated GameFactory Python environment:

```bash
python3 -m venv /tmp/gamefactory-poc-venv
/tmp/gamefactory-poc-venv/bin/python -m pip install pillow
```

Start the game:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 22.22.3

GAMEFACTORY_ROOT=/path/to/GameFactory-3A \
GAMEFACTORY_PYTHON=/tmp/gamefactory-poc-venv/bin/python \
OHMYGAME_THUNDER_DATA=/tmp/ohmygame-thunder-fighter \
node --import tsx scripts/thunder-fighter-local.ts
```

Open the printed `previewUrl`. The harness keeps the daemon and preview alive
until Ctrl-C.

## Verification

The local playtest covered:

- first-load assets and enabled start action;
- keyboard movement and pointer drag;
- automatic shooting, kills, score, damage, and high score;
- pickup progression from weapon level 1 to 2 to 3;
- max-level pickup fallback to score bonus;
- pause and resume;
- boss spawn, wave-3 HUD, boss health, and boss defeat;
- game over and restart;
- desktop viewport and 390×844 mobile viewport;
- no runtime console errors after adding an inline favicon.

## Boundaries

- No cloud publishing or authenticated Community flow.
- No remote image/3D provider; ship assets use the deterministic GameFactory
  `spec` path.
- Audio is synthesized in the browser rather than imported as audio assets.
- This is a PoC, not a full content pipeline or live-service game.
