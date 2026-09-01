import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlobPhysics } from '../../src/core/BlobPhysics.js';
import type { ConvexBlob } from '../../src/core/types.js';

// Idle drift cruise (0.3.7): with NO pointer, scroll, or devicemotion input,
// blobs must still move — driftAngle/driftSpeed are wired into the physics
// loop as a constant per-substep force whose terminal speed is driftSpeed.
//
// Math.random is mocked to a constant 0.5 so:
// - neutral drift and territorial jitter are exactly zero ((0.5 - 0.5) * k);
// - the 0.002-probability drift retarget never fires (0.5 < 0.002 is false);
// - recordBounce()'s velocity kick is exactly zero;
// - init draws identical deterministic values on every run.
// The bounded brownian slosh term is sinusoidal and RNG-free, so paired runs
// below see byte-identical brownian forces and their difference isolates the
// cruise wiring exactly.

const FRAME = 1 / 60;

let randomSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	randomSpy = vi.spyOn(Math, 'random');
	randomSpy.mockReturnValue(0.5);
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function runIdle(
	seconds: number,
	configureBlob: (blob: ConvexBlob) => void
): Promise<{ dx: number; dy: number; blob: ConvexBlob }> {
	const physics = new BlobPhysics(1);
	await physics.init();
	const blob = physics.getBlobs()[0];
	configureBlob(blob);
	const startX = blob.currentX;
	const startY = blob.currentY;
	const frames = Math.round(seconds / FRAME);
	for (let i = 0; i < frames; i++) {
		physics.tick(FRAME, i * FRAME);
	}
	return { dx: blob.currentX - startX, dy: blob.currentY - startY, blob };
}

describe('idle drift cruise', () => {
	it('initializes every blob with a cruise heading and a non-trivial cruise speed', async () => {
		const physics = new BlobPhysics(4);
		await physics.init();
		for (const blob of physics.getBlobs()) {
			expect(blob.driftAngle).toBeTypeOf('number');
			// Constant 0.5 draw → 0.05 + 0.5 * 0.05 exactly; the floor is the
			// contract (dead-code era init was 0.01 + rand * 0.015, which the
			// damping made imperceptible against the ambient slosh).
			expect(blob.driftSpeed).toBeGreaterThanOrEqual(0.05);
			expect(blob.driftSpeed).toBeLessThanOrEqual(0.1);
		}
	});

	it('cruise force moves an otherwise-idle blob along its heading (differential vs driftSpeed=0)', async () => {
		// Identical mocked RNG and identical brownian phase in both runs: the
		// trajectories differ ONLY by the cruise term under test.
		const withCruise = await runIdle(10, (blob) => {
			blob.driftAngle = Math.PI; // straight toward -x
			blob.driftSpeed = 0.1;
		});
		const withoutCruise = await runIdle(10, (blob) => {
			blob.driftAngle = Math.PI;
			blob.driftSpeed = 0;
		});

		const cruiseDx = withCruise.dx - withoutCruise.dx;
		const cruiseDy = withCruise.dy - withoutCruise.dy;

		// Terminal speed ≈ driftSpeed (0.1 units/substep ≈ 6 units/s in the
		// 180-unit field) with a ~2s exponential spin-up: expect roughly
		// -47 units over 10 simulated seconds, entirely along the heading.
		expect(cruiseDx).toBeLessThan(-35);
		expect(cruiseDx).toBeGreaterThan(-60);
		expect(Math.abs(cruiseDy)).toBeLessThan(0.001);
	});

	it('a cruising blob reaches the wall and bounces instead of escaping the field', async () => {
		const { blob } = await runIdle(3, (b) => {
			b.currentX = -20; // near the left wall (clamp at PHYSICS_MIN + size * 0.8)
			b.driftAngle = Math.PI; // heading into the wall
			b.driftSpeed = 0.3;
		});

		expect(blob.wallBounceCount ?? 0).toBeGreaterThanOrEqual(1);
		// Wall clamp held: the blob never leaves the physics field.
		expect(blob.currentX).toBeGreaterThanOrEqual(-40);
	});
});
