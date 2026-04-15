# Building a Remote MCP Server on Cloudflare (Without Auth)

This example allows you to deploy a remote MCP server that doesn't require authentication on Cloudflare Workers.

## Get started:

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless)

This will deploy your MCP server to a URL like: `remote-mcp-server-authless.<your-account>.workers.dev/mcp`

Alternatively, you can use the command line below to get the remote MCP Server created on your local machine:

```bash
npm create cloudflare@latest -- my-mcp-server --template=cloudflare/ai/demos/remote-mcp-authless
```

## Available Tools

This MCP server provides the following tools to interact with QIIME 2 schema versions, distributions, plugins, actions, and semantic types:

- **`compare_versions`**: Compares two schema versions and returns added, removed, or changed actions.
  - `to_version` (required, string)
  - `from_version` (optional, string)
- **`find_compatible_actions`**: Finds actions that accept a specific semantic type.
  - `semantic_type` (required, string)
  - `version` (optional, string)
  - `plugin` (optional, string)
  - `distribution` (optional, string)
- **`find_consumers`**: Finds actions consuming specified artifact types.
  - `types` (required, array)
  - `match_mode` (optional, enum)
  - `version` (optional, string)
  - `plugin` (optional, string)
  - `distribution` (optional, string)
- **`find_input_type_candidates`**: Maps a free-text description of an input kind to likely semantic types and actions.
  - `kind` (required, string)
  - `limit` (optional, integer)
  - `version` (optional, string)
  - `plugin` (optional, string)
  - `distribution` (optional, string)
- **`find_producers`**: Finds actions that produce specified artifact types.
  - `types` (required, array)
  - `version` (optional, string)
  - `plugin` (optional, string)
  - `distribution` (optional, string)
- **`get_action_details`**: Retrieves details, inputs, outputs, and parameters for an action.
  - `plugin_name` (required, string)
  - `action_name` (required, string)
  - `version` (optional, string)
- **`get_type_details`**: Retrieves description and details for a semantic type.
  - `type_name` (required, string)
  - `version` (optional, string)
- **`list_distributions`**: Lists all available Rachis distributions.
  - `version` (optional, string)
- **`list_plugins`**: Lists all available Rachis plugins.
  - `distribution` (optional, string)
  - `version` (optional, string)
- **`list_schema_versions`**: Lists available versions and identifies the latest.
  - No parameters.
- **`list_semantic_types`**: Lists all known semantic types.
  - `distribution` (optional, string)
  - `version` (optional, string)

## Connect to Cloudflare AI Playground

You can connect to your MCP server from the Cloudflare AI Playground, which is a remote MCP client:

1. Go to https://playground.ai.cloudflare.com/
2. Enter your deployed MCP server URL (`remote-mcp-server-authless.<your-account>.workers.dev/mcp`)
3. You can now use your MCP tools directly from the playground!

This server exposes MCP at `/mcp` and is intended for Streamable HTTP-compatible MCP clients.

## Connect Claude Desktop to your MCP server

You can also connect to your remote MCP server from local MCP clients, by using the [mcp-remote proxy](https://www.npmjs.com/package/mcp-remote).

To connect to your MCP server from Claude Desktop, follow [Anthropic's Quickstart](https://modelcontextprotocol.io/quickstart/user) and within Claude Desktop go to Settings > Developer > Edit Config.

Update with this configuration:

```json
{
	"mcpServers": {
		"calculator": {
			"command": "npx",
			"args": [
				"mcp-remote",
				"http://localhost:8787/mcp" // or remote-mcp-server-authless.your-account.workers.dev/mcp
			]
		}
	}
}
```

Restart Claude and you should see the tools become available.
