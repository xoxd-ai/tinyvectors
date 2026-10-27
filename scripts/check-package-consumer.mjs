import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = resolve(process.cwd(), process.argv[2] ?? './bazel-bin/pkg');
const svelteDir = resolve(repoRoot, 'node_modules/svelte');
// TypeScript 7 exposes only package.json and its version stub through the
// exports map, so resolve the `tsc` bin through package.json (RU13).
const tscPackageJson = require.resolve('typescript/package.json');
const tscManifest = JSON.parse(readFileSync(tscPackageJson, 'utf8'));
const tscPath = join(
	dirname(tscPackageJson),
	typeof tscManifest.bin === 'string' ? tscManifest.bin : tscManifest.bin.tsc,
);

if (!existsSync(resolve(packageDir, 'package.json'))) {
	console.error(`Package directory is missing package.json: ${packageDir}`);
	console.error('Run: nix develop . --command bazel build //:pkg (local, non-qualifying)');
	process.exit(1);
}

if (!existsSync(resolve(svelteDir, 'package.json'))) {
	console.error(`Svelte peer dependency is missing: ${svelteDir}`);
	console.error('Run: pnpm install');
	process.exit(1);
}

const tempDir = await mkdtemp(join(tmpdir(), 'tinyvectors-consumer-'));

try {
	await mkdir(join(tempDir, 'node_modules/@tummycrypt'), { recursive: true });
	await symlink(
		packageDir,
		join(tempDir, 'node_modules/@tummycrypt/tinyvectors'),
		process.platform === 'win32' ? 'junction' : 'dir',
	);
	await symlink(
		svelteDir,
		join(tempDir, 'node_modules/svelte'),
		process.platform === 'win32' ? 'junction' : 'dir',
	);

	await writeFile(
		join(tempDir, 'consumer-runtime.mjs'),
		`
import * as root from '@tummycrypt/tinyvectors';
import * as motion from '@tummycrypt/tinyvectors/motion';
import * as core from '@tummycrypt/tinyvectors/core';
import * as themes from '@tummycrypt/tinyvectors/themes';
import * as svelteComponents from '@tummycrypt/tinyvectors/svelte';
import { readFileSync } from 'node:fs';

const cssUrl = import.meta.resolve('@tummycrypt/tinyvectors/themes/css');
const css = readFileSync(new URL(cssUrl), 'utf8');
const requiredRoot = ['BlobPhysics', 'DeviceMotion', 'TinyVectors', 'THEME_PRESETS'];
const requiredMotion = ['DeviceMotion', 'ScrollHandler', 'mapClientPointToPhysics', 'createPointerPhysicsController'];
const tinylandColors = root.THEME_PRESETS?.tinyland?.colors?.map((color) => color.color) ?? [];
const missing = [
  ...requiredRoot.filter((name) => !(name in root)).map((name) => \`root:\${name}\`),
  ...requiredMotion.filter((name) => !(name in motion)).map((name) => \`motion:\${name}\`),
  ...(!('BlobPhysics' in core) ? ['core:BlobPhysics'] : []),
  ...(!('THEME_PRESETS' in themes) ? ['themes:THEME_PRESETS'] : []),
  ...(tinylandColors.includes('rgba(139, 92, 246, 0.55)') ? [] : ['root:THEME_PRESETS.tinyland.colors']),
  ...(themes.getThemePreset?.('tinyland') === themes.THEME_PRESETS?.tinyland ? [] : ['themes:getThemePreset']),
  ...(!('TinyVectors' in svelteComponents) ? ['svelte:TinyVectors'] : []),
  ...(!('BlobSVG' in svelteComponents) ? ['svelte:BlobSVG'] : []),
  ...(css.includes('--vector-tinyland-purple') ? [] : ['themes/css:variables']),
];

if (missing.length > 0) {
  throw new Error(\`Missing exports: \${missing.join(', ')}\`);
}
`.trimStart(),
	);

	await writeFile(
		join(tempDir, 'consumer-types.ts'),
		`
import { BlobPhysics, DeviceMotion, TinyVectors, THEME_PRESETS } from '@tummycrypt/tinyvectors';
import type { ScrollHandlerConfig as RootScrollHandlerConfig } from '@tummycrypt/tinyvectors';
import type { ThemePreset, ThemePresetName } from '@tummycrypt/tinyvectors/core';
import {
\tScrollHandler,
\tcreatePointerPhysicsController,
\tmapClientPointToPhysics,
\ttype MotionVector,
\ttype PointerBounds,
\ttype PointerCancelEventName,
\ttype ScrollHandlerConfig,
} from '@tummycrypt/tinyvectors/motion';
import { getThemePreset } from '@tummycrypt/tinyvectors/themes';
import {
\tBlobSVG,
\ttype BlobSVGProps,
\ttype TinyVectorsDeviceMotionStatus,
\ttype TinyVectorsProps,
} from '@tummycrypt/tinyvectors/svelte';
import type { ComponentProps } from 'svelte';

const bounds: PointerBounds = { left: 0, top: 0, width: 100, height: 100 };
const cancelEvent: PointerCancelEventName = 'pointercancel';
const scrollConfig: ScrollHandlerConfig = { decayRate: 0.9, maxForces: 2 };
const rootScrollConfig: RootScrollHandlerConfig = { maxForces: 0 };
const scrollHandler = new ScrollHandler(scrollConfig);
const point = mapClientPointToPhysics(50, 50, bounds);
const sample: MotionVector = { x: 0, y: 0, z: 1 };
const props: ComponentProps<typeof TinyVectors> = { theme: 'tinyland', enableDeviceMotion: true };
const explicitProps: TinyVectorsProps = props;
const motionStatus: TinyVectorsDeviceMotionStatus = {
\tenabled: true,
\tsupported: true,
\trequiresPermission: false,
\tpermissionState: 'granted',
\tactive: true,
};
const blobProps: BlobSVGProps = { blobs: [] };
const themeName: ThemePresetName = 'tinyland';
const themePreset: ThemePreset = THEME_PRESETS[themeName];
const names = [BlobPhysics, DeviceMotion, TinyVectors, BlobSVG, ScrollHandler, createPointerPhysicsController, THEME_PRESETS, getThemePreset, scrollHandler, scrollConfig, rootScrollConfig, point, sample, explicitProps, motionStatus, blobProps, themePreset, cancelEvent];
console.log(names.length);
`.trimStart(),
	);

	await writeFile(
		join(tempDir, 'tsconfig.json'),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2022',
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					strict: true,
					skipLibCheck: false,
					noEmit: true,
				},
				include: ['consumer-types.ts'],
			},
			null,
			2,
		)}\n`,
	);

	run(process.execPath, ['consumer-runtime.mjs'], tempDir);
	run(process.execPath, [tscPath, '-p', 'tsconfig.json'], tempDir);
	console.log(`package consumer check passed for ${packageDir}`);
} finally {
	if (process.env.TINYVECTORS_KEEP_CONSUMER_CHECK !== '1') {
		await rm(tempDir, { recursive: true, force: true });
	} else {
		console.log(`kept consumer check workspace: ${tempDir}`);
	}
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: 'inherit',
		env: process.env,
	});

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}
