// The agent chat against a fake ACP agent (rust/acp/tests/fake-acp-agent.mjs),
// which wdio.conf.js offers to the app through ARC_TEST_ACP_AGENT. Covers what
// real agents need a subscription for: a streamed reply, the agent's settings
// pickers, a permission prompt answered in the UI, stopping a turn, and the
// Sessions view listing the conversation.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const CRASH_TEXT = ['ARC hit an error', 'this tab crashed'];

const hydrated = () =>
  browser.waitUntil(
    () => browser.execute(() => window.__arcTest?.useWorkspace.getState().hydrated === true),
    { timeout: 60_000, timeoutMsg: 'workspace never hydrated (is the e2e hook built in?)' },
  );

const panelText = () => $('#sidebar-view-panel').getText();

const waitForPanel = (pattern, what) =>
  browser
    .waitUntil(async () => pattern.test(await panelText()), {
      timeout: 60_000,
      timeoutMsg: `never saw ${what} in the sidebar:\n`,
    })
    .catch(async (e) => {
      throw new Error(`${e.message}${await panelText()}`);
    });

/** The fake agent's sidebar conversation, read from its store. */
const chat = () =>
  browser.execute(() => {
    const s = window.__arcTest.acpSession('fake-acp').getState();
    return { streaming: s.streaming, pending: !!s.pending, chat: s.chat };
  });

/** One key per action: Linux's WebKitWebDriver merges repeated keys sent
 *  together (see smoke.e2e.js). */
async function typeKeys(text) {
  for (const ch of text) await browser.keys(ch);
}

async function assertNoCrash() {
  const body = await $('body').getText();
  for (const text of CRASH_TEXT) assert.ok(!body.includes(text), `error boundary shown: ${body}`);
}

describe('ACP agent chat', () => {
  before(async () => {
    await hydrated();
    // A folder of its own: the chat works in the file tree's root.
    const work = join(process.env.ARC_DATA_DIR, 'agent-work');
    mkdirSync(work, { recursive: true });
    await browser.execute((dir) => {
      const files = window.__arcTest.useFiles.getState();
      files.setRoot(dir);
      files.setAgentPanelTab('fake-acp');
      files.showSidebarView('agents');
    }, work);
    await browser.waitUntil(
      () =>
        browser.execute(async () => {
          const agents = window.__arcTest.useAcpAgents.getState();
          if (agents.status === 'checking') await agents.detect();
          return agents.providers.some((p) => p.id === 'fake-acp');
        }),
      { timeoutMsg: 'the fake agent was not offered (ARC_TEST_ACP_AGENT, node on PATH?)' },
    );
  });

  it('streams a reply to a typed prompt', async () => {
    const box = await $('textarea[aria-label="Message Fake ACP agent"]');
    await box.waitForEnabled({ timeout: 30_000 });
    await box.click();
    await typeKeys('hi from wdio');
    await browser.keys('Enter');
    await waitForPanel(/echo: hi from wdio/, 'the streamed reply');
    await browser.waitUntil(async () => !(await chat()).streaming, {
      timeoutMsg: 'turn never ended',
    });
    await assertNoCrash();
  });

  it("shows the agent's own settings as pickers", async () => {
    // Found by their labels: a picker's value sits in a truncated span, which
    // WebKitWebDriver's getText leaves out.
    const panel = await $('#sidebar-view-panel');
    await panel.$('button[aria-label="Model"]').waitForDisplayed({ timeout: 30_000 });
    assert.ok(await panel.$('button[aria-label="Mode"]').isDisplayed(), 'no mode picker');
    const model = await browser.execute(
      () =>
        window.__arcTest
          .acpSession('fake-acp')
          .getState()
          .config?.find((o) => o.id === 'model')?.currentValue,
    );
    assert.equal(model, 'fake-small');
  });

  it('pauses on a permission prompt until it is answered', async () => {
    await browser.execute(() => {
      void window.__arcTest.acpSession('fake-acp').getState().send('permission please');
    });
    const prompt = await $('[aria-label="Permission request"]');
    await prompt.waitForDisplayed({ timeout: 30_000 });
    assert.match(await prompt.getText(), /rm -rf build/);
    await prompt.$('button=Allow').click();
    await browser.waitUntil(
      async () => (await chat()).chat.some((c) => c.kind === 'assistant' && c.text === 'allowed'),
      { timeoutMsg: 'the agent never got the approval' },
    );
  });

  it('stops a running turn', async () => {
    await browser.execute(() => {
      void window.__arcTest.acpSession('fake-acp').getState().send('go slow');
    });
    await browser.waitUntil(async () => (await chat()).streaming, {
      timeoutMsg: 'turn never started',
    });
    await $('button[aria-label="Stop this turn"]').click();
    await browser.waitUntil(async () => !(await chat()).streaming, {
      timeout: 15_000,
      timeoutMsg: 'Stop did not end the turn',
    });
    const last = (await chat()).chat.at(-1);
    assert.notEqual(last?.kind, 'error', `stopping showed an error: ${JSON.stringify(last)}`);
  });

  it('lists the conversation in the Sessions view', async () => {
    await browser.execute(() => window.__arcTest.useFiles.getState().showSidebarView('sessions'));
    await waitForPanel(/Fake ACP agent/, 'the conversation');
    // The title is read from the store: in a narrow sidebar the truncated
    // text may not count as visible to WebDriver.
    const snap = await browser.execute(
      () => window.__arcTest.useChatSessions.getState().snaps['panel:fake-acp'],
    );
    assert.equal(snap?.title, 'hi from wdio');
    assert.equal(snap?.status, 'done');
    await assertNoCrash();
  });
});
