import { readFileSync } from 'node:fs';

const read = (relativePath) =>
	readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const packageJson = JSON.parse(read('../package.json'));
const moduleBazel = read('../MODULE.bazel');
const buildBazel = read('../BUILD.bazel');
const ciWorkflow = read('../.github/workflows/ci.yml');
const publishWorkflow = read('../.github/workflows/publish.yml');
const changelog = read('../CHANGELOG.md');
const expectedPnpmVersion = packageJson.packageManager?.replace(/^pnpm@/, '');
const expectedNodeMajor = packageJson.engines?.node?.match(/>=\s*(\d+)/)?.[1];
const expectedBazelTargets =
	'//:pkg //:package_consumer_check //:bundle_size_check //:typecheck //:test';
const expectedPackageDir = './bazel-bin/pkg';
const expectedPackageConsumerCommand = 'node scripts/check-package-consumer.mjs ./bazel-bin/pkg';
const expectedPackageCheckCommand = 'pnpm run check:package && pnpm run check:bundle-size';
const expectedPrepublishOnlyCommand =
	'pnpm run check:release-metadata && pnpm run build && pnpm run check:package && pnpm run check:bundle-size';
const expectedSharedWorkflowInputs = {
	runner_mode: 'repo_owned',
	runner_labels_json: '${{ vars.PRIMARY_LINUX_RUNNER_LABELS_JSON }}',
	workspace_mode: 'isolated',
	publish_mode: 'hosted_exception',
	npm_publish_mode: 'disabled',
	node_versions: `["${expectedNodeMajor}"]`,
	publish_node_version: expectedNodeMajor,
	pnpm_version: expectedPnpmVersion,
	metadata_check_command: 'pnpm run check:release-metadata',
	typecheck_command: 'pnpm run check',
	unit_test_command: 'pnpm run test',
	build_command: 'pnpm run build',
	package_check_command: expectedPackageCheckCommand,
	bazel_targets: expectedBazelTargets,
	package_dir: expectedPackageDir,
	npm_access: 'public',
};

const extract = (source, pattern, label) => {
	const match = source.match(pattern);
	if (!match?.[1]) {
		throw new Error(`Unable to find ${label}`);
	}
	return match[1];
};

// Tolerates a non-version heading on top (e.g. "## Unreleased") as long as a
// "## <version>" heading exists somewhere in the file; a missing or malformed
// changelog reports a tidy mismatch line below instead of throwing (which
// used to surface as an uncaught-exception stack trace rather than the gate's
// usual "expected"/"found" failure output). Compares whole heading tokens
// (not a `\b`-bounded prefix) so e.g. "## 0.3.6-rc.1" never satisfies a
// "0.3.6" requirement.
const findChangelogVersionHeadingStatus = (source, version) => {
	const headingVersions = [...source.matchAll(/^##\s+(\S+)/gm)].map((match) => match[1]);

	if (headingVersions.length === 0) {
		return 'no "## " heading found in CHANGELOG.md';
	}

	return headingVersions.includes(version) ? version : `no "## ${version}" heading found`;
};

const extractWorkflowValue = (source, key, label) => {
	const rawValue = extract(source, new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'), label).trim();
	if (
		(rawValue.startsWith("'") && rawValue.endsWith("'")) ||
		(rawValue.startsWith('"') && rawValue.endsWith('"'))
	) {
		return rawValue.slice(1, -1);
	}
	return rawValue;
};

const sharedPackageWorkflow = (source, label) =>
	extract(
		source,
		/uses:\s*((?:tinyland-inc|xoxd-ai)\/ci-templates\/\.github\/workflows\/js-bazel-package\.yml@(?:[0-9a-f]{40}|v\d+\.\d+\.\d+))/,
		label,
	);

const checks = [
	{
		label: 'MODULE.bazel version',
		actual: extract(
			moduleBazel,
			/module\([\s\S]*?version = "([^"]+)"/m,
			'module version',
		),
		expected: packageJson.version,
	},
	{
		label: 'BUILD.bazel npm_package version',
		actual: extract(
			buildBazel,
			/npm_package\([\s\S]*?version = "([^"]+)"/m,
			'npm_package version',
		),
		expected: packageJson.version,
	},
	{
		label: 'BUILD.bazel npm_package name',
		actual: extract(
			buildBazel,
			/npm_package\([\s\S]*?package = "([^"]+)"/m,
			'npm_package name',
		),
		expected: packageJson.name,
	},
	{
		label: "CHANGELOG.md '## <version>' heading",
		actual: findChangelogVersionHeadingStatus(changelog, packageJson.version),
		expected: packageJson.version,
	},
	{
		label: 'MODULE.bazel pnpm version',
		actual: extract(moduleBazel, /pnpm_version = "([^"]+)"/, 'pnpm_version'),
		expected: expectedPnpmVersion,
	},
	{
		label: 'MODULE.bazel Node toolchain major',
		actual: extract(moduleBazel, /node_version = "(\d+)\./, 'node_version'),
		expected: expectedNodeMajor,
	},
	{
		label: 'CI reusable package workflow',
		actual: sharedPackageWorkflow(ciWorkflow, 'CI reusable workflow'),
		expected: sharedPackageWorkflow(publishWorkflow, 'publish reusable workflow'),
	},
	{
		label: 'package consumer check script',
		actual: packageJson.scripts?.['check:package-consumer'],
		expected: expectedPackageConsumerCommand,
	},
	{
		label: 'bundle size check script',
		actual: packageJson.scripts?.['check:bundle-size'],
		expected: 'node scripts/check-bundle-size.mjs',
	},
	{
		label: 'prepublishOnly script',
		actual: packageJson.scripts?.prepublishOnly,
		expected: expectedPrepublishOnlyCommand,
	},
	{
		label: 'CI publish dry-run',
		actual: extractWorkflowValue(ciWorkflow, 'dry_run', 'CI dry_run'),
		expected: 'true',
	},
	{
		label: 'tag publish dry-run',
		actual: extractWorkflowValue(publishWorkflow, 'dry_run', 'publish dry_run'),
		expected: 'false',
	},
];

for (const [key, expected] of Object.entries(expectedSharedWorkflowInputs)) {
	checks.push(
		{
			label: `CI ${key}`,
			actual: extractWorkflowValue(ciWorkflow, key, `CI ${key}`),
			expected,
		},
		{
			label: `publish ${key}`,
			actual: extractWorkflowValue(publishWorkflow, key, `publish ${key}`),
			expected,
		},
	);
}

// GitHub Packages channel retired 2026-07-25 (TIN-3165); the input must stay absent in both workflows.
for (const [label, source] of [
	['CI', ciWorkflow],
	['publish', publishWorkflow],
]) {
	checks.push({
		label: `${label} github_package_name`,
		actual: /^\s*github_package_name:/m.test(source) ? 'present' : 'absent',
		expected: 'absent',
	});
}

const failures = checks.filter((check) => check.actual !== check.expected);

if (packageJson.publishConfig?.provenance && !/id-token:\s*write/.test(publishWorkflow)) {
	failures.push({
		label: 'publish workflow id-token permission',
		actual: 'missing',
		expected: 'write',
	});
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(
			`${failure.label} mismatch: expected "${failure.expected}", found "${failure.actual}"`,
		);
	}
	process.exit(1);
}

console.log(
	`release metadata aligned for ${packageJson.name}@${packageJson.version} (pnpm ${expectedPnpmVersion})`,
);
