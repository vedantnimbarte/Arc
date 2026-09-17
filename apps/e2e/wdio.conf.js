// Smoke tests against the real ARC binary, driven through tauri-driver
// (WebView2 via msedgedriver on Windows, WebKitWebDriver on Linux; macOS has
// no WebDriver for WKWebView). See https://v2.tauri.app/develop/tests/webdriver/
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');
const targetDir = process.env.CARGO_TARGET_DIR || join(repoRoot, 'target');
const application = join(
  targetDir,
  'debug',
  process.platform === 'win32' ? 'arc-desktop.exe' : 'arc-desktop',
);

// A throwaway data dir, so nothing reads or writes the user's real database,
// logs or window geometry. The launcher makes it; workers inherit the env var
// (this file loads in both), and the app inherits it through tauri-driver ->
// native driver -> app.
process.env.ARC_DATA_DIR ||= mkdtempSync(join(tmpdir(), 'arc-e2e-'));

let tauriDriver;

export const config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: 4444,
  specs: ['./specs/**/*.e2e.js'],
  maxInstances: 1,
  capabilities: [
    {
      'tauri:options': { application },
      // tauri-driver speaks classic WebDriver only, no BiDi.
      'wdio:enforceWebDriverClassic': true,
    },
  ],
  logLevel: 'warn',
  // A cold debug build can take a while to show its first window.
  connectionRetryTimeout: 180_000,
  connectionRetryCount: 3,
  waitforTimeout: 30_000,
  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 180_000 },

  // Build the debug binary with the test hook (`window.__arcTest`) compiled in.
  onPrepare() {
    const res = spawnSync('pnpm', ['tauri', 'build', '--debug', '--no-bundle'], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, VITE_ARC_E2E: '1' },
    });
    if (res.status !== 0) throw new Error(`debug build failed (exit ${res.status})`);
  },

  beforeSession() {
    const args = process.env.NATIVE_DRIVER ? ['--native-driver', process.env.NATIVE_DRIVER] : [];
    tauriDriver = spawn('tauri-driver', args, { stdio: [null, process.stdout, process.stderr] });
  },

  afterSession() {
    tauriDriver?.kill();
  },

  onComplete() {
    try {
      rmSync(process.env.ARC_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      // A webview process still shutting down can hold a file; it's a temp dir.
    }
  },
};
