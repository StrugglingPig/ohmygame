# GameFactory local integration PoC

This end-to-end check uses the deterministic GameFactory `3d_object` spec route,
so it needs no GPU, cloud model, or provider key. It generates a real GLB,
imports it through OhMyGame's `project_import_asset` host tool, verifies the
Library and Canvas records, then serves a local Web preview that loads the GLB
with `model-viewer`.

## What it exercises

```text
GameFactory spec generator
  -> plugin-data job artifact
  -> OhMyGame external MCP session
  -> project_import_asset
  -> project workspace + Asset Library + Canvas Asset node
  -> OhMyGame local preview
  -> model-viewer GLB load
```

## Prerequisites

- Node.js 22.22 is recommended for the daemon runtime.
- Bun 1.4.2 is the repository's package manager.
- A GameFactory-3A checkout with its Python entry points.
- A Python environment with Pillow. The deterministic spec route uses the
  standard library; Pillow is imported by the 3D operator module.

```bash
python3 -m venv /tmp/gamefactory-poc-venv
/tmp/gamefactory-poc-venv/bin/python -m pip install pillow
```

Build the OhMyGame host and player once before running the PoC:

```bash
npx -y bun@1.4.2 install --frozen-lockfile
./node_modules/.bin/tsc -p tsconfig.build.json
node --import tsx scripts/build-story-web.mjs
node node_modules/vite/bin/vite.js build --config vite.player.config.ts
node node_modules/vite/bin/vite.js build --config vite.sandbox.config.ts --outDir dist/player
```

## Run

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 22.22.3

GAMEFACTORY_ROOT=/path/to/GameFactory-3A \
GAMEFACTORY_PYTHON=/tmp/gamefactory-poc-venv/bin/python \
OHMYGAME_POC_DATA=/tmp/ohmygame-gamefactory-poc \
node --import tsx scripts/gamefactory-local-poc.ts
```

The command prints a state object containing:

- the generated GLB path and SHA-256;
- the OhMyGame project and workspace;
- the imported Library asset ID and Canvas node;
- the local preview and GLB URLs.

It keeps the daemon and preview running until Ctrl-C. Open the printed
`previewUrl`; the footer must say `GLB loaded and rendered.` The page records
`data-model-loaded="true"` after `model-viewer` finishes loading the GLB.

## Current boundary

This PoC verifies generation, host import, Library registration, Canvas
registration, local preview serving, and browser rendering. It does not publish
to the OhMyGame cloud, run an authenticated game session, or exercise a remote
3D provider. Those remain separate integration gates.
