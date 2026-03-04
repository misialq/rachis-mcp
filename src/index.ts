
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { registerRachisTools } from "./tool-registry.js";

export class RachisMCP extends McpAgent {
    server = new McpServer({
        name: "Rachis MCP",
        version: "1.0.0",
    });

    async init() {
        registerRachisTools(this.server);
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
