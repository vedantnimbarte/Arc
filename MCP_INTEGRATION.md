# MCP Integration Guide — ARC

**Model Context Protocol (MCP)** is a standard for connecting AI applications to external tools and data sources. This guide explains how to build and integrate MCP servers with ARC.

**Quick links:**
- [What is MCP?](#what-is-mcp)
- [Connecting a Server](#connecting-an-mcp-server)
- [Building a Custom Server](#building-a-custom-mcp-server)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)

For conceptual background, see [AGENTS.md](AGENTS.md).

---

## What is MCP?

**MCP** is a JSON-RPC protocol that lets you define **tools** (callable functions) and **resources** (accessible data) that an AI agent can use.

### Key Concepts

- **Server** — An MCP server exposes tools and resources
- **Tool** — A function the agent can call (e.g., `web_search`, `read_database`)
- **Resource** — Data the agent can read (e.g., a text file, a database record)
- **Transport** — How the server communicates: stdio (stdin/stdout) or HTTP/SSE

### Why Use MCP?

MCP lets you:
1. Give agents access to **custom tools** without modifying ARC
2. Connect to **third-party APIs** (web search, weather, databases, Slack, etc.)
3. **Reuse tools** across projects and applications
4. Keep tools **decoupled** from the agent runtime

---

## Connecting an MCP Server

### Via Chat Command

In the ARC chat panel, use `/mcp connect`:

#### Stdio Transport (Local Process)

```
/mcp connect my-server npx @myorg/my-mcp-server
```

**Format:** `/mcp connect <server-id> <command> [args...]`

- `<server-id>` — Unique identifier (e.g., "my-server", "web-search")
- `<command>` — Executable (npx, python, node, etc.)
- `[args...]` — Arguments (e.g., `--api-key sk-...`)

**Examples:**

```
/mcp connect web-search npx @anthropic/mcp-server-web-search
/mcp connect postgres npx @mcp/mcp-server-postgres --url postgresql://localhost/mydb
/mcp connect filesystem npx @anthropic/mcp-server-filesystem --root /home/user/workspace
```

#### HTTP Transport (Remote Server)

```
/mcp connect remote-server http://api.example.com/mcp
```

**Format:** `/mcp connect <server-id> <url> [headers]`

- `<server-id>` — Unique identifier
- `<url>` — HTTP endpoint (e.g., `http://localhost:3000/mcp`)
- `[headers]` (optional) — JSON object with custom headers

**Examples:**

```
/mcp connect anthropic http://localhost:3000/mcp
/mcp connect gated-api https://api.example.com/mcp {"Authorization": "Bearer token123"}
```

### Listing Connected Servers

```
/mcp list
```

Shows all connected servers and their available tools.

### Calling a Tool

The agent automatically discovers and calls tools from connected servers. For example:

```
/agent search for recent Claude announcements

🤖 Agent uses: web_search("Claude announcements 2024")
```

Or call a tool directly in chat:

```
/mcp call web-search search("Claude 3.5 Sonnet release notes")
```

### Disconnecting

```
/mcp disconnect web-search
```

---

## Building a Custom MCP Server

### Architecture

An MCP server:
1. Listens on stdio (or HTTP)
2. Receives JSON-RPC requests
3. Returns tool definitions and results

### Node.js Example

Here's a minimal MCP server that exposes a `greet` tool:

**`server.js`:**

```javascript
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio");
const {
  Server,
  Tool,
  CallToolRequest,
} = require("@modelcontextprotocol/sdk/types");

const server = new Server({
  name: "greeting-server",
  version: "1.0.0",
});

// Define tools
server.setRequestHandler(CallToolRequest, async (request) => {
  if (request.params.name === "greet") {
    const name = request.params.arguments.name || "World";
    return {
      content: [
        {
          type: "text",
          text: `Hello, ${name}!`,
        },
      ],
    };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

// List available tools
server.setRequestHandler(ToolListRequest, () => ({
  tools: [
    {
      name: "greet",
      description: "Greet someone by name",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Person to greet",
          },
        },
      },
    },
  ],
}));

// Start server
const transport = new StdioServerTransport();
server.connect(transport);
```

**`package.json`:**

```json
{
  "name": "greeting-mcp-server",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.4.0"
  },
  "scripts": {
    "start": "node server.js"
  }
}
```

**Install & test:**

```bash
npm install
npm start    # Starts listening on stdin/stdout
```

**Connect in ARC:**

```
/mcp connect greetings node /path/to/server.js
```

### Python Example

Using the Anthropic MCP SDK for Python:

**`server.py`:**

```python
import json
import sys
from typing import Any

class GreetingServer:
    def __init__(self):
        self.tools = {
            "greet": {
                "description": "Greet someone by name",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Person to greet",
                        }
                    },
                },
            }
        }

    def handle_request(self, request: dict) -> dict:
        method = request.get("method")

        if method == "tools/list":
            return {"tools": [{"name": k, **v} for k, v in self.tools.items()]}

        elif method == "tools/call":
            tool_name = request["params"]["name"]
            if tool_name == "greet":
                name = request["params"]["arguments"].get("name", "World")
                return {
                    "content": [{"type": "text", "text": f"Hello, {name}!"}]
                }

        return {"error": "Unknown method"}

    def run(self):
        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                request = json.loads(line)
                response = self.handle_request(request)
                print(json.dumps(response))
                sys.stdout.flush()
            except Exception as e:
                print(json.dumps({"error": str(e)}))
                sys.stdout.flush()

if __name__ == "__main__":
    server = GreetingServer()
    server.run()
```

**Run:**

```bash
python server.py
```

---

## Tool Schema Best Practices

Define tools with clear, descriptive schemas so agents use them correctly.

### Good Schema

```json
{
  "name": "web_search",
  "description": "Search the web for information. Returns top 10 results.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query (e.g., 'Claude 3.5 Sonnet release date')"
      },
      "max_results": {
        "type": "integer",
        "description": "Max results to return (1–10, default 5)",
        "minimum": 1,
        "maximum": 10
      }
    },
    "required": ["query"]
  }
}
```

### Bad Schema

```json
{
  "name": "search",
  "description": "Searches stuff",
  "inputSchema": {}  // No properties defined!
}
```

### Tips

- **Descriptions matter:** Agents read them to decide when and how to call tools
- **Explicit types:** Use `string`, `integer`, `boolean`, `array`, `object`, not just `any`
- **Defaults:** Provide sensible defaults for optional parameters
- **Examples:** In descriptions, show example usage:
  ```
  "description": "Search the web. Example: search('Claude news')"
  ```
- **Constraints:** Use `minimum`, `maximum`, `enum` to limit valid inputs

---

## Examples

### Example 1: Web Search Server

A tool for searching the web (using a public API):

**Concept:**
- Exposes `web_search(query, max_results)`
- Hits a search API (e.g., SerpAPI)
- Returns titles, URLs, snippets

**Server code** (Node.js):

```javascript
const axios = require('axios');

server.setRequestHandler(CallToolRequest, async (request) => {
  if (request.params.name === "web_search") {
    const { query, max_results = 5 } = request.params.arguments;
    
    const response = await axios.get('https://api.serpapi.com/search', {
      params: {
        q: query,
        api_key: process.env.SERPAPI_KEY,
        num: max_results,
      },
    });

    const results = response.data.organic_results.map(r => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify(results, null, 2),
      }],
    };
  }
});
```

**Usage in ARC:**

```
/mcp connect web-search npx my-web-search-server
/agent search for recent Claude features and summarize
```

### Example 2: Local Database Server

A tool for querying a PostgreSQL database:

**Server code** (Node.js with pg):

```javascript
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

server.setRequestHandler(CallToolRequest, async (request) => {
  if (request.params.name === "query") {
    const { sql } = request.params.arguments;
    
    try {
      const result = await pool.query(sql);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.rows, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
});
```

**Usage in ARC:**

```
/mcp connect db NODE_ENV=production npx my-db-server
/agent get the top 10 customers by revenue
```

### Example 3: File Operations (Custom)

A tool for reading/writing files outside the workspace root:

**Tool:**
- `read_secure_file(path)` — Read files in /etc or other restricted dirs
- `write_log(message)` — Append to a log file

**Server code:**

```javascript
server.setRequestHandler(CallToolRequest, async (request) => {
  if (request.params.name === "read_secure_file") {
    const fs = require('fs');
    const path = request.params.arguments.path;

    // Whitelist allowed paths
    const allowed = ['/etc/hosts', '/var/log/app.log'];
    if (!allowed.includes(path)) {
      throw new Error(`Access denied: ${path}`);
    }

    const content = fs.readFileSync(path, 'utf8');
    return {
      content: [{ type: "text", text: content }],
    };
  }
});
```

---

## HTTP Transport Setup

If your MCP server uses HTTP/SSE instead of stdio:

### Server Requirements

The server must:
1. Listen on HTTP (e.g., `:3000`)
2. Expose an endpoint (e.g., `/mcp`)
3. Support SSE (Server-Sent Events) for streaming responses
4. Accept POST requests for tool calls

### Example: Express Server

```javascript
const express = require('express');
const app = express();

app.use(express.json());

// MCP endpoint
app.post('/mcp', (req, res) => {
  const { jsonrpc, method, params } = req.body;

  if (method === 'tools/list') {
    res.json({
      jsonrpc,
      result: { tools: [...] },
    });
  } else if (method === 'tools/call') {
    // Handle tool call
    res.json({
      jsonrpc,
      result: { content: [...] },
    });
  }
});

app.listen(3000, () => console.log('MCP server on :3000'));
```

### Connecting in ARC

```
/mcp connect my-server http://localhost:3000/mcp
```

---

## Tool Limitations in ARC

When tools are integrated into the agent:

| Limit | Value |
|-------|-------|
| Max tools per run | 32 |
| Max tool calls per run | Unlimited (respects 30s timeout) |
| Max output per call | 16 KiB |
| Max input per call | 1 MiB |
| Timeout | 30 seconds |

If a tool returns more than 16 KiB, it's truncated. If a tool call exceeds 30 seconds, it times out.

### Optimizing Tools

- **Return essential data only:** Don't return every field; summarize
- **Paginate:** Use `offset`/`limit` parameters for large result sets
- **Cache:** If a tool is expensive, consider caching results
- **Examples:**

```javascript
// ❌ Bad: Returns all columns for 1000 users
SELECT * FROM users LIMIT 1000

// ✅ Good: Returns only needed columns, paginated
SELECT id, name, email FROM users LIMIT 10 OFFSET 0
```

---

## Security Considerations

### API Key Management

If your MCP server needs credentials:

1. **Pass as environment variables:**
   ```bash
   /mcp connect web-search SERPAPI_KEY=sk-... node server.js
   ```

2. **Or read from ARC's credential vault:**
   ```javascript
   const key = await secretsGetApiKey('serpapi');
   ```

3. **Never hardcode credentials in the server.**

### Input Validation

Always validate tool inputs to prevent abuse:

```javascript
server.setRequestHandler(CallToolRequest, async (request) => {
  if (request.params.name === "delete_file") {
    const path = request.params.arguments.path;

    // Whitelist allowed paths
    if (!path.startsWith('/safe/directory/')) {
      throw new Error(`Access denied: ${path}`);
    }

    // Continue...
  }
});
```

### Resource Limits

Prevent agents from running expensive queries:

```javascript
if (request.params.name === "database_query") {
  const sql = request.params.arguments.sql;

  // Reject LIMIT > 1000
  if (sql.includes('LIMIT') && parseInt(sql.match(/LIMIT (\d+)/)[1]) > 1000) {
    throw new Error('Max results: 1000');
  }

  // Continue...
}
```

---

## Troubleshooting

### "Server not found" or Connection Failed

**Cause:** Server process crashed or path is wrong.

**Fix:**
1. Test the server locally:
   ```bash
   npx my-server  # Should start without errors
   ```
2. Check command is correct:
   ```
   /mcp connect my-server npx my-server
   ```
3. Verify npm package exists:
   ```bash
   npm info my-server
   ```

### "Tool not found" or Tools List is Empty

**Cause:** Server doesn't define tools, or doesn't respond to `tools/list`.

**Fix:**
1. Test the server's `tools/list` response:
   ```javascript
   console.log(server.tools); // Should be non-empty
   ```
2. Ensure tools are in the response:
   ```javascript
   server.setRequestHandler(ToolListRequest, () => ({
     tools: [ /* your tools */ ],
   }));
   ```

### Tool Calls Timeout

**Cause:** Tool is slow or hanging.

**Fix:**
1. Add a timeout to your tool:
   ```javascript
   const result = await Promise.race([
     expensiveOperation(),
     new Promise((_, reject) =>
       setTimeout(() => reject(new Error('Timeout')), 25000)
     ),
   ]);
   ```
2. Or optimize the tool to return faster

### HTTP Server Connection Refused

**Cause:** Server isn't listening on the expected port/URL.

**Fix:**
1. Test the endpoint:
   ```bash
   curl http://localhost:3000/mcp
   ```
2. Verify the URL in ARC:
   ```
   /mcp connect my-server http://localhost:3000/mcp
   ```

### "Permission Denied" Errors

**Cause:** Agent doesn't have permissions to call the tool (e.g., `fs_write_file` needs approval).

**Fix:**
- Look for the approval prompt in ARC and click **Approve**
- Or design your MCP tool to be read-only (no approval needed)

---

## Public MCP Servers

Popular open-source MCP servers ready to use:

| Server | Purpose | Install |
|--------|---------|---------|
| **web-search** | Search the web | `npx @anthropic/mcp-server-web-search` |
| **filesystem** | Read/write files | `npx @anthropic/mcp-server-filesystem` |
| **postgres** | Query PostgreSQL | `npx @mcp/mcp-server-postgres` |
| **slack** | Slack workspace access | `npx @mcp/mcp-server-slack` |
| **stripe** | Stripe API access | `npx @mcp/mcp-server-stripe` |
| **memory** | External memory notes | `npx @mcp/mcp-server-memory` |

Browse more at [MCP Registry](https://modelcontextprotocol.io/registry).

---

## See Also

- [AGENTS.md](AGENTS.md) — How agents use tools
- [API_REFERENCE.md](API_REFERENCE.md) — MCP commands (`mcp_connect`, `mcp_call_tool`, etc.)
- [Official MCP Docs](https://modelcontextprotocol.io/)
- [Anthropic MCP SDK](https://github.com/anthropics/anthropic-sdk-python/tree/main/src/anthropic/mcp)
