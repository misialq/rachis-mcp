# Rachis MCP

An MCP server for exploring the Rachis ecosystem — browse distributions, plugins, semantic types, and actions, trace type compatibility, and diff release versions.

## Usage

### Option 1: Cloudflare Deployment (Hosted)

Add to your MCP client config (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "rachis": {
      "url": "https://rachis-mcp.ziemski.dev/mcp"
    }
  }
}
```

### Option 2: Local Stdio Execution

You can run Rachis MCP locally over stdio. 

#### Via `npx` (No installation needed)

Add to your MCP client config:

```json
{
  "mcpServers": {
    "rachis": {
      "command": "npx",
      "args": ["-y", "rachis-mcp"]
    }
  }
}
```

#### Running/Building from Source

1. Clone and build the project:
   ```bash
   npm install
   npm run build:local
   ```
2. Configure your client to use the built local server:
   ```json
   {
     "mcpServers": {
       "rachis": {
         "command": "node",
         "args": ["/Users/michal/Repos/rachis-mcp/dist/src/stdio.js"]
       }
     }
   }
   ```

## Development

```bash
npm install
npm run dev          # local dev server (wrangler)
npm run build:local  # build local stdio binary
npm run start:local  # run local stdio server directly
npm test             # run tests
npm run deploy       # deploy to Cloudflare Workers
```

## Available Tools

This MCP server provides the following tools to interact with Rachis release versions, distributions, plugins, actions, and semantic types:

- **`compare_versions`**: Compares two schema (release) versions and returns added, removed, or changed actions.
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
- **`list_actions`**: Lists all actions available in a specified distribution.
  - `distribution` (required, string)
  - `plugin` (optional, string)
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
