# Building a Remote MCP Server on Cloudflare (Without Auth)

This example allows you to deploy a remote MCP server that doesn't require authentication on Cloudflare Workers.

## Get started:

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless)

This will deploy your MCP server to a URL like: `remote-mcp-server-authless.<your-account>.workers.dev/mcp`

Alternatively, you can use the command line below to get the remote MCP Server created on your local machine:

```bash
npm create cloudflare@latest -- my-mcp-server --template=cloudflare/ai/demos/remote-mcp-authless
```

## Customizing your MCP Server

To add your own [tools](https://developers.cloudflare.com/agents/model-context-protocol/tools/) to the MCP server, define each tool inside the `init()` method of `src/index.ts` using `this.server.tool(...)`.

## Input kind discovery

Use `find_input_type_candidates` when the user knows the general kind of artifact they have but not the exact semantic type.

Example:

```json
{
  "kind": "reads",
  "limit": 5
}
```

The tool returns ranked semantic type candidates together with the actions that can consume each candidate type.

## `plan_workflow_multi` recipes

Use `plan_workflow_multi` when you want constraint-aware workflow planning from multiple available artifact types.

The tool returns:

- `steps`: ordered action plan (`action_id`, `plugin`, `action`, `output_type`)
- `achieved_targets`: target types that were satisfied
- `missing_inputs`: target types that could not be satisfied
- `assumptions` and `warnings`
- `available_types`: final inferred type inventory after planned steps

### Assembly-focused planning

```json
{
  "available_types": [
    "SampleData[PairedEndSequencesWithQuality]"
  ],
  "target_types": [
    "SampleData[Contigs]"
  ],
  "allowed_plugins": [
    "assembly",
    "fastp",
    "cutadapt",
    "demux"
  ],
  "max_depth": 6
}
```

### Taxonomic profiling-focused planning

```json
{
  "available_types": [
    "FeatureData[Sequence]"
  ],
  "target_types": [
    "FeatureData[Taxonomy]"
  ],
  "allowed_plugins": [
    "feature-classifier",
    "taxa",
    "annotate"
  ],
  "max_depth": 6
}
```

### AMR-focused planning with exclusions

```json
{
  "available_types": [
    "SampleData[Contigs]"
  ],
  "target_types": [
    "FeatureTable[Frequency]"
  ],
  "allowed_plugins": [
    "amrfinderplus",
    "resistance",
    "taxonomy"
  ],
  "required_plugins": [
    "amrfinderplus"
  ],
  "disallowed_plugins": [
    "boots"
  ],
  "disallowed_actions": [
    "dada2:*",
    "deblur:*"
  ],
  "max_depth": 7
}
```

Selector syntax for `disallowed_actions`:

- `plugin:action` to match one action
- `plugin:*` to match all actions in one plugin
- `plugin` to match all actions in one plugin

Tip: start with a broad plan, then tighten with `allowed_plugins`, `required_plugins`, `disallowed_plugins`, or `disallowed_actions` if the workflow is biologically off-target.

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
