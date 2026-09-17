// One app lifecycle, in order: launch, type into a terminal, quit and relaunch
// on the same data dir (the 0.10 "restored tabs take no input" bug), then open
// the heavier surfaces and check none of them crash.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ENTER = '';
const CRASH_TEXT = ['ARC hit an error', 'this tab crashed'];

const hydrated = () =>
  browser.waitUntil(
    () => browser.execute(() => window.__arcTest?.useWorkspace.getState().hydrated === true),
    { timeout: 60_000, timeoutMsg: 'workspace never hydrated (is the e2e hook built in?)' },
  );

const terminalIds = () =>
  browser.execute(() =>
    window.__arcTest.useWorkspace
      .getState()
      .tabs.filter((t) => t.kind === 'terminal')
      .map((t) => t.id),
  );

const terminalText = (id) =>
  browser.execute((id) => window.__arcTest.getTerminal(id)?.text() ?? '', id);

async function assertNoCrash() {
  const body = await $('body').getText();
  for (const text of CRASH_TEXT) assert.ok(!body.includes(text), `error boundary shown: ${body}`);
}

/** Type `echo <marker>` into terminal `id` with real key events and wait for
 *  the shell's output line (the echoed command line itself doesn't count). */
async function echoRoundTrip(id) {
  const marker = `arc-e2e-${Math.random().toString(36).slice(2, 10)}`;
  await browser.execute((id) => window.__arcTest.useWorkspace.getState().setActive(id), id);
  // The shell has printed its prompt, so it is reading input.
  await browser.waitUntil(async () => (await terminalText(id)).trim().length > 0, {
    timeout: 60_000,
    timeoutMsg: `terminal ${id} never printed a prompt`,
  });
  await browser.execute((id) => window.__arcTest.getTerminal(id).focus(), id);
  await browser.keys(`echo ${marker}`);
  await browser.keys(ENTER);
  await browser
    .waitUntil(
      async () => (await terminalText(id)).split('\n').some((line) => line.trim() === marker),
      { timeout: 60_000 },
    )
    .catch(async () => {
      throw new Error(`"${marker}" never appeared in terminal ${id}:\n${await terminalText(id)}`);
    });
}

describe('ARC smoke', () => {
  let tabs;

  it('launches with a terminal tab', async () => {
    await hydrated();
    await assertNoCrash();
    if ((await terminalIds()).length === 0) {
      await browser.keys(['Control', 't']);
      await browser.waitUntil(async () => (await terminalIds()).length > 0, {
        timeoutMsg: 'Ctrl+T opened no terminal',
      });
    }
    const [id] = await terminalIds();
    await $(`[data-session="${id}"] .xterm`).waitForExist({ timeout: 60_000 });
  });

  it('echoes typed input in the terminal', async () => {
    const [id] = await terminalIds();
    await echoRoundTrip(id);
  });

  it('restores two terminal tabs after a relaunch and they take input', async () => {
    while ((await terminalIds()).length < 2) {
      const before = (await terminalIds()).length;
      await browser.execute(() => window.__arcTest.useWorkspace.getState().newTerminal());
      await browser.waitUntil(async () => (await terminalIds()).length > before);
    }
    tabs = await terminalIds();

    // Tabs persist on a debounce; quit only once SQLite has them.
    await browser.waitUntil(
      async () => {
        const saved = await browser.execute(async () =>
          (await window.__arcTest.sessionLoad()).tabs.map((t) => t.id),
        );
        return tabs.every((id) => saved.includes(id));
      },
      { timeoutMsg: 'tabs were never saved' },
    );

    // Quit through the window's own close button, then start a new session:
    // tauri-driver launches a fresh process on the same ARC_DATA_DIR.
    const startedAt = await browser.execute(() => performance.timeOrigin);
    // Click from inside the page on a timer rather than with a WebDriver click:
    // the app quits before a WebDriver click can answer, and WebKitWebDriver
    // (Linux) then reports the whole session as crashed. This way the command
    // returns first and the quit happens after.
    await $('button[aria-label="Close window"]').waitForExist();
    await browser.execute(() => {
      setTimeout(() => document.querySelector('button[aria-label="Close window"]').click(), 200);
    });
    // The old session died with the app; deleting it may fail, which is fine.
    await browser.pause(3_000);
    await browser.reloadSession().catch(async () => {
      await browser.reloadSession();
    });
    await hydrated();
    assert.notEqual(await browser.execute(() => performance.timeOrigin), startedAt, 'app did not relaunch');
    await assertNoCrash();

    const restored = await terminalIds();
    for (const id of tabs) assert.ok(restored.includes(id), `tab ${id} not restored: ${restored}`);
    await echoRoundTrip(tabs[1]);
    await echoRoundTrip(tabs[0]);
  });

  it('opens settings, debug, SSH, database and API client without crashing', async () => {
    const logPath = join(process.env.ARC_DATA_DIR, 'frontend.log');
    const readLog = () => {
      try {
        return readFileSync(logPath, 'utf8');
      } catch {
        return '';
      }
    };
    const logBefore = readLog();

    for (const view of ['debug', 'ssh']) {
      await browser.execute((v) => window.__arcTest.useFiles.getState().showSidebarView(v), view);
      const panel = await $('#sidebar-view-panel');
      await browser.waitUntil(async () => (await panel.getText()).trim().length > 0, {
        timeoutMsg: `${view} panel rendered blank`,
      });
      await assertNoCrash();
    }

    for (const open of ['openDbClient', 'openApiClient']) {
      const id = await browser.execute((fn) => window.__arcTest.useWorkspace.getState()[fn](), open);
      const host = await $(`[data-tab-host="${id}"]`);
      await browser.waitUntil(async () => (await host.getText()).trim().length > 0, {
        timeoutMsg: `${open} tab rendered blank`,
      });
      await assertNoCrash();
    }

    // Settings is its own webview window.
    const main = await browser.getWindowHandle();
    await browser.keys(['Control', ',']);
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > 1, {
      timeoutMsg: 'settings window never opened',
    });
    const settings = (await browser.getWindowHandles()).find((h) => h !== main);
    await browser.switchToWindow(settings);
    assert.match(await browser.getUrl(), /view=settings/);
    await browser.waitUntil(async () => (await $('body').getText()).trim().length > 0, {
      timeoutMsg: 'settings window rendered blank',
    });
    await assertNoCrash();
    await browser.switchToWindow(main);

    const newErrors = readLog().slice(logBefore.length).trim();
    assert.equal(newErrors, '', `frontend logged errors:\n${newErrors}`);
  });
});
