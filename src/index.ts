
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { KnowledgeGraph } from "./graph.js";
import { registerRachisTools } from "./tool-registry.js";
import schema from "./schema.json";

// Typed Schema Import
// In a real build, we might need to assert the type or load it differently
const graph = new KnowledgeGraph(schema as any);

export class RachisMCP extends McpAgent {
    server = new McpServer({
        name: "Rachis MCP",
        version: "1.0.0",
    });

    async init() {
        registerRachisTools(this.server, graph);
    }
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return RachisMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
