import { defineConfig } from '@vscode/test-cli';

// Only integration tests run under the VS Code host. Unit tests use node:test
// and are run separately by `npm run test:unit`.
export default defineConfig({
	files: 'out/test/integration/**/*.test.js',
	mocha: { ui: 'tdd', timeout: 60_000 },
	// Containers commonly cap /dev/shm at 64 MB, which Chromium exhausts and
	// then dies with "renderer process gone (reason: crashed, code: 133)"
	// before a single test runs. Falling back to temp files avoids depending on
	// it. --no-sandbox is needed because these images run as root.
	launchArgs: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'],
});
