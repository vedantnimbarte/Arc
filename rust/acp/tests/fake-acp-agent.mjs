#!/usr/bin/env node
// A fake coding agent that speaks the Agent Client Protocol (ACP) over stdio,
// for testing ARC's ACP client without any real agent or subscription.
//
// Used by rust/acp/tests/fake_agent.rs and by the e2e suite (which offers it
// to the app as an agent through ARC_TEST_ACP_AGENT). No dependencies.
//
// What a turn does depends on a keyword in the prompt (first match wins):
//   crash       exit mid-turn
//   fail        answer the prompt with a JSON-RPC error
//   slow        stream a chunk every 100 ms until cancelled (or 100 chunks)
//   permission  run a tool that needs approval; reply "allowed" / "denied"
//   edit        run an edit tool on <cwd>/fake.txt
//   mcp         reply with the MCP servers the session was given, as JSON
//   config      reply with the session's current model and mode
//   (anything)  reply "echo: <prompt>" in two chunks
//
// Sessions persist (for session/list and session/load) in FAKE_ACP_STATE, or
// <cwd>/.fake-acp-sessions.json when that isn't set.

import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const statePath = (cwd) => process.env.FAKE_ACP_STATE || join(cwd, '.fake-acp-sessions.json');

function loadState(cwd) {
  const p = statePath(cwd);
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  } catch {
    return {};
  }
}

function saveSession(s) {
  const all = loadState(s.cwd);
  all[s.id] = { id: s.id, cwd: s.cwd, history: s.history, config: s.config, updatedAt: Date.now() };
  writeFileSync(statePath(s.cwd), JSON.stringify(all));
}

/** Live sessions: id → { id, cwd, history, config, mcpServers, cancelled }. */
const sessions = new Map();
let nextOut = 1000;
const waiting = new Map(); // our request id → resolve

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const reply = (id, result) => send({ id, result });
const replyError = (id, code, message) => send({ id, error: { code, message } });
const update = (sessionId, u) =>
  send({ method: 'session/update', params: { sessionId, update: u } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextOut++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function configOptions(s) {
  const opts = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: s.config.model,
      options: [
        { value: 'fake-small', name: 'Fake Small' },
        { value: 'fake-large', name: 'Fake Large' },
      ],
    },
  ];
  // Like OpenCode: picking a model can add options.
  if (s.config.model === 'fake-large') {
    opts.push({
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: s.config.effort ?? 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    });
  }
  opts.push({
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: s.config.mode,
    options: [
      { value: 'build', name: 'build' },
      { value: 'plan', name: 'plan' },
    ],
  });
  return opts;
}

let messageSeq = 0;
/** One agent message, streamed as `chunks` and remembered whole. */
function say(s, ...chunks) {
  const messageId = `m${++messageSeq}`;
  for (const text of chunks) {
    update(s.id, {
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: { type: 'text', text },
    });
  }
  s.history.push({ role: 'agent', text: chunks.join('') });
}

async function prompt(id, { sessionId, prompt: blocks }) {
  const s = sessions.get(sessionId);
  if (!s) return replyError(id, -32602, `unknown session ${sessionId}`);
  const text = (blocks ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  s.history.push({ role: 'user', text });
  s.cancelled = false;
  const has = (word) => text.toLowerCase().includes(word);

  if (has('crash')) {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'about to crash' },
    });
    process.stderr.write('fake agent crashed on purpose\n');
    process.exit(3);
  }
  if (has('fail')) return replyError(id, -32603, 'fake failure');

  let stopReason = 'end_turn';
  if (has('slow')) {
    for (let i = 0; i < 100 && !s.cancelled; i++) {
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `${i} ` },
      });
      await sleep(100);
    }
    if (s.cancelled) stopReason = 'cancelled';
  } else if (has('permission')) {
    const toolCallId = 'tool-perm';
    const toolCall = {
      toolCallId,
      title: 'rm -rf build',
      kind: 'execute',
      rawInput: { command: 'rm -rf build' },
    };
    update(sessionId, { sessionUpdate: 'tool_call', status: 'pending', ...toolCall });
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'yes-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = answer?.outcome;
    if (outcome?.outcome === 'selected' && outcome.optionId === 'yes') {
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'removed build' } }],
      });
      say(s, 'allowed');
    } else if (outcome?.outcome === 'cancelled') {
      stopReason = 'cancelled';
    } else {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
      say(s, `denied (${outcome?.optionId ?? outcome?.outcome})`);
    }
  } else if (has('edit')) {
    const path = join(s.cwd, 'fake.txt');
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-edit',
      title: 'write',
      kind: 'edit',
      status: 'pending',
      locations: [],
      rawInput: {},
    });
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-edit',
      status: 'completed',
      kind: 'edit',
      locations: [{ path }],
      rawInput: { filePath: path, content: 'hi' },
      content: [{ type: 'content', content: { type: 'text', text: 'Wrote file successfully.' } }],
    });
    say(s, 'edited fake.txt');
  } else if (has('mcp')) {
    say(s, JSON.stringify(s.mcpServers ?? []));
  } else if (has('config')) {
    say(s, `model=${s.config.model} mode=${s.config.mode}`);
  } else {
    update(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking' },
    });
    say(s, 'echo: ', text);
  }

  // Running session total, like OpenCode reports it.
  s.cost = (s.cost ?? 0) + 0.01;
  update(sessionId, {
    sessionUpdate: 'usage_update',
    used: 100,
    size: 1000,
    cost: { amount: s.cost, currency: 'USD' },
  });
  saveSession(s);
  reply(id, { stopReason, usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3 } });
}

function handle(msg) {
  // A response to one of our requests (session/request_permission).
  if (msg.id !== undefined && msg.method === undefined) {
    waiting.get(msg.id)?.(msg.result ?? null);
    waiting.delete(msg.id);
    return;
  }
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          mcpCapabilities: { http: true },
          sessionCapabilities: { list: {} },
        },
        authMethods: [],
        agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
      });
    case 'session/new': {
      const s = {
        id: `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        cwd: params.cwd,
        history: [],
        config: { model: 'fake-small', mode: 'build' },
        mcpServers: params.mcpServers,
      };
      sessions.set(s.id, s);
      saveSession(s);
      return reply(id, { sessionId: s.id, configOptions: configOptions(s) });
    }
    case 'session/load': {
      const saved = loadState(params.cwd)[params.sessionId];
      if (!saved) return replyError(id, -32602, `no session ${params.sessionId}`);
      const s = { ...saved, mcpServers: params.mcpServers };
      sessions.set(s.id, s);
      for (const [i, h] of s.history.entries()) {
        update(s.id, {
          sessionUpdate: h.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          messageId: `h${i}`,
          content: { type: 'text', text: h.text },
        });
      }
      return reply(id, { configOptions: configOptions(s) });
    }
    case 'session/list':
      return reply(id, {
        sessions: Object.values(loadState(params.cwd ?? process.cwd()))
          .filter((s) => !params.cwd || s.cwd === params.cwd)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((s) => ({
            sessionId: s.id,
            cwd: s.cwd,
            title: s.history.find((h) => h.role === 'user')?.text ?? null,
            updatedAt: new Date(s.updatedAt).toISOString(),
          })),
      });
    case 'session/set_config_option': {
      const s = sessions.get(params.sessionId);
      if (!s) return replyError(id, -32602, `unknown session ${params.sessionId}`);
      const option = configOptions(s).find((o) => o.id === params.configId);
      if (!option || !option.options.some((o) => o.value === params.value)) {
        return replyError(id, -32602, `no ${params.configId}=${params.value}`);
      }
      s.config[params.configId] = params.value;
      saveSession(s);
      return reply(id, { configOptions: configOptions(s) });
    }
    case 'session/prompt':
      return void prompt(id, params);
    case 'session/cancel': {
      const s = sessions.get(params.sessionId);
      if (s) s.cancelled = true;
      return;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `fake agent has no ${method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (e) {
    process.stderr.write(`fake agent: bad line ${line}: ${e}\n`);
  }
});
process.stdin.on('end', () => process.exit(0));
