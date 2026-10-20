# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

oxJenga is an interactive AR/VR (WebXR) simulation of DNA/RNA nanostructures. A structure is rendered with three.js, simulated live by a remote oxDNA instance (oxServe), and users pull nucleotides with XR controllers. This repo (`m-matthies/oxJengaC`) is a standalone copy of `Akodiat/oxJenga`; the `upstream` remote points there. It is deployed via GitHub Pages at https://m-matthies.github.io/oxJengaC/.

## Running and linting

The app is built with Vite. There is no test suite.

- `npm run dev`: dev server (`--host`, so headsets on the LAN can reach it). WebXR on a headset needs HTTPS (or localhost).
- `npm run build` → `dist/` (git-ignored). `npm run preview` serves the build.
- `npm run deploy`: builds, then pushes `dist/` to the `gh-pages` branch of `origin` (the `gh-pages` package). GitHub Pages serves that branch, so the site updates a minute or so later.
- `npm run lint`: ESLint 8 with the legacy `.eslintrc`. Style rules: 4-space indent (`case` at the same indent as `switch`), double quotes, semicolons, unix line endings.
- three.js is an npm dependency pinned to 0.161.0; addons are imported as `three/addons/...`.
- `vite.config.js` uses `base: "./"`, so the build works under any path (e.g. GitHub Pages `/oxJenga/`). Static files live in `public/` and are referenced at runtime through `import.meta.env.BASE_URL`.

## Architecture

**Data flow:** `.oxview` JSON → `System` model → oxDNA top/dat strings → oxServe WebSocket → streamed dat frames → interpolated instanced mesh.

- `main.js`: owns all scene state as module-level globals (`scene`, `group`, `system`, `ox_socket`, `forces`). It contains `initSceneFromJSON` (parses oxView JSON into the model and opens the socket), the XR controller handlers (`onSelectStart`/`onSelectEnd`), raycast highlighting with haptics, and the `render()` animation loop.
- `src/system.js`: `System` → `Strand` → `Monomer` (abstract), with subclasses `DNAMonomer`, `RNAMonomer` and `AminoAcidMonomer`. These differ only in `_calcBackbonePos` (the backbone offset from the centre along a1/a2) and `getCategory()`. `System.createViewMesh()` builds one `THREE.InstancedMesh` for every monomer. **The instance index equals the monomer id.**
- `src/file.js`: `makeTopFile`/`makeDatFile` (old-style oxDNA topology and configuration) and `updateStrandsFromDat`.
- `src/oxserve.js`: `OXServeSocket` (a `WebSocket` subclass) connecting to `wss://nanobase.org:8989`. It sends JSON `{settings, top_file, dat_file[, trap_file]}` and sends the string `"abort"` to stop. It receives `{console_log}` and `{dat_file}` messages. `start_simulation` waits for the socket to open if it is still connecting, and includes the current trap file if there is one. `update_forces` aborts the run and restarts it from the latest dat with the new trap file.
- `src/relax_scenarios.js`: oxDNA input settings for DNA2 and RNA2 (CUDA MD). The scenario is chosen from the category of the first monomer. Amino acids (`AA`) have no scenario: the constructor warns and returns early.

### Invariants that span files

- **Monomer ordering / ids:** oxView strands list monomers 5'→3'. The top and dat writers reverse each strand (3'→5', the old oxDNA convention). `updateStrandsFromDat` maps dat line `i` directly to the element with id `i - 3`. So monomer ids must be contiguous and must match that reversed, strand-by-strand order. Mismatched id schemes are not handled (`initSceneFromJSON` throws on duplicates). Topology strand ids are `strand.id + 1`.
- **Positions are double-buffered:** each new dat frame sets `monomer.position = targetPosition; targetPosition = new`. `render()` lerps the instance matrices toward `getTargetBackbonePos()`, estimating frames per simulation step from `stepCounter` and `frameCounter`. `System.idCounter` is the highest id in use (not the count), so loops over ids must run `<= idCounter`. The mesh's bounding sphere is recomputed every frame because three.js raycasting culls against the cached sphere.
- **Coordinate spaces:** the oxDNA coordinates live in the local space of `system.instancedMesh`, which is offset by `-box/2` and sits inside `group`. `group` is scaled to `targetScale` (1/50). On XR session start the scale is shrunk to near zero and then lerped back up, which gives a zoom-in effect. Controller positions are turned into trap targets with `system.instancedMesh.worldToLocal`.
- **Forces:** `forces` is a `Map` from controller to `{coneMesh, target, oxDNATarget, nucId}`. Each pull becomes an oxDNA `type = trap` block (stiff 0.1) in the trap file string built in `onSelectStart`. The "tractor beam" cone is repositioned every frame in `render()`.

### Designs

The `.oxview` files live in `public/resources/`. The active set is the `designs` array in the `DesignStorage` class inside `init()` in `main.js`. The first entry (`monohole_1b.oxview`) is loaded on startup, and the others are commented out. To add a design, put the file in `public/resources/` and list it there. Dropping a `.dat` file onto the page updates the current positions.
