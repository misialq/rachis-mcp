
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { KnowledgeGraph } from "./graph.js";
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
        // Tool: List all available plugins
        this.server.tool(
            "list_available_plugins",
            { distribution: z.string().optional().describe("Optional distribution name to filter plugins") },
            async ({ distribution }) => {
                try {
                    const plugins = graph.getPlugins(distribution);
                    return {
                        content: [{ type: "text", text: JSON.stringify(plugins, null, 2) }]
                    };
                } catch (e: any) {
                     return {
                        content: [{ type: "text", text: JSON.stringify({ error: e.message }) }]
                    };
                }
            }
        );

        // Tool: List available distributions
        this.server.tool(
            "list_distributions",
            {},
            async () => {
                const distributions = graph.getDistributions();
                return {
                    content: [{ type: "text", text: JSON.stringify(distributions, null, 2) }]
                };
            }
        );

        // Tool: Get details for a specific action
        this.server.tool(
            "get_action_details",
            { 
                plugin_name: z.string().describe("The name of the plugin"),
                action_name: z.string().describe("The name of the action")
            },
            async ({ plugin_name, action_name }) => {
                const action = graph.getAction(plugin_name, action_name);
                
                if (!action) {
                    return { content: [{ type: "text", text: JSON.stringify({ error: `Action '${plugin_name}:${action_name}' not found.` }) }] };
                }

                return { content: [{ type: "text", text: JSON.stringify(action, null, 2) }] };
            }
        );

        // Tool: Find compatible actions (Inputs)
        this.server.tool(
            "find_compatible_actions",
            { semantic_type: z.string() },
            async ({ semantic_type }) => {
                const compatible: string[] = [];
                const allActions = graph.getAllActions();
                
                for (const { plugin, action, details } of allActions) {
                     if (!details.inputs) continue;
                     for (const input of Object.values(details.inputs)) {
                         // input.type is string[]
                         const types = (input as any).type as string[];
                         if (!types) continue;
                         
                         for (const t of types) {
                             if (graph.checkCompatibility(semantic_type, t)) {
                                 compatible.push(`${plugin}:${action}`);
                                 break; 
                             }
                         }
                     }
                }
                return { content: [{ type: "text", text: JSON.stringify(compatible, null, 2) }] };
            }
        );

        // Tool: Find consumers for a set of artifacts
        this.server.tool(
            "find_consumers",
            { types: z.array(z.string()).describe("List of artifact types to be consumed") },
            async ({ types }) => {
                const consumers = graph.findConsumers(types);
                const consumerStrings = consumers.map(c => `${c.plugin}:${c.action}`);
                return { content: [{ type: "text", text: JSON.stringify(consumerStrings, null, 2) }] };
            }
        );

        // Tool: Find producers for a set of artifacts
        this.server.tool(
            "find_producers",
            { types: z.array(z.string()).describe("List of artifact types to be produced") },
            async ({ types }) => {
                const producers = graph.findProducers(types);
                const producerStrings = producers.map(p => `${p.plugin}:${p.action}`);
                return { content: [{ type: "text", text: JSON.stringify(producerStrings, null, 2) }] };
            }
        );
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
