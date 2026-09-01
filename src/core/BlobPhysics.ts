













import type { ConvexBlob, GravityVector, TiltVector } from './types.js';
import { SpatialHash } from './SpatialHash.js';
import { GaussianKernel } from './GaussianKernel.js';
import { SpringSystem, DEFAULT_SPRING_CONFIG, type SpringConfig } from './SpringSystem.js';
import { directionalBiasField } from './InteractionField.js';

const ACCELEROMETER_STRENGTH = 0.0008;
const ACCELEROMETER_MAX_FORCE = 0.003;

export interface BlobPhysicsConfig {
	antiClusteringStrength: number;
	bounceDamping: number;
	deformationSpeed: number;
	territoryStrength: number;
	viscosity: number;
	
	useSpatialHash: boolean;
	
	useGaussianSmoothing: boolean;
	
	useSpringSystem: boolean;
	
	springConfig: Partial<SpringConfig>;
}

export const DEFAULT_BLOB_PHYSICS_CONFIG: BlobPhysicsConfig = {
	antiClusteringStrength: 0.15,
	bounceDamping: 0.7,
	deformationSpeed: 0.5,
	territoryStrength: 0.1,
	viscosity: 0.3,
	useSpatialHash: true,
	useGaussianSmoothing: true,
	useSpringSystem: true,
	springConfig: {},
};

// Fixed simulation quantum. Physics previously integrated directly on the
// caller-supplied per-frame deltaTime/time, but nothing inside
// updateScreensaverPhysics actually scaled by deltaTime — velocity adds,
// damping multipliers (*=0.992), and drift amounts are raw per-invocation
// constants — so feel and damping implicitly scaled with the caller's frame
// rate (~2x faster/more-damped at 120Hz, half speed at 30Hz throttling).
const FIXED_TIMESTEP_SECONDS = 1 / 60;
// Caps how much simulated time a single tick() call can catch up on (e.g.
// after a paused/backgrounded tab resumes), so a long real-time gap can't
// spiral into an unbounded number of substeps in one frame.
const MAX_PHYSICS_SUBSTEPS = 8;
// Per-substep steering gain for the ambient drift cruise. Each blob carries a
// driftAngle/driftSpeed pair (initialized below, re-randomized on wall bounce
// and by the slow re-heading roll in updateMovementWithAccelerometer); the
// cruise steers velocity toward that heading every substep. Against the
// *= 0.992 damping this settles near 0.86x of the scaled target, a sustained
// gentle coherent travel in the -40..140 physics space — the
// "idle blobs drift" baseline of docs/physics-feel-contract.md — instead of
// the zero-mean jitter random walk that damping otherwise erases in ~1.4s.
const DRIFT_CRUISE_STEERING = 0.05;
// The cruise target speed is driftSpeed scaled by this factor. The raw
// driftSpeed field (0.01-0.025/substep) sits below the speed the jitter
// kicks already reach, so unscaled it disappears into the random walk;
// scaled, the settled cruise (~1.5-3.9 units/s) reads as travel while staying
// well under pointer/scroll/gravity speeds so inputs still dominate.
const DRIFT_CRUISE_SPEED_SCALE = 3;

export class BlobPhysics {
	private blobs: ConvexBlob[] = [];
	private config: BlobPhysicsConfig;
	private numBlobs: number;
	private initialized = false;

	// Fixed-timestep accumulator state (TIN-853): tick() is still called once
	// per rendered frame with the real, variable deltaTime, but the actual
	// simulation always advances in fixed FIXED_TIMESTEP_SECONDS quanta so
	// feel is refresh-rate-independent. Coefficients throughout this class
	// are unchanged — only the stepping cadence is new.
	private accumulatedTime = 0;
	// Seeded with a random phase offset at construction (restores 0.3.5's
	// stochastic mount phase): without this, every mount starts the
	// simulation clock at exactly 0, so the `time % 45 < 0.1` territory
	// reshuffle in updateTerritorialMovement() fires deterministically at the
	// same wall-clock offset on every page load instead of the varied timing
	// the pre-fixed-timestep implementation had. Seeded-RNG tests re-seed
	// Math.random() immediately before construction, so this draw is still
	// fully deterministic there.
	private simulationClock = Math.random() * 45;

	
	private mouseX = 50;
	private mouseY = 50;
	private mouseVelX = 0;
	private mouseVelY = 0;

	
	private gravity: GravityVector = { x: 0, y: 0 };
	private gravityField: GravityVector = { x: 0, y: 0 };
	private tilt: TiltVector = { x: 0, y: 0, z: 0 };
	private scrollStickiness = 0;

	
	private readonly PHYSICS_MIN = -40;
	private readonly PHYSICS_MAX = 140;

	
	private spatialHash: SpatialHash;
	private gaussianKernel: GaussianKernel;
	private springSystem: SpringSystem;
	private controlRadiusScratch: number[] = [];

	constructor(numBlobs: number, config: Partial<BlobPhysicsConfig> = {}) {
		this.numBlobs = numBlobs;
		this.config = { ...DEFAULT_BLOB_PHYSICS_CONFIG, ...config };

		
		this.spatialHash = new SpatialHash(60); 
		this.gaussianKernel = new GaussianKernel(5, 1.2);
		this.springSystem = new SpringSystem({
			...DEFAULT_SPRING_CONFIG,
			...this.config.springConfig,
		});
	}

	


	async init(): Promise<void> {
		if (this.initialized) return;
		this.initializeBlobs();
		this.initialized = true;
	}

	


	isReady(): boolean {
		return this.initialized;
	}

	


	dispose(): void {
		this.blobs = [];
		this.initialized = false;
		this.accumulatedTime = 0;
		this.simulationClock = 0;
	}

	


	setGravity(gravity: GravityVector): void {
		this.gravity = gravity;
		this.gravityField = directionalBiasField(
			gravity,
			ACCELEROMETER_STRENGTH,
			ACCELEROMETER_MAX_FORCE,
		);
	}

	


	setTilt(tilt: TiltVector): void {
		this.tilt = tilt;
	}

	


	setScrollStickiness(value: number): void {
		this.scrollStickiness = value;
	}

	


	// Public signature unchanged (deltaTime, time in seconds) — accumulates
	// the caller's variable per-frame deltaTime and steps the simulation in
	// fixed FIXED_TIMESTEP_SECONDS quanta so a 30/60/120Hz caller produces
	// the same number of physics steps per unit of real time. The `time`
	// argument is accepted but ignored: an internally tracked simulation
	// clock (advanced in the same fixed quanta) replaces it so per-substep
	// phase math is exactly as refresh-rate-independent as position/velocity.
	tick(deltaTime: number, time: number): void {
		if (!this.initialized) return;

		// A single non-finite or negative deltaTime (e.g. a caller passing
		// NaN from a bad rAF timestamp subtraction) must not permanently wedge
		// the accumulator: Math.min/Math.max with NaN propagate NaN forever,
		// freezing physics on every subsequent tick(). Coerce to a safe 0 so
		// one bad frame is simply a no-op step, not a permanent stall.
		deltaTime = Number.isFinite(deltaTime) ? Math.max(deltaTime, 0) : 0;

		const maxBacklog = FIXED_TIMESTEP_SECONDS * MAX_PHYSICS_SUBSTEPS;
		this.accumulatedTime = Math.min(this.accumulatedTime + deltaTime, maxBacklog);

		let substeps = 0;
		while (this.accumulatedTime >= FIXED_TIMESTEP_SECONDS && substeps < MAX_PHYSICS_SUBSTEPS) {
			this.simulationClock += FIXED_TIMESTEP_SECONDS;
			this.step(FIXED_TIMESTEP_SECONDS, this.simulationClock);
			this.accumulatedTime -= FIXED_TIMESTEP_SECONDS;
			substeps++;
		}
	}

	private step(deltaTime: number, time: number): void {

		if (this.config.useSpatialHash) {
			this.spatialHash.rebuild(this.blobs);
		}


		if (this.config.useSpatialHash) {
			this.applyAntiClusteringWithSpatialHash();
		} else {
			this.applyEnhancedAntiClustering();
		}


		this.blobs.forEach((blob) =>
			this.updateScreensaverPhysics(blob, deltaTime, time)
		);


		this.mouseVelX *= 0.96;
		this.mouseVelY *= 0.96;
	}

	


	private applyAntiClusteringWithSpatialHash(): void {
		const maxPersonalSpace = 60; 

		for (const blob of this.blobs) {
			const neighbors = this.spatialHash.queryNeighbors(blob, maxPersonalSpace);

			for (const other of neighbors) {
				const dx = other.currentX - blob.currentX;
				const dy = other.currentY - blob.currentY;
				const distance = Math.sqrt(dx * dx + dy * dy);

				const requiredDistance = Math.max(blob.personalSpace || 50, other.personalSpace || 50);

				if (distance < requiredDistance && distance > 0) {
					const overlap = requiredDistance - distance;
					const repulsionForce = (overlap / requiredDistance) * 0.055 * this.config.antiClusteringStrength / 0.15;

					const normalizedDx = dx / distance;
					const normalizedDy = dy / distance;

					const forceMultiplier = blob.repulsionStrength || 0.03;
					const proximityMultiplier = distance < requiredDistance * 0.7 ? 3.5 : 1.0;

					
					blob.velocityX -= normalizedDx * repulsionForce * forceMultiplier * proximityMultiplier * 0.5;
					blob.velocityY -= normalizedDy * repulsionForce * forceMultiplier * proximityMultiplier * 0.5;

					blob.lastRepulsionTime = Date.now();
				}
			}
		}
	}

	


	updateMousePosition(x: number, y: number): void {
		const previousMouseX = this.mouseX;
		const previousMouseY = this.mouseY;
		this.mouseVelX = x - previousMouseX;
		this.mouseVelY = y - previousMouseY;
		this.mouseX = x;
		this.mouseY = y;
	}

	


	// Mutate blob.color in place when themeColors is supplied — kills the
	// 300 object spreads/sec the previous .map(blob => ({...blob, color}))
	// performed at 5 blobs × 60 fps. Return a *shallow copy* so the array
	// reference is fresh each call: TinyVectors.svelte assigns the result
	// to a $state rune inside its rAF loop, and Svelte 5's signal compares
	// by reference — returning the same array would freeze the animation
	// after frame 1. Same blob object refs across calls; only the outer
	// array shell is reallocated.
	getBlobs(themeColors?: string[]): ConvexBlob[] {
		if (themeColors && themeColors.length > 0) {
			for (let i = 0; i < this.blobs.length; i++) {
				this.blobs[i].color = themeColors[i % themeColors.length];
			}
		}
		return this.blobs.slice();
	}

	


	generateSmoothBlobPath(blob: ConvexBlob): string {
		if (!blob.controlPoints || blob.controlPoints.length < 3) {
			
			const displayX = blob.currentX;
			const displayY = blob.currentY;
			const displaySize = blob.size;

			return `M ${displayX - displaySize},${displayY}
					A ${displaySize},${displaySize} 0 1,1 ${displayX + displaySize},${displayY}
					A ${displaySize},${displaySize} 0 1,1 ${displayX - displaySize},${displayY}`;
		}

		const displayX = blob.currentX;
		const displayY = blob.currentY;

		
		const points = blob.controlPoints.map((point) => {
			const x = displayX + Math.cos(point.angle) * point.radius;
			const y = displayY + Math.sin(point.angle) * point.radius;
			return { x, y };
		});

		
		const convexPoints = this.generateConvexHull(points);

		// Numbers are interpolated directly: Number.prototype.toString() in
		// V8 is faster than toFixed and SVG accepts any precision. Each
		// .toFixed call allocated a fresh string ~18,000 times/sec at
		// 5 blobs × 12 control points × 60 fps.
		let path = `M ${convexPoints[0].x},${convexPoints[0].y}`;

		for (let i = 0; i < convexPoints.length; i++) {
			const current = convexPoints[i];
			const next = convexPoints[(i + 1) % convexPoints.length];
			const nextNext = convexPoints[(i + 2) % convexPoints.length];

			const cp1x = current.x + (next.x - current.x) * 0.15;
			const cp1y = current.y + (next.y - current.y) * 0.15;
			const cp2x = next.x - (nextNext.x - current.x) * 0.05;
			const cp2y = next.y - (nextNext.y - current.y) * 0.05;

			path += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${next.x},${next.y}`;
		}

		path += ' Z';
		return path;
	}

	
	
	

	private initializeBlobs(): void {
		this.blobs = [];

		for (let i = 0; i < this.numBlobs; i++) {
			
			const cols = Math.ceil(Math.sqrt(this.numBlobs));
			const rows = Math.ceil(this.numBlobs / cols);
			const col = i % cols;
			const row = Math.floor(i / cols);

			
			const cellWidth = (this.PHYSICS_MAX - this.PHYSICS_MIN - 40) / cols;
			const cellHeight = (this.PHYSICS_MAX - this.PHYSICS_MIN - 40) / rows;

			
			const baseX = this.PHYSICS_MIN + 20 + col * cellWidth + cellWidth / 2 + (Math.random() - 0.5) * cellWidth * 0.5;
			const baseY = this.PHYSICS_MIN + 20 + row * cellHeight + cellHeight / 2 + (Math.random() - 0.5) * cellHeight * 0.5;

			
			const clampedX = Math.max(this.PHYSICS_MIN + 20, Math.min(this.PHYSICS_MAX - 20, baseX));
			const clampedY = Math.max(this.PHYSICS_MIN + 20, Math.min(this.PHYSICS_MAX - 20, baseY));

			
			const baseSize = 15 + Math.random() * 12;

			
			const numControlPoints = 8;
			const controlPoints = [];
			const controlVelocities = [];

			for (let j = 0; j < numControlPoints; j++) {
				const pointAngle = (j / numControlPoints) * Math.PI * 2;
				const radiusVariation = 0.8 + Math.random() * 0.35;
				const pointRadius = baseSize * radiusVariation;

				controlPoints.push({
					radius: pointRadius,
					angle: pointAngle,
					targetRadius: pointRadius,
					baseRadius: pointRadius,
					pressure: 1.0,
					adhesion: 0.15 + Math.random() * 0.1,
					tension: 0.3 + Math.random() * 0.15,
				});

				controlVelocities.push({
					radialVelocity: 0,
					angularVelocity: (Math.random() - 0.5) * 0.0004,
					pressureVelocity: 0,
				});
			}

			this.blobs.push({
				baseX: clampedX,
				baseY: clampedY,
				currentX: clampedX,
				currentY: clampedY,
				velocityX: (Math.random() - 0.5) * 0.02,
				velocityY: (Math.random() - 0.5) * 0.02,
				size: baseSize,
				elasticity: 0.0004 + Math.random() * 0.0002,
				viscosity: 0.995 + Math.random() * 0.003,
				phase: Math.random() * Math.PI * 2,
				speed: 0.003 + Math.random() * 0.002,
				color: `hsl(${(i * 30) % 360}, 70%, 60%)`,
				gradientId: `blob-gradient-${i}`,
				intensity: 0.65 + Math.random() * 0.2,
				stickiness: 2,
				isAttractive: i % 2 === 0,
				mouseDistance: 100,
				isStuck: false,
				radiusVariations: [],
				fluidMass: 0.5 + Math.random() * 0.25,
				scrollAffinity: 0.3 + Math.random() * 0.5,
				surfaceTension: 0.02 + Math.random() * 0.01,
				density: 0.4 + Math.random() * 0.1,
				flowResistance: 0.002 + Math.random() * 0.001,
				controlPoints,
				controlVelocities,
				deformationStrength: 0.3 + Math.random() * 0.15,
				cohesion: 0.05 + Math.random() * 0.03,
				stretchability: 0.8 + Math.random() * 0.3,
				lastCollisionTime: 0,
				mergeThreshold: baseSize * 0.5,
				splitThreshold: baseSize * 1.5,
				isSettled: false,
				settleTime: 0,
				groundContactPoints: [],
				restHeight: baseSize * 0.7,
				wetting: 0.15 + Math.random() * 0.1,
				contactAngle: 70 + Math.random() * 30,
				pressureDistribution: new Array(numControlPoints).fill(1.0),
				chaosLevel: 0,
				turbulenceDecay: 0.985,
				expansionPhase: false,
				expansionTime: 0,
				maxExpansionTime: 20 + Math.random() * 40,
				wallBounceCount: 0,
				lastBounceTime: 0,
				driftAngle: Math.random() * Math.PI * 2,
				driftSpeed: 0.01 + Math.random() * 0.015,
				territoryRadius: 100 + Math.random() * 60,
				territoryX: clampedX,
				territoryY: clampedY,
				personalSpace: 35 + Math.random() * 20,
				repulsionStrength: 0.025 + Math.random() * 0.015,
				lastRepulsionTime: 0,
			});
		}
	}

	private applyEnhancedAntiClustering(): void {
		for (let i = 0; i < this.blobs.length; i++) {
			const blob1 = this.blobs[i];

			for (let j = i + 1; j < this.blobs.length; j++) {
				const blob2 = this.blobs[j];

				const dx = blob2.currentX - blob1.currentX;
				const dy = blob2.currentY - blob1.currentY;
				const distance = Math.sqrt(dx * dx + dy * dy);

				const requiredDistance = Math.max(blob1.personalSpace || 50, blob2.personalSpace || 50);

				if (distance < requiredDistance && distance > 0) {
					const overlap = requiredDistance - distance;
					const repulsionForce = (overlap / requiredDistance) * 0.055 * this.config.antiClusteringStrength / 0.15;

					const normalizedDx = dx / distance;
					const normalizedDy = dy / distance;

					const force1Multiplier = blob1.repulsionStrength || 0.03;
					const force2Multiplier = blob2.repulsionStrength || 0.03;

					
					const proximityMultiplier = distance < requiredDistance * 0.7 ? 3.5 : 1.0;

					blob1.velocityX -= normalizedDx * repulsionForce * force1Multiplier * proximityMultiplier;
					blob1.velocityY -= normalizedDy * repulsionForce * force1Multiplier * proximityMultiplier;

					blob2.velocityX += normalizedDx * repulsionForce * force2Multiplier * proximityMultiplier;
					blob2.velocityY += normalizedDy * repulsionForce * force2Multiplier * proximityMultiplier;

					blob1.lastRepulsionTime = Date.now();
					blob2.lastRepulsionTime = Date.now();
				}
			}
		}
	}

	private updateScreensaverPhysics(blob: ConvexBlob, deltaTime: number, time: number): void {
		
		blob.mouseDistance = Math.sqrt(
			Math.pow(blob.currentX - this.mouseX, 2) + Math.pow(blob.currentY - this.mouseY, 2)
		);

		
		this.updateTerritorialMovement(blob, time);

		
		this.applyAccelerometerForces(blob);


		this.applyPointerField(blob);

		
		this.updateMovementWithAccelerometer(blob, time);

		
		this.addEscapeVelocity(blob);

		
		this.updateSafeOrganicDeformation(blob, time);

		
		if (this.scrollStickiness > 0.01) {
			this.applyScrollEffect(blob);
		}

		
		blob.currentX += blob.velocityX;
		blob.currentY += blob.velocityY;

		
		this.handleWallBouncing(blob);

		
		blob.velocityX *= 0.992;
		blob.velocityY *= 0.992;
	}

	private applyAccelerometerForces(blob: ConvexBlob): void {
		blob.velocityX += this.gravityField.x;
		blob.velocityY += this.gravityField.y;

		
		if (blob.controlPoints && (Math.abs(this.gravity.x) > 0.3 || Math.abs(this.gravity.y) > 0.3)) {
			const deformationAmount = Math.min(0.08, (Math.abs(this.gravity.x) + Math.abs(this.gravity.y)) * 0.02);
			blob.chaosLevel = Math.min((blob.chaosLevel || 0) + deformationAmount, 0.2);
		}
	}

	private applyPointerField(blob: ConvexBlob): void {
		if (this.mouseX === 50 && this.mouseY === 50) return;

		const dx = this.mouseX - blob.currentX;
		const dy = this.mouseY - blob.currentY;
		const distance = Math.sqrt(dx * dx + dy * dy);
		if (distance === 0 || distance >= 34) return;

		const normalized = 1 - distance / 34;
		const scale = (normalized * normalized * 0.0014) / distance;
		blob.velocityX += dx * scale;
		blob.velocityY += dy * scale;
	}

	private updateMovementWithAccelerometer(blob: ConvexBlob, time: number): void {
		// Ambient cruise: the always-on baseline field. driftAngle/driftSpeed
		// were initialized per-blob since the pre-Phase-A baseline but never
		// read by the loop, so idle motion was only the bounded jitter below.
		const driftAngle = blob.driftAngle || 0;
		const cruiseSpeed = (blob.driftSpeed || 0) * DRIFT_CRUISE_SPEED_SCALE;
		blob.velocityX += (Math.cos(driftAngle) * cruiseSpeed - blob.velocityX) * DRIFT_CRUISE_STEERING;
		blob.velocityY += (Math.sin(driftAngle) * cruiseSpeed - blob.velocityY) * DRIFT_CRUISE_STEERING;

		
		const neutralDriftX = (Math.random() - 0.5) * 0.001;
		const neutralDriftY = (Math.random() - 0.5) * 0.001;

		blob.velocityX += neutralDriftX;
		blob.velocityY += neutralDriftY;

		
		const brownianTime = time * 0.1 + blob.phase;
		const brownianX = Math.sin(brownianTime + (blob.driftAngle || 0)) * 0.0005;
		const brownianY = Math.cos(brownianTime * 1.3 + (blob.driftAngle || 0)) * 0.0005;

		blob.velocityX += brownianX;
		blob.velocityY += brownianY;

		
		if (Math.random() < 0.002) {
			blob.driftAngle = Math.random() * Math.PI * 2;
		}
	}

	private updateTerritorialMovement(blob: ConvexBlob, time: number): void {
		const territoryX = blob.territoryX || blob.baseX;
		const territoryY = blob.territoryY || blob.baseY;
		const territoryRadius = blob.territoryRadius || 70;

		const distanceFromTerritory = Math.sqrt(
			Math.pow(blob.currentX - territoryX, 2) + Math.pow(blob.currentY - territoryY, 2)
		);

		
		if (distanceFromTerritory > territoryRadius) {
			const pullStrength = ((distanceFromTerritory - territoryRadius) / territoryRadius) * 0.0002 * this.config.territoryStrength / 0.1;
			const angleToTerritory = Math.atan2(territoryY - blob.currentY, territoryX - blob.currentX);

			blob.velocityX += Math.cos(angleToTerritory) * pullStrength;
			blob.velocityY += Math.sin(angleToTerritory) * pullStrength;
		}

		
		blob.velocityX += (Math.random() - 0.5) * 0.003;
		blob.velocityY += (Math.random() - 0.5) * 0.003;

		
		if (time % 45 < 0.1) {
			const randomOffset = 35;
			blob.territoryX = Math.max(
				this.PHYSICS_MIN + 35,
				Math.min(this.PHYSICS_MAX - 35, territoryX + (Math.random() - 0.5) * randomOffset)
			);
			blob.territoryY = Math.max(
				this.PHYSICS_MIN + 35,
				Math.min(this.PHYSICS_MAX - 35, territoryY + (Math.random() - 0.5) * randomOffset)
			);
		}
	}

	private addEscapeVelocity(blob: ConvexBlob): void {
		if (blob.lastRepulsionTime && Date.now() - blob.lastRepulsionTime < 3000) {
			const escapeStrength = 0.01;
			const escapeAngle = Math.random() * Math.PI * 2;

			blob.velocityX += Math.cos(escapeAngle) * escapeStrength;
			blob.velocityY += Math.sin(escapeAngle) * escapeStrength;
		}
	}

	private updateSafeOrganicDeformation(blob: ConvexBlob, time: number): void {
		if (!blob.controlPoints || !blob.controlVelocities) return;

		if (this.config.useSpringSystem) {
			
			this.updateSpringDeformation(blob, time);
		} else {
			
			this.updateSinusoidalDeformation(blob, time);
		}

		
		if (this.config.useGaussianSmoothing) {
			this.gaussianKernel.convolve(blob.controlPoints);
		} else {
			this.smoothControlPoints(blob);
		}
	}

	


	private updateSpringDeformation(blob: ConvexBlob, time: number): void {
		if (!blob.controlPoints || !blob.controlVelocities) return;

		
		const velocityMag = Math.sqrt(blob.velocityX * blob.velocityX + blob.velocityY * blob.velocityY);
		const velocityAngle = Math.atan2(blob.velocityY, blob.velocityX);

		
		const externalForces: number[] = blob.controlPoints.map((point) => {
			
			const alignment = Math.cos(point.angle - velocityAngle);
			return -alignment * velocityMag * 0.5;
		});

		
		if (blob.chaosLevel && blob.chaosLevel > 0.01) {
			for (let i = 0; i < externalForces.length; i++) {
				externalForces[i] += (Math.random() - 0.5) * blob.chaosLevel * 0.3;
			}
		}

		
		this.springSystem.updateAllControlPoints(
			blob.controlPoints,
			blob.controlVelocities,
			externalForces,
			0.016 
		);

		
		for (let i = 0; i < blob.controlPoints.length; i++) {
			const velocity = blob.controlVelocities[i];
			velocity.angularVelocity += (Math.random() - 0.5) * 0.00002;
			velocity.angularVelocity *= 0.998;
			velocity.angularVelocity = Math.max(-0.0006, Math.min(0.0006, velocity.angularVelocity));
			blob.controlPoints[i].angle += velocity.angularVelocity;
		}

		
		if (blob.chaosLevel) {
			blob.chaosLevel *= blob.turbulenceDecay || 0.985;
		}
	}

	


	private updateSinusoidalDeformation(blob: ConvexBlob, time: number): void {
		if (!blob.controlPoints || !blob.controlVelocities) return;

		blob.controlPoints.forEach((point, i) => {
			
			const pulseTime = time * 0.15 * this.config.deformationSpeed / 0.5 + i * 0.4 + blob.phase;
			const pulseAmount = Math.sin(pulseTime) * 0.02;

			
			const minRadius = point.baseRadius * 0.85;
			const maxRadius = point.baseRadius * 1.15;

			const targetRadius = point.baseRadius * (1 + pulseAmount);
			point.targetRadius = Math.max(minRadius, Math.min(maxRadius, targetRadius));

			
			const radiusDiff = point.targetRadius - point.radius;
			point.radius += radiusDiff * 0.008;

			
			if (blob.controlVelocities && blob.controlVelocities[i]) {
				blob.controlVelocities[i].angularVelocity += (Math.random() - 0.5) * 0.00003;
				blob.controlVelocities[i].angularVelocity *= 0.999;
				blob.controlVelocities[i].angularVelocity = Math.max(
					-0.0008,
					Math.min(0.0008, blob.controlVelocities[i].angularVelocity)
				);
				point.angle += blob.controlVelocities[i].angularVelocity;
			}
		});
	}

	private smoothControlPoints(blob: ConvexBlob): void {
		if (!blob.controlPoints || blob.controlPoints.length < 3) return;

		const controlPoints = blob.controlPoints;
		const originalRadii = this.controlRadiusScratch;
		const pointCount = controlPoints.length;

		for (let i = 0; i < pointCount; i++) {
			originalRadii[i] = controlPoints[i].radius;
		}

		for (let i = 0; i < pointCount; i++) {
			const current = controlPoints[i];
			const prevRadius = originalRadii[(i - 1 + pointCount) % pointCount];
			const currentRadius = originalRadii[i];
			const nextRadius = originalRadii[(i + 1) % pointCount];

			
			const avgRadius = (prevRadius + currentRadius + nextRadius) / 3;
			const smoothingFactor = 0.05;
			current.radius = currentRadius * (1 - smoothingFactor) + avgRadius * smoothingFactor;

			
			const minRadiusDiff = blob.size * 0.1;
			const neighborRadius = (prevRadius + nextRadius) * 0.5;
			const radiusDiff = current.radius - neighborRadius;
			const excessRadiusDiff = Math.abs(radiusDiff) - minRadiusDiff;
			if (excessRadiusDiff > 0) {
				current.radius -= radiusDiff > 0 ? excessRadiusDiff * 0.5 : -excessRadiusDiff * 0.5;
			}
		}
	}

	private applyScrollEffect(blob: ConvexBlob): void {
		const attractionStrength = this.scrollStickiness * blob.scrollAffinity * 0.0002;
		blob.velocityX += (this.mouseX - blob.currentX) * attractionStrength;
		blob.velocityY += (this.mouseY - blob.currentY) * attractionStrength;

		if (this.scrollStickiness > 0.15) {
			blob.chaosLevel = Math.min((blob.chaosLevel || 0) + this.scrollStickiness * 0.02, 0.15);
		}
	}

	private handleWallBouncing(blob: ConvexBlob): void {
		const margin = blob.size * 0.8;
		const damping = this.config.bounceDamping;
		const currentTime = Date.now();

		
		if (blob.currentX < this.PHYSICS_MIN + margin) {
			blob.currentX = this.PHYSICS_MIN + margin;
			blob.velocityX = Math.abs(blob.velocityX) * damping;
			this.recordBounce(blob, currentTime);
		}

		
		if (blob.currentX > this.PHYSICS_MAX - margin) {
			blob.currentX = this.PHYSICS_MAX - margin;
			blob.velocityX = -Math.abs(blob.velocityX) * damping;
			this.recordBounce(blob, currentTime);
		}

		
		if (blob.currentY < this.PHYSICS_MIN + margin * 1.5) {
			blob.currentY = this.PHYSICS_MIN + margin * 1.5;
			blob.velocityY = Math.abs(blob.velocityY) * damping;
			this.recordBounce(blob, currentTime);
		}

		
		if (blob.currentY > this.PHYSICS_MAX - margin * 1.5) {
			blob.currentY = this.PHYSICS_MAX - margin * 1.5;
			blob.velocityY = -Math.abs(blob.velocityY) * damping;
			this.recordBounce(blob, currentTime);
		}
	}

	private recordBounce(blob: ConvexBlob, currentTime: number): void {
		blob.wallBounceCount = (blob.wallBounceCount || 0) + 1;
		blob.lastBounceTime = currentTime;

		
		blob.velocityX += (Math.random() - 0.5) * 0.05;
		blob.velocityY += (Math.random() - 0.5) * 0.05;

		
		blob.driftAngle = Math.random() * Math.PI * 2;

		
		if (blob.controlPoints) {
			blob.chaosLevel = Math.min((blob.chaosLevel || 0) + 0.04, 0.15);
		}
	}

	private generateConvexHull(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
		if (points.length < 3) return points;

		
		const maxIterations = points.length * 2;
		let iterations = 0;

		const hull: Array<{ x: number; y: number }> = [];

		
		let startPoint = points[0];
		let startIndex = 0;
		for (let i = 0; i < points.length; i++) {
			const point = points[i];
			if (point.y < startPoint.y || (point.y === startPoint.y && point.x < startPoint.x)) {
				startPoint = point;
				startIndex = i;
			}
		}

		let currentIndex = startIndex;
		do {
			hull.push(points[currentIndex]);
			let nextIndex = 0;

			for (let i = 0; i < points.length; i++) {
				if (nextIndex === currentIndex || this.isLeftTurn(points[currentIndex], points[nextIndex], points[i])) {
					nextIndex = i;
				}
			}

			currentIndex = nextIndex;
			iterations++;
		} while (currentIndex !== startIndex && hull.length < points.length && iterations < maxIterations);

		return hull;
	}

	private isLeftTurn(
		p1: { x: number; y: number },
		p2: { x: number; y: number },
		p3: { x: number; y: number }
	): boolean {
		return (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x) > 0;
	}
}
