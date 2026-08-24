/**
 * Render the built webview against a real FCS file and save a screenshot.
 *
 * A webview cannot be inspected from the extension test host, so this loads
 * dist/webview.js in a real browser with acquireVsCodeApi stubbed and the
 * VS Code theme variables supplied, then drives the UI and screenshots it.
 *
 *   npm i -D puppeteer            # optional, not a project dependency
 *   npm run compile-tests && npm run compile
 *   node scripts/preview.mjs data/001.fcs --tab plots --theme dark --cards 3
 *
 * Headless Chrome cannot capture screenshots in some containers, so this runs
 * headed; use `xvfb-run -a node scripts/preview.mjs ...` where there is no
 * display.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (!file) {
	console.error('usage: node scripts/preview.mjs <file.fcs> [--tab plots|table|overview] [--theme dark|light] [--cards N] [--out dir]');
	process.exit(1);
}

let puppeteer;
try {
	puppeteer = (await import('puppeteer')).default;
} catch {
	console.error('This script needs puppeteer, which is deliberately not a project dependency.\nInstall it on demand:  npm i -D puppeteer');
	process.exit(1);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const tab = flag('tab', 'plots');
const theme = flag('theme', 'dark');
const cards = Number(flag('cards', '1'));
/** Render the no-samples state instead of loading the file. */
const empty = args.includes('--empty');
/** Render the all-samples-failed state. */
const failed = args.includes('--failed');
/**
 * Simulate a window without WebGL. 'null' returns no context, 'throw' makes
 * getContext raise (hardened renderers do), 'noext' hands back a context that
 * is missing an extension scattergl requires.
 */
const noWebgl = args.includes('--no-webgl') ? flag('no-webgl', 'null') : undefined;
/** Switch every card to this plot type through the inspector dropdown. */
const kind = flag('kind', undefined);
/** Switch every axis to this transform through the inspector dropdown. */
const transform = flag('transform', undefined);
/**
 * Re-deliver the sample once every card exists, which is the case the draw
 * queue is for: a sample switch makes every card redraw in one commit.
 * Long-task counters are reset just before, so they measure only that.
 */
const reload = args.includes('--reload');
/**
 * After the plot settles, change the UMAP colour channel and report whether the
 * embedding was recomputed. Recolouring must be free.
 */
const recolor = flag('recolor', undefined);
/** Type a value into an inspector number field, e.g. --set "M (decades)=2". */
const setField = args.filter((a, i) => args[i - 1] === '--set');
const outDir = path.resolve(flag('out', path.join(ROOT, 'preview')));
fs.mkdirSync(outDir, { recursive: true });

for (const needed of ['dist/webview.js', 'dist/webview.css', 'out/common/fcs/index.js']) {
	if (!fs.existsSync(path.join(ROOT, needed))) {
		console.error(`Missing ${needed}. Run: npm run compile-tests && npm run compile`);
		process.exit(1);
	}
}

const { parseFcs, invertSpillover } = await import(`${ROOT}/out/common/fcs/index.js`);
const { computeBasicStats, fillQuantiles } = await import(`${ROOT}/out/common/fcs/stats.js`);
const { channelColumn } = await import(`${ROOT}/out/common/fcs/types.js`);
const { buildPermutation, gatherSlice } = await import(`${ROOT}/out/common/sampling.js`);

const ds = parseFcs(new Uint8Array(fs.readFileSync(file)));
const stats = ds.metadata.channels
	.map((c) => computeBasicStats(channelColumn(ds, c.index), c.index))
	.map((s) => fillQuantiles(s, channelColumn(ds, s.channel)));
const sp = ds.metadata.spillover;
// Only the subsample crosses the wire, exactly as the host sends it.
const SAMPLE_N = Number(flag('sample', '5000'));
const gathered = gatherSlice(
	ds.matrix,
	ds.eventCount,
	ds.channelCount,
	buildPermutation(ds.eventCount, 0x5eed),
	SAMPLE_N,
);
const meta = {
	id: 's1',
	fileName: path.basename(file),
	uri: `file://${path.resolve(file)}`,
	metadata: ds.metadata,
	eventCount: ds.eventCount,
	channelCount: ds.channelCount,
	sampledCount: gathered.count,
	stats,
	spillover: sp,
	spilloverInverse: sp ? Array.from(invertSpillover(sp, [])) : undefined,
	defaults: {
		sampleSize: SAMPLE_N,
		cofactor: /cytof|helios|fluidigm/i.test(ds.metadata.cytometer ?? '') ? 5 : 150,
	},
	maxSliceBytes: 16 * 1024 * 1024,
};

// VS Code injects these on :root and puts the theme class on <body>. Defining
// them on body instead would leave the :root mappings in theme.css unable to
// see them, silently falling back to the built-in defaults.
const THEMES = {
	dark: `:root{--vscode-editor-background:#1f1f1f;--vscode-editor-foreground:#ccc;
 --vscode-descriptionForeground:#9d9d9d;--vscode-panel-border:#2b2b2b;
 --vscode-editorWidget-background:#252526;--vscode-list-hoverBackground:#2a2d2e;
 --vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;
 --vscode-focusBorder:#0078d4;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;
 --vscode-input-border:#3c3c3c;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;
 --vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;
 --vscode-charts-blue:#3794ff;--vscode-charts-foreground:#ccc;--vscode-charts-lines:#3a3a3a;
 --vscode-inputValidation-warningBackground:#352a05;--vscode-inputValidation-warningBorder:#b89500;
 --vscode-inputValidation-errorBorder:#be1100;}`,
	light: `:root{--vscode-editor-background:#fff;--vscode-editor-foreground:#3b3b3b;
 --vscode-descriptionForeground:#717171;--vscode-panel-border:#e5e5e5;
 --vscode-editorWidget-background:#f8f8f8;--vscode-list-hoverBackground:#f2f2f2;
 --vscode-list-activeSelectionBackground:#0060c0;--vscode-list-activeSelectionForeground:#fff;
 --vscode-focusBorder:#0090f1;--vscode-input-background:#fff;--vscode-input-foreground:#3b3b3b;
 --vscode-input-border:#cecece;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;
 --vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;
 --vscode-charts-blue:#1a85ff;--vscode-charts-foreground:#3b3b3b;--vscode-charts-lines:#dcdcdc;
 --vscode-inputValidation-warningBackground:#fdf6d3;--vscode-inputValidation-warningBorder:#b89500;
 --vscode-inputValidation-errorBorder:#e51400;}`,
};
const VARS = `${THEMES[theme] ?? THEMES.dark}
:root{--vscode-editor-font-family:monospace;--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;}`;

// The matrix is served as binary rather than serialised through the devtools
// protocol, which would take minutes for a 31MB file.
const matrixBuf = Buffer.from(gathered.values.buffer, gathered.values.byteOffset, gathered.values.byteLength);
const idsBuf = Buffer.from(gathered.eventIds.buffer, gathered.eventIds.byteOffset, gathered.eventIds.byteLength);
const server = http.createServer((req, res) => {
	if (req.url === '/') {
		res.setHeader('content-type', 'text/html');
		res.end(`<!DOCTYPE html><html><head><link rel="stylesheet" href="/webview.css">
<style>${VARS}</style></head><body class="vscode-${theme}"><div id="root"></div>
<script>
	window.__posted = [];
	window.acquireVsCodeApi = () => ({
		postMessage: (m) => window.__posted.push(m),
		getState: () => undefined, setState: (s) => { window.__persisted = s; },
	});
</script>
<script src="/webview.js"></script>
<script>
	(async () => {
		const meta = await (await fetch('/meta.json')).json();
		const buf = await (await fetch('/matrix.bin')).arrayBuffer();
		const ids = await (await fetch('/ids.bin')).arrayBuffer();
		if (meta.spilloverInverse) { meta.spilloverInverse = new Float64Array(meta.spilloverInverse); }
		const EMPTY = ${empty};
		const FAILED = ${failed};
		window.postMessage({ type: 'fcs/samples', protocolVersion: 1,
			panelId: 'preview-panel',
			activeId: EMPTY || FAILED ? undefined : 's1',
			samples: EMPTY ? [] : [{
				id: 's1', fileName: meta.fileName, uri: meta.uri, eventCount: meta.eventCount,
				channelCount: meta.channelCount, cytometer: meta.metadata.cytometer,
				...(FAILED ? { error: 'Required FCS keyword $PAR is missing.' } : {}) }] }, '*');
		window.__postSample = () => window.postMessage({ type: 'fcs/sample', payload: { ...meta, slice: {
			sampleId: 's1', requestId: 0,
			sampledCount: meta.sampledCount, eventCount: meta.eventCount,
			channelCount: meta.channelCount,
			matrix: new Uint8Array(buf), eventIds: new Uint8Array(ids), seed: 0x5eed,
		} } }, '*');
		if (!EMPTY && !FAILED) {
			window.__postSample();
		}
		window.__ready = true;
	})();
</script></body></html>`);
		return;
	}
	if (req.url === '/meta.json') {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(meta));
		return;
	}
	if (req.url === '/matrix.bin') {
		res.setHeader('content-type', 'application/octet-stream');
		res.end(matrixBuf);
		return;
	}
	if (req.url === '/ids.bin') {
		res.setHeader('content-type', 'application/octet-stream');
		res.end(idsBuf);
		return;
	}
	const asset = path.join(ROOT, 'dist', req.url.replace(/^\//, ''));
	if (asset.startsWith(path.join(ROOT, 'dist')) && fs.existsSync(asset)) {
		res.setHeader('content-type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
		res.end(fs.readFileSync(asset));
		return;
	}
	res.statusCode = 404;
	res.end('not found');
});
await new Promise((r) => server.listen(0, r));
const { port } = server.address();

const browser = await puppeteer.launch({
	headless: false,
	protocolTimeout: 180_000,
	args: [
		'--no-sandbox',
		'--disable-dev-shm-usage',
		// --disable-gpu alone is not enough: Chrome silently falls back to
		// SwiftShader, which would make an untested fallback look tested.
		...(noWebgl
			? ['--disable-gpu', '--disable-software-rasterizer', '--disable-3d-apis']
			: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
	],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });

// Long tasks are the honest measure of "the UI froze": anything over 50 ms is
// a frame the window could not paint or respond in.
await page.evaluateOnNewDocument(() => {
	window.__longTasks = [];
	try {
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) {
				window.__longTasks.push(Math.round(e.duration));
			}
		}).observe({ entryTypes: ['longtask'] });
	} catch {
		// Not every build exposes the longtask entry type.
	}
});


if (noWebgl) {
	// Belt and braces over the flags: deterministic, survives Chrome changes,
	// and lets all three real failure shapes be exercised.
	await page.evaluateOnNewDocument((mode) => {
		const real = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
			if (!/webgl/i.test(String(type))) {
				return real.call(this, type, ...rest);
			}
			if (mode === 'throw') {
				throw new Error('GPU process unavailable');
			}
			if (mode === 'noext') {
				const gl = real.call(this, type, ...rest);
				if (gl) {
					const get = gl.getExtension.bind(gl);
					gl.getExtension = (n) => (n === 'ANGLE_instanced_arrays' ? null : get(n));
				}
				return gl;
			}
			return null;
		};
	}, noWebgl);
}
const problems = [];
page.on('pageerror', (e) => { problems.push(e.message); console.error('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 120_000 });
if (!empty && !failed) {
	await page.waitForFunction(
		() => document.querySelectorAll('.plot-card:not(.add-card)').length > 0,
		{ timeout: 120_000 },
	);
}

for (let i = 1; i < (empty || failed ? 1 : cards); i++) {
	// The header's "+ Plot" button is gone; adding a card is the tile at the
	// end of the grid.
	await page.click('.plot-card.add-card');
	await new Promise((r) => setTimeout(r, 600));
}
async function setSelect(labelText, value) {
	const changed = await page.evaluate((label, v) => {
		const found = [...document.querySelectorAll('.inspector label')]
			.filter((l) => l.textContent.trim().startsWith(label))
			.map((l) => l.querySelector('select'))
			.filter(Boolean);
		for (const sel of found) {
			sel.value = v;
			sel.dispatchEvent(new Event('change', { bubbles: true }));
		}
		return found.length;
	}, labelText, value);
	await new Promise((r) => setTimeout(r, 1200));
	return changed;
}

// Driven one card at a time: the inspector only ever edits the selected card.
for (const [label, value] of [['Plot type', kind], ['Transform', transform]]) {
	if (!value) {
		continue;
	}
	const ids = await page.evaluate(() => [...document.querySelectorAll('.plot-card:not(.add-card)')].length);
	for (let i = 0; i < ids; i++) {
		await page.evaluate((n) => document.querySelectorAll('.plot-card:not(.add-card)')[n]?.click(), i);
		await new Promise((r) => setTimeout(r, 200));
		await setSelect(label, value);
	}
}

for (const pair of setField) {
	const [label, value] = pair.split('=');
	await page.evaluate((l, v) => {
		for (const field of document.querySelectorAll('.number-field')) {
			if (!field.textContent.trim().startsWith(l)) {
				continue;
			}
			const input = field.querySelector('input');
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
			setter.call(input, v);
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('blur', { bubbles: true }));
		}
	}, label, value);
	await new Promise((r) => setTimeout(r, 1500));
}

if (tab !== 'plots') {
	await page.evaluate((t) => {
		[...document.querySelectorAll('.tab')].find((b) => b.textContent.toLowerCase() === t)?.click();
	}, tab);
}
if (reload) {
	if (args.includes('--profile')) {
		await page.evaluate(() => window.__longTasks.length === 0);
		const client = await page.createCDPSession();
		await client.send('Profiler.enable');
		await client.send('Profiler.setSamplingInterval', { interval: 200 });
		await client.send('Profiler.start');
		await page.evaluate(() => { window.__longTasks.length = 0; window.__postSample(); });
		await new Promise((r) => setTimeout(r, 6000));
		const { profile } = await client.send('Profiler.stop');
		const self = new Map();
		const byId = new Map(profile.nodes.map((n) => [n.id, n]));
		const total = (profile.timeDeltas ?? []).reduce((a, b) => a + b, 0);
		for (let i = 0; i < (profile.samples ?? []).length; i++) {
			const n = byId.get(profile.samples[i]);
			const dt = (profile.timeDeltas[i] ?? 0) / 1000;
			const f = n?.callFrame;
			const key = f ? `${f.functionName || '(anon)'} @ ${String(f.url).split('/').pop()}:${f.lineNumber}` : '?';
			self.set(key, (self.get(key) ?? 0) + dt);
		}
		console.log('profile total ms:', Math.round(total / 1000));
		console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)
			.map(([k, v]) => `${String(Math.round(v)).padStart(6)}ms  ${k}`).join('\n'));
		process.exit(0);
	}
	await page.evaluate(() => {
		window.__longTasks.length = 0;
		window.__reloadStart = performance.now();
		window.__postSample();
	});
	await new Promise((r) => setTimeout(r, 6000));
}

const renderStart = Date.now();
await new Promise((r) => setTimeout(r, tab === 'plots' ? (kind === 'umap' ? 25000 : 3000 + cards * 1200) : 2500));
const settleMs = Date.now() - renderStart;

if (recolor) {
	// Colour is a Float64Array, so Array.isArray is false for it; length is
	// the honest test of "one value per point".
	const probe = () => {
		const t = document.querySelector('.js-plotly-plot')?.data?.[0];
		return {
			progress: document.querySelectorAll('.umap-progress').length,
			firstPoint: t?.x?.[0],
			colourLen: t?.marker?.color?.length ?? 0,
			firstColour: t?.marker?.color?.[0],
		};
	};
	const before = await page.evaluate(probe);
	await setSelect('Colour by', recolor);
	// Deliberately short: a recompute would still be visibly in progress here.
	await new Promise((r) => setTimeout(r, 1500));
	const after = await page.evaluate(probe);
	console.log('recolor check:', JSON.stringify({
		progressBefore: before.progress,
		progressAfter: after.progress,
		coordsUnchanged: before.firstPoint === after.firstPoint,
		perPointColour: after.colourLen,
		colourActuallyChanged: before.firstColour !== after.firstColour,
	}));
}

if (args.includes('--resize-probe')) {
	const widths = () => page.evaluate(() => ({
		samples: Math.round(document.querySelector('.samples')?.getBoundingClientRect().width ?? 0),
		inspector: Math.round(document.querySelector('.inspector')?.getBoundingClientRect().width ?? 0),
		grid: Math.round(document.querySelector('.plot-grid-scroll')?.getBoundingClientRect().width ?? 0),
		separators: document.querySelectorAll('[role="separator"][aria-orientation="vertical"]').length,
		saved: (() => {
			const s = window.__persisted;
			return s?.layout ? `${s.layout.samplesWidth}/${s.layout.inspectorWidth}` : 'none';
		})(),
	}));
	// Drag the nth splitter by dx, the way a pointer really does it.
	const tasks = () => page.evaluate(() => ({
		count: window.__longTasks.length,
		longestMs: Math.max(0, ...window.__longTasks),
		blockedMs: window.__longTasks.reduce((a, d) => a + d, 0),
	}));
	const drag = async (n, dx) => {
		const box = await page.evaluate((i) => {
			const el = document.querySelectorAll('.resizer')[i];
			const r = el.getBoundingClientRect();
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		}, n);
		await page.mouse.move(box.x, box.y);
		await page.mouse.down();
		await page.evaluate(() => { window.__longTasks.length = 0; });
		for (let i = 1; i <= 8; i++) {
			await page.mouse.move(box.x + (dx * i) / 8, box.y);
			await new Promise((r) => setTimeout(r, 16));
		}
		const during = await tasks();
		await page.mouse.up();
		await new Promise((r) => setTimeout(r, 800));
		const after = await tasks();
		console.log(`  drag ${n} ${dx > 0 ? '+' : ''}${dx}: during=${JSON.stringify(during)} total=${JSON.stringify(after)}`);
		await page.evaluate(() => { window.__longTasks.length = 0; });
	};
	console.log('resize before:', JSON.stringify(await widths()));
	// Long tasks from here on are the drag's own: a live resize re-lays out
	// every visible Plotly card, which is what the draw queue is guarding.
	await page.evaluate(() => { window.__longTasks.length = 0; });
	await drag(0, 120);
	console.log('after dragging the samples splitter +120:', JSON.stringify(await widths()));
	await drag(1, -100);
	console.log('after dragging the inspector splitter -100:', JSON.stringify(await widths()));
	// Beyond the maximum, and then a double-click to reset.
	await drag(0, 2000);
	console.log('after dragging the samples splitter far past its max:', JSON.stringify(await widths()));
	await page.evaluate(() => {
		const el = document.querySelectorAll('.resizer')[0];
		el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
	});
	await new Promise((r) => setTimeout(r, 500));
	console.log('after double-clicking it:', JSON.stringify(await widths()));
	// Keyboard, which is the whole reason for role=separator.
	await page.evaluate(() => document.querySelectorAll('.resizer')[0].focus());
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await new Promise((r) => setTimeout(r, 400));
	console.log('after two ArrowRights:', JSON.stringify(await widths()));
	const stale = () => page.evaluate(() =>
		[...document.querySelectorAll('.js-plotly-plot')].map((el) => ({
			layout: Math.round(el._fullLayout?.width ?? 0),
			box: Math.round(el.getBoundingClientRect().width),
		})).filter((p) => Math.abs(p.layout - p.box) > 1).length);
	console.log('stale plots immediately:', await stale());
	await new Promise((r) => setTimeout(r, 2000));
	console.log('stale plots after 2s:', await stale());
	await new Promise((r) => setTimeout(r, 5000));
	console.log('stale plots after 7s:', await stale());
	// The whole point of resuming the queue: every plot must end up at the
	// size its container actually has.
	console.log('plot sizes match containers after the drag:', JSON.stringify(await page.evaluate(() =>
		[...document.querySelectorAll('.js-plotly-plot')].map((el) => ({
			layout: Math.round(el._fullLayout?.width ?? 0),
			box: Math.round(el.getBoundingClientRect().width),
		})).filter((p) => Math.abs(p.layout - p.box) > 1))));
	console.log('drag long tasks:', JSON.stringify(await page.evaluate(() => ({
		count: window.__longTasks.length,
		longestMs: Math.max(0, ...window.__longTasks),
		blockedMs: window.__longTasks.reduce((a, d) => a + d, 0),
	}))));
}

if (args.includes('--compensate-probe')) {
	const read = () => ({
		checked: [...document.querySelectorAll('.app-header label')]
			.find((l) => l.textContent.includes('Compensate'))?.querySelector('input')?.checked,
		disabled: [...document.querySelectorAll('.app-header label')]
			.find((l) => l.textContent.includes('Compensate'))?.querySelector('input')?.disabled,
		inactive: [...document.querySelectorAll('.app-header label')]
			.find((l) => l.textContent.includes('Compensate'))?.classList.contains('inactive'),
		chips: [...document.querySelectorAll('.status-bar button, .status-chip')].map((c) => c.textContent.trim()),
	});
	console.log('compensate before:', JSON.stringify(await page.evaluate(read)));
	await page.evaluate(() => {
		[...document.querySelectorAll('.app-header label')]
			.find((l) => l.textContent.includes('Compensate'))?.querySelector('input')?.click();
	});
	await new Promise((r) => setTimeout(r, 800));
	console.log('compensate after:', JSON.stringify(await page.evaluate(read)));
}

if (args.includes('--umap-ui')) {
	console.log('umap ui probe:', JSON.stringify(await page.evaluate(() => {
		const plot = document.querySelector('.js-plotly-plot');
		const rows = [...document.querySelectorAll('.umap-channels .check')].map((l) => {
			const name = l.querySelector('.channel-name');
			return {
				title: l.getAttribute('title'),
				text: l.textContent.trim(),
				on: l.querySelector('input')?.checked ?? false,
				absent: l.classList.contains('absent'),
				clipped: name ? name.scrollWidth > name.clientWidth : false,
			};
		});
		const cells = [...document.querySelectorAll('.inspector label')]
			.find((l) => l.textContent.trim().startsWith('Max cells'));
		return {
			scrollZoom: plot?._context?.scrollZoom,
			doubleClick: plot?._context?.doubleClick,
			modebar: [...document.querySelectorAll('.modebar-btn')].map((b) => b.getAttribute('data-attr') || b.getAttribute('data-title')),
			cellsLabel: cells?.textContent.trim().split('\n')[0],
			cellsTitle: cells?.getAttribute('title')?.slice(0, 40),
			cellOptions: [...(cells?.querySelectorAll('option') ?? [])].map((o) => o.textContent),
			cellValue: cells?.querySelector('select')?.value,
			colorSelect: [...document.querySelectorAll('.inspector label')]
				.filter((l) => l.textContent.trim().startsWith('Colour by'))
				.flatMap((l) => [...(l.querySelector('select')?.children ?? [])]
					.slice(0, 4)
					.map((o) => (o.tagName === 'HR' ? '---' : o.textContent))),
			dividers: document.querySelectorAll('.umap-channels .list-divider').length,
			rowsBeforeDivider: (() => {
				const kids = [...(document.querySelector('.umap-channels')?.children ?? [])];
				const i = kids.findIndex((k) => k.tagName === 'HR');
				return i < 0 ? null : i;
			})(),
			fieldTitles: [...document.querySelectorAll('.inspector .number-field')]
				.map((f) => `${f.textContent.trim()}: ${(f.getAttribute('title') ?? '').slice(0, 30)}`),
			hintParagraphs: [...document.querySelectorAll('.inspector .hint')].map((h) => h.textContent.trim().slice(0, 40)),
			rowCount: rows.length,
			selected: rows.filter((r) => r.on).length,
			anyClipped: rows.some((r) => r.clipped),
			sample: rows.slice(0, 3),
		};
	}), null, 1));
}

const label = empty ? 'empty' : failed ? 'failed' : noWebgl ? `nogl-${noWebgl}` : tab;
const shot = path.join(outDir, `${path.basename(file, path.extname(file))}-${theme}-${label}.png`);
await page.screenshot({ path: shot });
const report = await page.evaluate(() => ({
	header: document.querySelector('.app-title')?.innerText.replace(/\n/g, ' | '),
	// .add-card carries the plot-card class, so discount it.
	cards: document.querySelectorAll('.plot-card:not(.add-card)').length,
	plots: document.querySelectorAll('.js-plotly-plot').length,
	unresolved: document.querySelectorAll('.plot-missing').length,
	// The whole point of the fallback: Plotly's white "WebGL is not supported"
	// box must never appear.
	noWebglBoxes: document.querySelectorAll('.no-webgl').length,
	badges: [...document.querySelectorAll('.plot-badge')].map((b) => b.innerText.replace(/\n/g, ' ')),
	summaries: [...document.querySelectorAll('.plot-card-summary')].map((b) => b.innerText),
	emptyState: document.querySelector('.empty-state')?.innerText.replace(/\n/g, ' | '),
	progress: [...document.querySelectorAll('.umap-progress')].map((e) => e.innerText),
	workspaceName: document.querySelector('.workspace-name')?.innerText,
	longTasks: (window.__longTasks ?? []).length,
	longestTaskMs: Math.max(0, ...(window.__longTasks ?? [])),
	blockedMs: (window.__longTasks ?? []).reduce((a, b) => a + Math.max(0, b - 50), 0),
}));
console.log(JSON.stringify({ ...report, settleMs }, null, 1));
if (problems.length > 0) {
	console.log('page errors:', problems.slice(0, 5));
}
console.log('wrote', shot);

await browser.close();
server.close();
