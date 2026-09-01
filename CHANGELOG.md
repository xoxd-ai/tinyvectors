# Changelog

> **Distribution note (2026-07-25):** the npm channel is retired. npm
> publishes stop at 0.3.0; 0.3.1+ ship as git tags + entries in
> [tinyland-inc/bazel-registry](https://github.com/tinyland-inc/bazel-registry)
> only. See the README's Install section for the sanctioned consumption paths.

## 0.3.7 - 2026-09-01

- Idle drift cruise: `updateScreensaverPhysics` now steers each blob's velocity toward its own `driftAngle`/`driftSpeed` heading every substep (`DRIFT_CRUISE_STEERING = 0.05`, target speed `driftSpeed * 3`). Both fields were initialized per blob since the pre-Phase-A baseline but never read by the loop, so with no pointer, scroll, or device-motion input the only idle motion was a zero-mean jitter random walk that the `*= 0.992` damping erased in ~1.4s — blobs jiggled near their territory instead of drifting. The settled cruise (~1.5-3.9 units/s in the -40..140 physics space) delivers the "idle blobs drift" baseline of `docs/physics-feel-contract.md` on every environment, with no permission grant or sensor required; the existing re-heading roll (~every 8s) and the wall-bounce re-randomization keep paths wandering rather than ballistic, and pointer/scroll/gravity fields still bias motion on top exactly as before. Deterministic seeded runs measure idle mean net displacement rising from ~4.3-5.0 to ~16.4-25.5 units over 12s, peak speeds bounded near 0.15 units/substep across 300 simulated seconds; a headed-Chrome A/B probe of the built package measures the net/path coherence of idle motion rising from ~0.5-0.64 (decorrelating jitter) to ~0.72-0.81 (directed travel) at 60fps, and a `reducedMotion: 'reduce'` context still renders a fully frozen frame (0 of 15 paths move) (`tests/unit/blob-physics-idle-drift.test.ts`).
- `TinyVectors`' rAF frame-delta clamp is raised from `0.033`s to `8/60`s to match `BlobPhysics.tick()`'s own catch-up ceiling (8 substeps of 1/60s, added in 0.3.6). The old clamp pre-empted the engine's fixed-timestep accumulator: any sustained render rate below 30fps (software raster, heavy blur scenes on hiDPI displays) dilated simulated time proportionally (~3x slower motion at 11fps). Now sustained rendering down to ~7.5fps keeps real-time motion speed; a backgrounded-tab resume is still bounded by the same engine substep cap.

## 0.3.6 - 2026-07-25

- Adds a `respectReducedMotion?: boolean` prop (default `true`) to `TinyVectors`: when `(prefers-reduced-motion: reduce)` matches, the component renders the existing static single frame (the same path `animated={false}` already uses) instead of running the rAF loop, and switches live if the media query changes. Pass `respectReducedMotion={false}` to animate regardless (TIN-3170).
- Pauses the rAF loop when the document is hidden (`visibilitychange`) or the container scrolls out of the viewport (`IntersectionObserver`, threshold `0`, `rootMargin: '10%'`), and resumes cleanly — `startAnimation()` already resets its frame-delta clock on resume, so there is no jump. Fully SSR-guarded; no visual change while the component is actually visible (TIN-3168).
- Fixed-timestep physics: `BlobPhysics.tick()` keeps its public `(deltaTime, time)` signature, but now accumulates the caller's variable per-frame `deltaTime` and steps the simulation in fixed `1/60`s quanta (capped at 8 substeps per call), instead of integrating directly on the raw frame delta. Feel and damping previously scaled with the caller's refresh rate (~2x faster/more-damped at 120Hz, half speed at 30Hz); coefficients are unchanged, only the stepping cadence is new. Concretely: pre-0.3.6, a 120Hz display ran physics roughly 2x too fast, so the 0.3.6 feel change on non-60Hz displays is the **correction** toward refresh-rate independence documented in `docs/physics-feel-contract.md`, not a regression — 60Hz displays, the common baseline, see no feel change (TIN-853).
- `BlobPhysics.tick()`'s `time` argument is now ignored; phase math runs on an internal fixed-step clock.
- `tick()` now guards against a non-finite `deltaTime` (e.g. `NaN` from a corrupt rAF timestamp): it is coerced to `0` instead of poisoning the fixed-timestep accumulator, which previously would have propagated `NaN` forever and frozen physics on every subsequent call.
- The internal simulation clock now seeds to a random `[0, 45)` offset at construction instead of starting at exactly `0`, restoring 0.3.5's stochastic mount phase so the ~45s territory reshuffle doesn't fire at the same deterministic offset on every mount. Seeded-RNG unit tests re-seed `Math.random()` immediately before constructing `BlobPhysics`, so coverage stays fully deterministic.
- `scripts/check-release-metadata.mjs` now requires a `## <version>` heading to exist anywhere in `CHANGELOG.md` (tolerating a `## Unreleased` heading on top) instead of requiring the *first* `## ` heading to equal the version; a changelog with no `## ` heading at all now fails with the same tidy mismatch message as every other check instead of throwing an uncaught exception (TIN-3171).
- Bundle size: `dist/index.js`'s gzip size grows from 11.19 KiB (0.3.5) to 11.73 KiB in this release — 0.27 KiB of headroom remains under the 12 KiB gate. `DeviceMotion`'s lazy-load is the named next reclaim lever if headroom needs recovering.
- **Known issue:** the static frame does not repaint when `theme`/`colors` change while the component is not animating (e.g. `animated={false}`, reduced motion, hidden/off-screen tab) — the frozen frame keeps whatever colors were current the last time it rendered. Pre-existing, not introduced by this release; left unfixed here.

## 0.3.5 - 2026-07-25

- Fixes hermetic Bazel/RBE builds (TIN-2099): `npm_translate_lock` now sets `lifecycle_hooks = {"esbuild": []}` so rules_js no longer runs esbuild's `node install.js` postinstall as a build action, which failed under strict sandbox/worker strategies (network blocked, platform package absent from inputs). Safe because vite drives esbuild through its JS API, whose bin-path resolution falls back to `require.resolve('@esbuild/<platform>/bin/esbuild')` at runtime, and `pnpm-lock.yaml` pins every `@esbuild/*` platform package.
- Multi-signal dark detection: `isDarkMode()`/`watchDarkMode()` and `BlobSVG`'s blend switch now recognize a `.dark` root class, Skeleton v4's `data-mode="dark"` attribute, or a `color-scheme: dark` computed on the root element; `watchDarkMode()` observes both `class` and `data-mode` mutations and `prefers-color-scheme` changes. Previously the dark blend never engaged on Skeleton v4 consumers, which signal dark via `data-mode="dark"`, not a `.dark` class. Existing `.dark`-class consumers are unchanged.
- Adds an `isDark?: boolean | null` prop (default `null` = auto-detect) to `TinyVectors` and `BlobSVG`; a boolean overrides detection entirely. Adds the `resolveDark()` helper to the themes surface.
- `themes/css` (`vector-colors.css`): dark overrides now also match `[data-mode='dark']`, corrects the header comment that claimed Skeleton toggles a `.dark` class, and ships a `--tv-blend` seam (`multiply` in light, `screen` in dark) under both selector families.

## 0.3.4 - 2026-07-05

- Fixes the root `"."` export's `svelte` condition to point at the full root barrel (`./dist/index.js`) instead of the components-only `./dist/svelte/index.js`. The two conditions exposed divergent API surfaces on the same specifier: bundlers resolving with the `svelte` condition (Vite consumers) could not see root-barrel exports like `getThemeCatalog`, breaking `@tummycrypt/tinyland-stores`' theme catalog import in consumer graphs. The root barrel is a strict superset (it re-exports `TinyVectors`/`BlobSVG`), and components ship pre-compiled `.js`, so no raw-svelte resolution is lost. The `./svelte` subpath is unchanged.

## 0.3.3 - 2026-07-05

- Makes the Bazel vite build CWD-independent (same pattern as the 0.3.2 build-declarations fix): `tinyvectors_build` now runs through `scripts/build-vite.mjs`, which anchors cwd to the package root so `dist/` materializes correctly when the package builds as an external Bazel module (previously the declared `dist/` TreeArtifact shipped empty in consumer graphs, breaking SSR imports of `@tummycrypt/tinyvectors`).

## 0.3.2 - 2026-06-15

- Makes the Bazel declarations build CWD-independent: `tinyvectors_declarations` runs through `scripts/build-declarations.mjs`, which anchors cwd to the package root so `dist-types/` materializes correctly when the package builds as an external Bazel module.

## 0.3.1 - 2026-05-31

- Adds `getThemeCatalog()` and `getThemeCatalogEntry()` (with `getThemePreviewColors()`/`getThemeVectorColors()`) so the package is the single source of truth for which themes ship and how they preview; hub/spoke consumers such as `@tummycrypt/tinyland-stores` render this catalog (TIN-1746).
- CI: moves the package lane to a repo-owned runner and onto the Node 24 reusable package workflow.

## 0.3.0 - 2026-05-01

- Restores the pre-Phase-A gel/blob feel while keeping gravity-led motion, ambient movement, and safer smoothing.
- Adds device-motion status, permission, calibration, idle reset, reduced-motion, and Chrome/CDP browser harness coverage.
- Adds pointer and scroll lifecycle cleanup, stale IO reset behavior, pointer velocity coverage, and a conservative local pointer field.
- Hardens the package release surface with explicit exports, Bazel-built package validation, bundle-size checks, and consumer-package checks.
- Keeps the release bundle under the 12 KiB gzip gate while documenting the remaining 11 KiB target pressure.
