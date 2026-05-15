// Agents package — TS-side agent definitions, tool schemas, UI controllers.
// The Rust runtime lives in rust/agent-runtime.

export interface AgentDescriptor {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
}

export const builtInAgents: AgentDescriptor[] = [
  {
    id: 'coder',
    name: 'Coding agent',
    description: 'Edits files in the current workspace.',
    systemPrompt: 'You are a careful coding assistant operating in ARC.',
    tools: ['fs.read', 'fs.write', 'shell.run', 'git.diff'],
  },
];
