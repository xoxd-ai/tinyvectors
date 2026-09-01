# TinyVectors Physics Feel Contract

TinyVectors is an expressive background system for Svelte and SvelteKit apps, not a physics demo. The animation should feel alive before any user input happens. Device motion, pointer movement, and scrolling should bias that ambient motion instead of taking control of it.

This document is the local source of truth for the field-based interaction work tracked in Linear `TIN-853` and GitHub #40.

## Product Intent

- Pleasant by default: idle blobs drift, breathe, and deform subtly.
- App-safe: the component stays SSR-safe, reduced-motion aware, listener-clean, and small enough for background use.
- Stylable: gel/fluid is a visual language exposed through themes, colors, opacity, and restrained renderer controls.
- Performant: interaction work must preserve the package's bundle budget and avoid heavyweight simulation dependencies.

## Interaction Model

Every input should become a small field sampled by the blob physics loop:

- Ambient field: always on, low-frequency, bounded motion. This is the baseline feel.
- Gravity field: slow directional bias from device orientation. It should make blobs lean or pool, not fall like marbles.
- Pointer field: local soft influence around the pointer. Nearby blobs should react more than distant blobs.
- Scroll field: transient impulse or stickiness that decays. It should not create permanent acceleration.
- Wall field: bounds should keep the background composed without hard visual snaps.
- Input liveness: real sensor and pointer IO should auto-enable only when available. If device-orientation events go quiet, the tab is hidden, pointer input is canceled, the pointer leaves the viewport, or the window blurs, the field must return to neutral instead of preserving stale input.

Fields may combine, but input fields must not erase the ambient field. If a field makes the background look frozen, jittery, or overly coherent, it violates the contract.

## Non-Goals

- Do not revive the Phase A XSPH, soft-wall, and Gaussian anti-clustering rewrite as-is.
- Do not ship coefficient-only tuning without a contract and browser/demo validation.
- Do not introduce a heavyweight fluid solver.
- Do not make the background capture pointer events.

## Test Strategy

Tests should describe perceptual behavior in tolerant terms:

- idle drift is present and bounded;
- gravity creates directional bias without overpowering all motion;
- pointer influence is local and distance-weighted;
- scroll effects decay;
- listener lifecycle stays clean;
- bundle size stays within the configured gate.

Avoid tests that lock exact coefficients, frame-by-frame positions, or one-off screenshot pixels unless the assertion is about a real compatibility contract.

## Current Status

**2026-09-01 update (0.3.7):** the idle drift cruise has landed. `driftAngle`/`driftSpeed` were initialized per blob since 0.3.0 but never read by the physics loop, so "idle blobs drift" (this document's first promise) was only ever the zero-mean jitter plus a slow bounded slosh — measured on an idle desktop, coherent displacement decorrelated within seconds and the background read as frozen. The loop now applies a constant per-substep force along each blob's persistent heading with `driftSpeed` (init `0.05 + rand * 0.05`) as the terminal speed under the unchanged `*= 0.992` damping: ≈3–6 units/s in the 180-unit field, so a blob crosses the field in roughly 30–60 s, reaches walls, and bounces (`recordBounce()` re-randomizes the heading on impact). The force is purely additive and consumes no randomness, so gravity/pointer/scroll feel and transient-impulse decay are untouched, and reduced-motion behavior is unchanged (the cruise lives inside the step the component never runs under `prefers-reduced-motion`). Unit coverage: `tests/unit/idle-drift-cruise.test.ts` (differential run isolating the cruise term, wall-bounce containment, init floor).

**2026-07-25 update (0.3.6):** the fixed-timestep accumulator described in TIN-853 has landed. `BlobPhysics.tick()` still accepts the caller's variable per-frame `deltaTime`, but the simulation now always advances in fixed `1/60`s quanta (capped at 8 substeps per call) instead of integrating directly on the raw frame delta. Before 0.3.6, nothing in the physics loop actually scaled by `deltaTime` — velocity adds, damping multipliers (`*= 0.992`), and drift amounts were all raw per-invocation constants — so feel and damping implicitly scaled with whatever refresh rate the caller happened to run at. Concretely, **a 120Hz display ran physics roughly 2x too fast** (twice as many ticks, hence twice as much ambient drift/damping/deformation, per real second), and a throttled ~30Hz caller ran it roughly half as fast. The 0.3.6 feel change observed on non-60Hz displays is therefore the **correction** toward this document's refresh-rate-independence intent, not a regression: 60Hz displays (the common baseline) see no feel change, and 120Hz/30Hz displays now match 60Hz feel instead of drifting from it. The browser probe that would confirm this end-to-end still requires a local server to drive real CDP orientation/pointer events (see Test Strategy above); running it is deferred to CI or another sanctioned lane rather than ad hoc here.

- Gravity/device-orientation is routed through `InteractionField.directionalBiasField()` and cached as a bounded force outside the per-blob hot path.
- The browser probe verifies synthetic and CDP orientation events preserve the expected motion signs, change blob geometry, return to neutral on idle or reduced motion, and receive a real CDP pointer move while pointer physics is active.
- Pointer IO updates the physics pointer anchor, velocity, and per-blob `mouseDistance`; unit coverage verifies the first standalone route applies a small local pointer field only after real pointer input.
- Scroll still uses the restored pre-Phase-A path and can use the pointer anchor for sticky attraction. Route pointer and scroll through fields only after preserving the current feel and bundle headroom.

## Implementation Slices

1. Keep PR #39 on the restored pre-Phase-A physics and renderer baseline while retaining the motion harness, lifecycle, pointer, package, and CI work.
2. Add pure field helpers and unit tests without changing runtime feel.
3. Route gravity/device-orientation through the field helper while preserving ambient motion.
4. Route pointer and scroll values through field helpers one input at a time, starting with a low-strength local pointer field.
5. Add browser probes for directional bias, pointer locality, and scroll decay.
6. Revisit renderer stylability after interaction feel is stable.
