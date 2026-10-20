# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

oxJenga is an interactive AR/VR (WebXR) simulation of DNA/RNA nanostructures. A structure is rendered with three.js, simulated live by a remote oxDNA instance (oxServe), and users pull nucleotides with XR controllers. This repo (`m-matthies/oxJengaC`) is a standalone copy of `Akodiat/oxJenga`; the `upstream` remote points there. It is deployed via GitHub Pages at https://m-matthies.github.io/oxJengaC/.

## Running and linting

The app is built with Vite. There is no test suite.

- `npm run dev`: dev server (`--host`, so headsets on the LAN can reach it).
- `npm run dev:https`: the same over HTTPS with a self-signed certificate (`@vitejs/plugin-basic-ssl`, enabled by `--mode https` in `vite.config.js`). Use it for headsets, because WebXR needs a secure origin; accept the certificate warning once in the headset browser.
- `npm run build` → `dist/` (git-ignored). `npm run preview` serves the build.
- `npm run deploy`: builds, then pushes `dist/` to the `gh-pages` branch of `origin` (the `gh-pages` package). GitHub Pages serves that branch, so the site updates a minute or so later.
- `npm run lint`: ESLint 8 with the legacy `.eslintrc`. Style rules: 4-space indent (`case` at the same indent as `switch`), double quotes, semicolons, unix line endings.
- three.js is an npm dependency pinned to 0.186.1; addons are imported as `three/addons/...`.
- `vite.config.js` uses `base: "./"`, so the build works under any path (e.g. GitHub Pages `/oxJenga/`). Static files live in `public/` and are referenced at runtime through `import.meta.env.BASE_URL`.

## Architecture

**Data flow:** `.oxview` JSON → `System` model → oxDNA top/dat strings → oxServe WebSocket → streamed dat frames → interpolated instanced mesh.

- `main.js`: owns all scene state as module-level globals (`scene`, `group`, `system`, `ox_socket`, `forces`). It contains `initSceneFromJSON` (parses oxView JSON into the model and opens the socket), the XR controller handlers (`onSelectStart`/`onSelectEnd`), hover highlighting with haptics (only while `renderer.xr.isPresenting`), and the `render()` animation loop (registered once with `setAnimationLoop`).
- `src/system.js`: `System` → `Strand` → `Monomer` (abstract), with subclasses `DNAMonomer`, `RNAMonomer` and `AminoAcidMonomer`. These differ only in `getBackboneOffset()` (the backbone offset from the centre along a1/a2) and `getCategory()`. `System` also owns the whole view side: `createViewMesh()`, `setTargetsFromDat()`, `updateView()`, `pick()` and `setHighlighted()`. **Everything on the view/simulation side uses the element `index`, not the oxView `id`** (see below).
- `src/file.js`: `makeTopFile`/`makeDatFile` (old-style oxDNA topology and configuration) and `updateStrandsFromDat`, which just calls `system.setTargetsFromDat`.
- `src/oxserve.js`: `OXServeSocket` (a `WebSocket` subclass) connecting to `wss://nanobase.org:8989`. Incoming messages (around 5 MB per frame for flippy) are forwarded unparsed to `src/datWorker.js`. The worker runs `JSON.parse` and the dat parsing (`src/datParser.js`, shared with the main thread's `setTargetsFromDat` for dropped files) and transfers a `Float32Array` of targets back. The main thread copies it in with `system.setTargets()` and hands the array back to the worker for reuse. It sends JSON `{settings, top_file, dat_file[, trap_file]}` and sends the string `"abort"` to stop. It receives `{console_log}` and `{dat_file}` messages. `start_simulation` waits for the socket to open if it is still connecting, and includes the current trap file if there is one. `update_forces` aborts the run and restarts it from the latest dat with the new trap file.
- `src/relax_scenarios.js`: oxDNA input settings for DNA2 and RNA2 (CUDA MD). The scenario is chosen from the category of the first monomer. Amino acids (`AA`) have no scenario: the constructor warns and returns early.

### Invariants that span files

- **Ids vs indices:** oxView ids can be sparse and in any order (flippy's 19,159 nucleotides have ids up to 31041), so they are only used to look up elements while loading (`system.elements`). `System.assignIndices()` must run after loading and before `createViewMesh()`/`makeTopFile()`. It gives each element a dense `index` in oxDNA order: strand by strand, each strand reversed from oxView's 5'→3' order to 3'→5'. That index is the line in the top/dat files, the topology's neighbour references, the oxDNA particle index of trap forces, the mesh instance index, and the position in `system.monomersByIndex`. `pick()` returns it as `hit.index`. Topology strand numbers are the strand's position in `system.strands` + 1. Circular strands (such as flippy's scaffold) work because neighbours are explicit indices.
- **View state lives in typed arrays, not on `Monomer`s.** After `createViewMesh()`, `Monomer.position`/`a1`/`a3` hold the *initial* structure (used for the top/dat sent to oxServe) and are never updated. The displayed backbone positions are the translation part (offset 12) of each 16-float matrix in `instancedMesh.instanceMatrix.array`. `system.targets` (3 floats per index) holds the latest frame's backbone positions. The instance count is the number of elements.
- **Hot paths avoid allocation:** `parseDatTargets` (in `datParser.js`) parses numbers straight from the string's character codes (no `split`, no substrings). It computes the backbone position from the frame's own a1/a3. `updateView` moves each bead linearly in time toward its target over 1.2× the moving-average frame interval. It does nothing once settled, and it refreshes the bounding sphere used for frustum culling. `pick` is an analytical ray–sphere test on the bead centres; it replaces three's per-instance `InstancedMesh.raycast`. Hover colour changes upload only the affected instance via `addUpdateRange`. Keep new per-frame code in this style: module-level scratch objects, no `new` inside `render()`.
- **Coordinate spaces:** the oxDNA coordinates live in the local space of `system.instancedMesh`, which is offset by `-box/2` and sits inside `group`. `group` is scaled to `targetScale` (1/50). On XR session start the scale is shrunk to near zero and then lerped back up, which gives a zoom-in effect. Controller positions are turned into trap targets with `system.instancedMesh.worldToLocal`.
- **Forces:** `forces` is a `Map` from controller to `{target, oxDNATarget, nucId}`. Each pull becomes an oxDNA `type = trap` block (stiff 0.1) in the trap file string built in `onSelectStart`. Each controller has one reusable "tractor beam" cone (`controller.userData.cone`), which is shown or hidden and repositioned every frame by `updateCones()`.

### Designs

The `.oxview` files live in `public/resources/`. The active set is the `designs` array in the `DesignStorage` class inside `init()` in `main.js`. The first entry (`flippy.oxview`, 19,159 nt) is loaded on startup, and the others are commented out. The box in each `.oxview` file is what gets simulated and drawn: flippy's was set to 250 (its original was 5000). To add a design, put the file in `public/resources/` and list it there. Dropping a `.dat` file onto the page updates the current positions.
