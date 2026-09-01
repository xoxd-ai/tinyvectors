import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlobPhysics } from '../../src/core/BlobPhysics.js';
import type { ConvexBlob } from '../../src/core/types.js';

// Deterministic xorshift32 PRNG (same shape as blob-physics-timestep.test.ts)
// so every run of a scenario draws the exact same "random" sequence.
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 4294967296;
	};
}

let randomSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	randomSpy = vi.spyOn(Math, 'random');
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

interface IdleRunResult {
	meanNetDisplacement: number;
	maxSpeed: number;
	minCoordinate: number;
	maxCoordinate: number;
}

// Simulates `seconds` of untouched idle time (no pointer, scroll, or gravity
// input) at a 60Hz tick cadence and reports perceptual aggregates. When
// `zeroDriftSpeed` is set, each blob's cruise field is zeroed after init so
// the run measures the jitter-only baseline the cruise must rise above.
async function runIdle(seed: number, seconds: number, zeroDriftSpeed: boolean): Promise<IdleRunResult> {
	randomSpy.mockImplementation(seededRandom(seed));

	const physics = new BlobPhysics(8);
	await physics.init();

	const blobs = physics.getBlobs() as ConvexBlob[];
	if (zeroDriftSpeed) {
		for (const blob of blobs) blob.driftSpeed = 0;
	}
	const start = blobs.map((blob) => ({ x: blob.currentX, y: blob.currentY }));

	const frames = Math.round(seconds * 60);
	let maxSpeed = 0;
	let minCoordinate = Number.POSITIVE_INFINITY;
	let maxCoordinate = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < frames; i++) {
		physics.tick(1 / 60, i / 60);
		for (const blob of physics.getBlobs() as ConvexBlob[]) {
			maxSpeed = Math.max(maxSpeed, Math.hypot(blob.velocityX, blob.velocityY));
			minCoordinate = Math.min(minCoordinate, blob.currentX, blob.currentY);
			maxCoordinate = Math.max(maxCoordinate, blob.currentX, blob.currentY);
		}
	}

	const end = physics.getBlobs() as ConvexBlob[];
	const displacements = end.map((blob, i) =>
		Math.hypot(blob.currentX - start[i].x, blob.currentY - start[i].y)
	);

	return {
		meanNetDisplacement: displacements.reduce((sum, d) => sum + d, 0) / displacements.length,
		maxSpeed,
		minCoordinate,
		maxCoordinate,
	};
}

// Perceptual contract (docs/physics-feel-contract.md): "idle drift is present
// and bounded". Thresholds are deliberately loose — they assert travel vs.
// jiggle, not exact coefficients or frame-by-frame positions.
describe('BlobPhysics idle drift cruise (ambient field)', () => {
	const SEEDS = [42, 7, 1234];

	it('idle blobs travel with no input at all: net displacement well above the jitter-only baseline', async () => {
		for (const seed of SEEDS) {
			const cruise = await runIdle(seed, 12, false);
			const jitterOnly = await runIdle(seed, 12, true);

			// Measured cruise means sit at 16.4-25.5 units over 12s in the
			// -40..140 physics space; jitter-only at 4.3-5.0. Floors leave
			// generous room for feel tuning while still failing if the cruise
			// field ever regresses to dead code again.
			expect(cruise.meanNetDisplacement).toBeGreaterThan(8);
			expect(cruise.meanNetDisplacement).toBeGreaterThan(jitterOnly.meanNetDisplacement * 1.5);
		}
	});

	it('idle drift stays bounded: gentle speeds, positions inside the physics walls', async () => {
		for (const seed of SEEDS) {
			const cruise = await runIdle(seed, 12, false);

			// ~0.08 units/substep measured peak over 12s; 0.15 (9 units/s)
			// is the "no longer gentle" ceiling.
			expect(cruise.maxSpeed).toBeLessThan(0.15);
			expect(cruise.minCoordinate).toBeGreaterThanOrEqual(-40);
			expect(cruise.maxCoordinate).toBeLessThanOrEqual(140);
		}
	});
});
