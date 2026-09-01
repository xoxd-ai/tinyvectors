<script lang="ts">
	import { browser } from '../core/browser.js';
	import { untrack } from 'svelte';
	import { BlobPhysics, type BlobPhysicsConfig } from '../core/BlobPhysics.js';
	import {
		DeviceMotion,
		getDeviceMotionCapabilityState,
		isDeviceMotionPermissionRequired,
		type MotionVector,
	} from '../motion/DeviceMotion.js';
	import {
		createPointerPhysicsController,
		detectPointerPhysicsCapability,
		type PointerPhysicsController,
	} from '../motion/PointerPhysicsController.js';
	import type { PointerBounds } from '../motion/PointerMapper.js';
	import { ScrollHandler } from '../motion/ScrollHandler.js';
	import { watchReducedMotion } from '../motion/reduced-motion.js';
	import { VisibilityGate } from '../motion/VisibilityGate.js';
	import { THEME_PRESET_COLORS } from '../core/theme-colors.js';
	import type { ThemePresetName } from '../core/theme-presets.js';
	import type { TinyVectorsDeviceMotionStatus } from './types.js';
	import BlobSVG from './BlobSVG.svelte';

	interface Props {
		/** Theme preset name */
		theme?: ThemePresetName;
		/** Custom colors (overrides theme preset) */
		colors?: string[];
		/** Whether animation is enabled */
		animated?: boolean;
		/** Component opacity */
		opacity?: number;
		/** Whether component should load */
		shouldLoad?: boolean;
		/** Number of blobs */
		blobCount?: number;
		/** Physics configuration */
		physicsConfig?: Partial<BlobPhysicsConfig>;
		/** Enable device orientation based motion */
		enableDeviceMotion?: boolean;
		/** Enable scroll physics */
		enableScrollPhysics?: boolean;
		/** Enable pointer/mouse physics */
		enablePointerPhysics?: boolean;
		/** Scales normalized screen-aligned tilt vectors before applying them to physics. */
		deviceMotionStrength?: number;
		/** Samples used by calibrateDeviceMotion() when no explicit count is supplied. */
		deviceMotionCalibrationSamples?: number;
		/** Milliseconds before paused device-orientation IO resets to neutral. */
		deviceMotionIdleResetMs?: number;
		/** Optional diagnostics hook for browser/dev harnesses. */
		onDeviceMotion?: (motionData: MotionVector) => void;
		/** Explicit dark override forwarded to BlobSVG; null auto-detects. */
		isDark?: boolean | null;
		/** Renders the existing static frame instead of animating when the user has requested reduced motion. */
		respectReducedMotion?: boolean;
	}

	let {
		theme = 'tinyland',
		colors = [],
		animated = true,
		opacity = 1,
		shouldLoad = true,
		blobCount = 8,
		physicsConfig = {},
		enableDeviceMotion = true,
		enableScrollPhysics = true,
		enablePointerPhysics = true,
		deviceMotionStrength = 0.8,
		deviceMotionCalibrationSamples = 8,
		deviceMotionIdleResetMs = 2000,
		onDeviceMotion,
		isDark = null,
		respectReducedMotion = true,
	}: Props = $props();

	let containerElement: HTMLDivElement | undefined = $state(undefined);
	let blobs = $state<ReturnType<BlobPhysics['getBlobs']>>([]);
	let isReady = $state(false);
	let reducedMotionActive = $state(false);
	let isVisible = $state(true);

	let physics = $state<BlobPhysics | null>(null);
	let animationFrame: number | null = null;
	let lastTime = 0;
	let deviceMotion: DeviceMotion | null = null;
	let scrollHandler: ScrollHandler | null = null;
	let pointerController: PointerPhysicsController | null = null;

	const themeColors = $derived.by(() => {
		if (colors.length > 0) return colors;
		return THEME_PRESET_COLORS[theme] ?? [];
	});

	// Single source of truth for "should the rAF loop actually be running":
	// the animated prop, prefers-reduced-motion (unless opted out), page
	// visibility, and the container's viewport intersection all gate the
	// same existing static-frame path (animated=false machinery below).
	const effectiveAnimated = $derived(
		animated && !(respectReducedMotion && reducedMotionActive) && isVisible
	);

	const detectDeviceMotionCapability = (): boolean => {
		return browser && getDeviceMotionCapabilityState() === 'unknown';
	};

	const createDeviceMotion = (): DeviceMotion =>
		new DeviceMotion(handleDeviceMotion, {
			calibrationSamples: deviceMotionCalibrationSamples,
			deadZone: 0.015,
			idleResetMs: deviceMotionIdleResetMs,
		});

	const handleDeviceMotion = (motionData: MotionVector) => {
		if (!physics) return;

		onDeviceMotion?.(motionData);

		// DeviceMotion emits screen-aligned tilt, so no old beta/gamma axis swap.
		physics.setGravity({
			x: motionData.x * deviceMotionStrength,
			y: motionData.y * deviceMotionStrength,
		});
		physics.setTilt(motionData);
	};

	export async function requestDeviceMotionPermission(): Promise<boolean> {
		if (!browser || !enableDeviceMotion || !physics || !detectDeviceMotionCapability()) return false;

		deviceMotion ??= createDeviceMotion();

		const hasPermission = await deviceMotion.requestPermission();
		return hasPermission;
	}

	export function calibrateDeviceMotion(samples?: number): void {
		deviceMotion?.calibrate(samples);
	}

	export function getDeviceMotionStatus(): TinyVectorsDeviceMotionStatus {
		const capabilityState = getDeviceMotionCapabilityState();
		const permissionState = deviceMotion?.getPermissionState() ?? capabilityState;

		return {
			enabled: enableDeviceMotion,
			supported: capabilityState !== 'unsupported' && capabilityState !== 'insecure',
			requiresPermission: browser && isDeviceMotionPermissionRequired(),
			permissionState,
			active: deviceMotion?.isActive() ?? false,
		};
	}

	const handleScroll = (event: WheelEvent) => {
		if (!scrollHandler || !physics) return;
		scrollHandler.handleScroll(event);
		const stickiness = scrollHandler.getStickiness() * 0.12;
		physics.setScrollStickiness(stickiness);
	};

	const getPointerBounds = (): PointerBounds => {
		const rect = containerElement?.getBoundingClientRect();

		if (rect && rect.width > 0 && rect.height > 0) {
			return {
				left: rect.left,
				top: rect.top,
				width: rect.width,
				height: rect.height,
			};
		}

		return {
			left: 0,
			top: 0,
			width: window.innerWidth || 1,
			height: window.innerHeight || 1,
		};
	};

	function tick(currentTime: number) {
		// Clamp matches the engine's own catch-up ceiling (8 substeps of 1/60s
		// in BlobPhysics.tick), so sustained low-fps rendering down to ~7.5fps
		// keeps real-time motion speed instead of dilating simulated time. A
		// tab-resume jump is still bounded by the same engine substep cap.
		const dt = Math.min((currentTime - lastTime) / 1000, 8 / 60);
		lastTime = currentTime;

		if (physics) {
			physics.tick(dt, currentTime / 1000);
			blobs = physics.getBlobs(themeColors);
		}

		animationFrame = requestAnimationFrame(tick);
	}

	function startAnimation() {
		if (animationFrame) return;
		lastTime = performance.now();
		animationFrame = requestAnimationFrame(tick);
	}

	function stopAnimation() {
		if (animationFrame) {
			cancelAnimationFrame(animationFrame);
			animationFrame = null;
		}
	}

	$effect(() => {
		if (!browser || !shouldLoad) return;

		let disposed = false;
		const deviceMotionEnabled = enableDeviceMotion;
		const scrollPhysicsEnabled = enableScrollPhysics;
		const pointerPhysicsEnabled = enablePointerPhysics;
		let wheelListenerAttached = false;

		untrack(() => {
			// BlobPhysics owns base defaults; this component forwards caller overrides.
			const currentPhysics = new BlobPhysics(blobCount, physicsConfig);
			physics = currentPhysics;

			currentPhysics.init().then(() => {
				if (disposed || physics !== currentPhysics) return;

				const hasDeviceMotionCapability = detectDeviceMotionCapability();
				isReady = true;

				if (deviceMotionEnabled && hasDeviceMotionCapability) {
					if (!deviceMotion) {
						deviceMotion = createDeviceMotion();
						void deviceMotion.initialize();
					}
				}

				if (scrollPhysicsEnabled) {
					scrollHandler = new ScrollHandler();
				}

				if (effectiveAnimated) {
					startAnimation();
				} else if (physics) {
					blobs = physics.getBlobs(themeColors);
				}
			});

			if (scrollPhysicsEnabled) {
				window.addEventListener('wheel', handleScroll, { passive: true });
				wheelListenerAttached = true;
			}

			if (pointerPhysicsEnabled) {
				const hasPointerCapability = detectPointerPhysicsCapability(window);
				if (hasPointerCapability) {
					pointerController = createPointerPhysicsController({
						target: window,
						getBounds: getPointerBounds,
						supportsPointerEvents: 'PointerEvent' in window,
						updatePosition(position) {
							physics?.updateMousePosition(position.x, position.y);
						},
					});
				}
			}
		});

		return () => {
			disposed = true;
			stopAnimation();
			if (wheelListenerAttached) {
				window.removeEventListener('wheel', handleScroll);
			}
			pointerController?.dispose();
			pointerController = null;
			deviceMotion?.cleanup();
			deviceMotion = null;
			scrollHandler?.dispose();
			scrollHandler = null;
			physics?.dispose();
			physics = null;
			isReady = false;
			blobs = [];
		};
	});

	$effect(() => {
		if (!isReady) return;

		if (effectiveAnimated) {
			startAnimation();
		} else {
			// Seed one fresh static frame before stopping so the frozen frame
			// always reflects current themeColors, regardless of whether this
			// is the initial mount (animated=false / reduced-motion at ready
			// time) or a later transition into the stopped state — the static
			// path never depends on init-ordering between physics.init() and
			// this effect.
			if (physics) {
				blobs = physics.getBlobs(themeColors);
			}
			stopAnimation();
		}
	});

	// prefers-reduced-motion: listen for changes and feed the existing
	// static-frame path above via effectiveAnimated. Independent of the
	// physics mount effect so toggling respectReducedMotion never tears
	// down/recreates physics.
	$effect(() => {
		if (!browser || !shouldLoad) return;

		const dispose = watchReducedMotion((reduced) => {
			reducedMotionActive = reduced;
		});

		return () => {
			dispose();
		};
	});

	// Visibility gating (document.hidden + IntersectionObserver on the
	// container): pauses the rAF loop via the same effectiveAnimated path
	// when the tab is hidden or the element scrolls out of view, and
	// resumes cleanly on return — startAnimation() always resets lastTime,
	// so the existing dt clamp above prevents a jump on resume. Re-runs only
	// when containerElement itself changes (mount/teardown of the div), not
	// on every prop change.
	$effect(() => {
		if (!browser) return;

		const element = containerElement;
		const gate = new VisibilityGate(element, {
			onChange: (visible) => {
				isVisible = visible;
			},
		});
		isVisible = gate.isVisible();

		return () => {
			gate.dispose();
		};
	});
</script>

{#if shouldLoad && themeColors.length > 0}
	<div
		bind:this={containerElement}
		style:position="absolute"
		style:inset="0"
		style:width="100%"
		style:height="100%"
		style:overflow="hidden"
		style:pointer-events="none"
		style:opacity
		style:transition="opacity 0.8s ease-in-out"
		aria-hidden="true"
		role="presentation"
	>
		<BlobSVG {blobs} {physics} {isDark} />
	</div>
{/if}
