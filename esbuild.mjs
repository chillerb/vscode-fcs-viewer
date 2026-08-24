import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
/**
 * Opt back in to React's development runtime.
 *
 * Off by default, including for debug builds, which is unusual and deliberate.
 * React 19's dev build serialises component props for its Performance track,
 * and the props here include the typed arrays handed to Plotly -- walking six
 * cards' worth of 5,000-element arrays froze the webview for about two seconds
 * on every sample switch. Measured on a 146k-event file: 2,054 ms of blocked
 * main thread with the dev runtime, 0 ms without. Nothing else came close.
 *
 * The cost of the default is losing React's dev warnings in the Extension
 * Host; pass --react-dev when chasing a React problem specifically.
 */
const reactDev = process.argv.includes('--react-dev');

/** Reports build status in a shape the $esbuild-watch problem matcher understands. */
const problemMatcherPlugin = {
	name: 'problem-matcher',
	setup(build) {
		build.onStart(() => console.log('[watch] build started'));
		build.onEnd((result) => {
			for (const { text, location } of result.errors) {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			}
			console.log('[watch] build finished');
		});
	},
};

const shared = {
	bundle: true,
	minify: production,
	sourcemap: production ? false : 'linked',
	logLevel: 'silent',
	plugins: [problemMatcherPlugin],
};

const contexts = await Promise.all([
	esbuild.context({
		...shared,
		entryPoints: ['src/extension/extension.ts'],
		outfile: 'dist/extension.js',
		format: 'cjs',
		platform: 'node',
		target: 'node22',
		external: ['vscode'],
	}),
	esbuild.context({
		...shared,
		entryPoints: ['src/webview/index.tsx'],
		outfile: 'dist/webview.js',
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		jsx: 'automatic',
		loader: { '.css': 'css' },
		// React 19 reads process.env.NODE_ENV; without this the webview dies
		// with "process is not defined" and renders a blank panel. See
		// reactDev above for why debug builds still get the production runtime.
		define: {
			'process.env.NODE_ENV': reactDev ? '"development"' : '"production"',
			// Plotly's dependency tree reaches node's `global`. The prebuilt
			// dist bundles resolve it; assembling from lib/core does not.
			global: 'globalThis',
		},
		// Plotly's scattergl reaches typedarray-pool, which requires node's
		// 'buffer'. See src/webview/render/bufferShim.ts.
		alias: { buffer: './src/webview/render/bufferShim.ts' },
	}),
]);

if (watch) {
	await Promise.all(contexts.map((c) => c.watch()));
} else {
	await Promise.all(contexts.map((c) => c.rebuild()));
	await Promise.all(contexts.map((c) => c.dispose()));
}
