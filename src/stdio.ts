#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerRachisTools } from "./tool-registry.js";

async function main() {
	const server = new McpServer({ name: "Rachis MCP", version: "1.0.0" });
	registerRachisTools(server);
	await server.connect(new StdioServerTransport());
}

main().catch((error) => {
	console.error("Fatal error running MCP server:", error);
	process.exit(1);
});
